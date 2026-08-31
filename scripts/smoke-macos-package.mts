import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const startupTimeoutMs = 180_000

export function resolveMacApplicationExecutable(applicationBundle: string, executableName = 'DSH Codex Desktop'): string {
  return join(applicationBundle, 'Contents', 'MacOS', executableName)
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('macOS 冒烟脚本只能在 macOS 上执行。')
  const applicationBundle = resolve(readArgument('--application-path'))
  const applicationExecutable = resolveMacApplicationExecutable(applicationBundle)
  if (!existsSync(applicationExecutable)) throw new Error(`未找到 macOS 应用可执行文件：${applicationExecutable}`)

  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-mac-smoke-'))
  const userDataDir = join(tempRoot, 'user-data')
  if (process.argv.includes('--browser-enabled')) {
    await mkdir(userDataDir, { recursive: true })
    await writeFile(join(userDataDir, 'browser-automation.json'), '{\n  "enabled": true,\n  "schemaVersion": 1\n}\n', 'utf8')
  }
  const application = spawn(applicationExecutable, ['--smoke-test', `--user-data-dir=${userDataDir}`], {
    cwd: tempRoot,
    env: { ...process.env, DSH_HOME: join(tempRoot, 'dsh-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!application.pid) throw new Error('未获取到应用进程 ID。')
  let applicationOutput = ''
  const captureOutput = (chunk: Buffer): void => {
    applicationOutput = (applicationOutput + chunk.toString('utf8')).slice(-4_096)
  }
  application.stdout?.on('data', captureOutput)
  application.stderr?.on('data', captureOutput)
  let bootstrapProcessId: number | undefined
  try {
    const baseUrl = await waitForHealthyServer(application, () => applicationOutput)
    bootstrapProcessId = await findBootstrapProcessId(application.pid)
    const page = await fetchHealthy(new URL('/', baseUrl).href)
    if (page.status !== 200) throw new Error(`根页面返回 HTTP ${page.status}。`)
    const content = await page.text()
    const assetPath = /(?:src|href)=["'](?<path>\/[^"']+\.(?:js|css))/.exec(content)?.groups?.path
    if (!assetPath) throw new Error('根页面未找到可验证的前端资源。')
    const asset = await fetchHealthy(new URL(assetPath, baseUrl).href)
    if (asset.status !== 200) throw new Error(`前端资源返回 HTTP ${asset.status}。`)
    await waitForControlledExit(application)
    console.log(`SMOKE_OK application=${applicationBundle} health=${baseUrl} controlledExit=true`)
  } finally {
    await stopApplication(application)
    await rm(tempRoot, { recursive: true, force: true })
    if (bootstrapProcessId !== undefined && isProcessRunning(bootstrapProcessId)) {
      throw new Error(`DSH 引导进程 ${bootstrapProcessId} 未在应用退出后结束。`)
    }
  }
}

async function waitForControlledExit(application: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (application.exitCode === null && Date.now() < deadline) await delay(250)
  if (application.exitCode === null) throw new Error('应用未在冒烟模式下受控退出。')
  if (application.exitCode !== 0) throw new Error(`应用受控退出码异常：${application.exitCode}。`)
}

function readArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`缺少参数：${name}`)
  return value
}

async function waitForHealthyServer(application: ChildProcess, getApplicationOutput: () => string): Promise<string> {
  if (!application.pid) throw new Error('未获取到应用进程 ID。')
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(`打包应用提前退出（退出码 ${application.exitCode}）。${getApplicationOutput()}`)
    }
    const announcedUrl = /DSH_SMOKE_READY\s+(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(getApplicationOutput())?.[1]
    if (announcedUrl !== undefined) return announcedUrl
    const bootstrapProcessId = await findBootstrapProcessId(application.pid)
    if (bootstrapProcessId !== undefined) {
      const port = await findListeningPort(bootstrapProcessId)
      if (port !== undefined) return `http://127.0.0.1:${port}`
    }
    await delay(500)
  }
  throw new Error(`打包应用在 ${startupTimeoutMs / 1_000} 秒内未启动本机 HTTP 服务。${getApplicationOutput()}`)
}

async function findBootstrapProcessId(applicationProcessId: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(applicationProcessId)])
    for (const value of stdout.split(/\s+/)) {
      if (!/^\d+$/.test(value)) continue
      const processId = Number(value)
      const { stdout: command } = await execFileAsync('ps', ['-o', 'command=', '-p', String(processId)])
      if (command.includes('bootstrap.mjs')) return processId
    }
  } catch {
    return undefined
  }
  return undefined
}

async function findListeningPort(processId: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(processId), '-iTCP', '-sTCP:LISTEN', '-n', '-P'])
    const port = /127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]
    return port ? Number(port) : undefined
  } catch {
    return undefined
  }
}

async function stopApplication(application: ChildProcess): Promise<void> {
  if (application.exitCode !== null) return
  application.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  while (application.exitCode === null && Date.now() < deadline) await delay(250)
  if (application.exitCode === null) application.kill('SIGKILL')
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function fetchHealthy(url: string): Promise<Response> {
  const deadline = Date.now() + 5_000
  let lastStatus: number | undefined
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      lastStatus = response.status
      if (response.status === 200) return response
      await response.body?.cancel()
    } catch {
      // DSH may announce the bound port just before the HTTP server accepts requests.
    }
    await delay(100)
  }
  throw new Error(`HTTP 健康检查未返回 200（最后状态 ${lastStatus ?? '连接失败'}）：${url}`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main()
