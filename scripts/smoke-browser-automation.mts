import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join, posix, resolve, win32 } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const requestTimeoutMs = 120_000

interface JsonRpcResponse {
  readonly error?: { readonly message?: string }
  readonly id?: number
  readonly result?: unknown
}

export interface BrowserSmokeRuntime {
  readonly mcpEntry: string
  readonly nodeExecutable: string
}

export interface WindowsProcessRecord {
  readonly CommandLine?: string | null
  readonly ExecutablePath?: string | null
  readonly Name?: string | null
  readonly ParentProcessId: number
  readonly ProcessId: number
}

class McpStdioClient {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private id = 0
  private readonly pending = new Map<number, { reject(error: Error): void; resolve(result: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private stderr = ''

  constructor(nodeExecutable: string, args: string[], cwd: string) {
    this.child = spawn(nodeExecutable, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', chunk => this.receive(chunk.toString('utf8')))
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8_000) })
    this.child.once('exit', code => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error(`Playwright MCP 提前退出（${code ?? 'unknown'}）：${this.stderr}`))
      }
      this.pending.clear()
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'dsh-browser-smoke', version: '1.0.0' },
      protocolVersion: '2025-06-18',
    })
    this.notify('notifications/initialized', {})
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { arguments: args, name }).then(result => {
      if ((result as { isError?: unknown }).isError === true) throw new Error(`${name} 失败：${resultText(result)}`)
      return result
    })
  }

  async listTools(): Promise<Array<{ inputSchema?: unknown; name?: string }>> {
    const result = await this.request('tools/list', {}) as { tools?: Array<{ inputSchema?: unknown; name?: string }> }
    return result.tools ?? []
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await Promise.race([
      new Promise<void>(resolveExit => this.child.once('exit', () => resolveExit())),
      new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 3_000)),
    ])
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`MCP 请求超时：${method}。${this.stderr}`))
      }, requestTimeoutMs)
      this.pending.set(id, { reject: rejectRequest, resolve: resolveRequest, timer })
      this.child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`)
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      const message = JSON.parse(line) as JsonRpcResponse
      if (typeof message.id !== 'number') continue
      const request = this.pending.get(message.id)
      if (request === undefined) continue
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error !== undefined) request.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else request.resolve(message.result)
    }
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('系统 Chrome 安装包冒烟当前支持 macOS 和 Windows。')
  }
  const workspace = resolve(readOptionalArgument('--workspace') ?? process.cwd())
  await access(workspace)
  const applicationPath = readOptionalArgument('--application-path')
  const runtime = resolveBrowserSmokeRuntime({ applicationPath, cwd: process.cwd() })
  if (!existsSync(runtime.nodeExecutable) || !existsSync(runtime.mcpEntry)) {
    throw new Error(`浏览器运行时不完整：node=${runtime.nodeExecutable} mcp=${runtime.mcpEntry}`)
  }

  const smokeRoot = await mkdtemp(join(workspace, '.dsh-browser-smoke-'))
  const server = await startFixtureServer()
  const fixtureUrl = `http://127.0.0.1:${addressPort(server)}`
  const clients: McpStdioClient[] = []
  try {
    const firstProfile = join(smokeRoot, 'profiles', 'session-a')
    const firstOutput = join(smokeRoot, 'outputs', 'session-a')
    const uploadPath = join(workspace, `.dsh-browser-upload-${process.pid}.txt`)
    await writeFile(uploadPath, 'workspace-write browser upload proof\n', 'utf8')
    const first = createClient(runtime, workspace, firstProfile, firstOutput)
    clients.push(first)
    await first.initialize()
    const names = new Set((await first.listTools()).map(tool => tool.name))
    for (const required of ['browser_navigate', 'browser_snapshot', 'browser_type', 'browser_click', 'browser_file_upload', 'browser_take_screenshot', 'browser_close']) {
      if (!names.has(required)) throw new Error(`Playwright MCP 缺少工具：${required}`)
    }
    await first.callTool('browser_navigate', { url: fixtureUrl })
    const initial = resultText(await first.callTool('browser_snapshot', {}))
    const inputRef = requiredRef(initial, 'textbox', 'Name')
    const buttonRef = requiredRef(initial, 'button', 'Save')
    await first.callTool('browser_type', { element: 'Name', slowly: false, submit: false, target: inputRef, text: 'DSH Chrome smoke' })
    await first.callTool('browser_click', { element: 'Save', target: buttonRef })
    const saved = resultText(await first.callTool('browser_snapshot', {}))
    if (!saved.includes('Saved: DSH Chrome smoke')) throw new Error(`表单结果不正确：${saved}`)
    const uploadRef = requiredRef(saved, 'button', 'Workspace file')
    await first.callTool('browser_click', { element: 'Workspace file', target: uploadRef })
    await first.callTool('browser_file_upload', { paths: [uploadPath] })
    const uploaded = resultText(await first.callTool('browser_snapshot', {}))
    if (!uploaded.includes(`Uploaded: ${uploadPath.split(/[/\\]/).at(-1)}`)) {
      throw new Error(`工作区文件上传结果不正确：${uploaded}`)
    }
    await first.callTool('browser_take_screenshot', { fullPage: true, type: 'png' })
    const chromeProcessIds = await assertSystemChrome(first.child.pid)
    await first.callTool('browser_close', {})
    await first.close()
    if (process.platform === 'win32') await waitForWindowsProcessesToExit(chromeProcessIds)
    const screenshots = (await readdir(firstOutput)).filter(name => name.endsWith('.png'))
    if (screenshots.length !== 1) throw new Error(`截图没有唯一写入会话输出目录：${screenshots.join(', ')}`)

    const resumed = createClient(runtime, workspace, firstProfile, firstOutput)
    clients.push(resumed)
    await resumed.initialize()
    await resumed.callTool('browser_navigate', { url: fixtureUrl })
    const resumedState = resultText(await resumed.callTool('browser_snapshot', {}))
    if (!resumedState.includes('Saved: DSH Chrome smoke')) throw new Error('同一会话重启后未复用 Chrome 配置。')
    await resumed.callTool('browser_close', {})
    await resumed.close()

    const isolated = createClient(runtime, workspace, join(smokeRoot, 'profiles', 'session-b'), join(smokeRoot, 'outputs', 'session-b'))
    clients.push(isolated)
    await isolated.initialize()
    await isolated.callTool('browser_navigate', { url: fixtureUrl })
    const isolatedState = resultText(await isolated.callTool('browser_snapshot', {}))
    if (!isolatedState.includes('Saved: empty') || isolatedState.includes('DSH Chrome smoke')) {
      throw new Error('不同会话之间泄漏了 Chrome 配置。')
    }
    await isolated.callTool('browser_close', {})
    await isolated.close()

    await writeFile(join(smokeRoot, 'workspace-write-proof.txt'), 'workspace-write browser smoke passed\n', 'utf8')
    console.log(`BROWSER_SMOKE_OK platform=${process.platform} chrome=system profileIsolation=true restartPersistence=true form=true workspaceUpload=true screenshot=true workspaceWrite=true processCleanup=true package=${applicationPath === undefined ? 'source' : resolve(applicationPath)}`)
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => undefined)
    await stopFixtureServer(server)
    await rm(smokeRoot, { recursive: true, force: true })
    const uploadPath = join(workspace, `.dsh-browser-upload-${process.pid}.txt`)
    await rm(uploadPath, { force: true })
  }
}

export function resolveBrowserSmokeRuntime(options: {
  readonly applicationPath?: string
  readonly cwd: string
  readonly platform?: NodeJS.Platform
}): BrowserSmokeRuntime {
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const cwd = path.resolve(options.cwd)
  if (options.applicationPath === undefined) {
    return {
      mcpEntry: path.join(cwd, 'runtime-browser', 'node_modules', '@playwright', 'mcp', 'cli.js'),
      nodeExecutable: path.join(cwd, 'runtime-node', platform === 'win32' ? 'node.exe' : 'node'),
    }
  }
  const applicationPath = path.resolve(cwd, options.applicationPath)
  const resources = platform === 'win32'
    ? path.join(path.dirname(applicationPath), 'resources')
    : path.join(applicationPath, 'Contents', 'Resources')
  return {
    mcpEntry: path.join(resources, 'browser-runtime', 'node_modules', '@playwright', 'mcp', 'cli.js'),
    nodeExecutable: path.join(resources, 'node', platform === 'win32' ? 'node.exe' : 'node'),
  }
}

function createClient(runtime: { mcpEntry: string; nodeExecutable: string }, workspace: string, profileDir: string, outputDir: string): McpStdioClient {
  return new McpStdioClient(runtime.nodeExecutable, [
    runtime.mcpEntry,
    '--browser=chrome',
    `--user-data-dir=${profileDir}`,
    `--output-dir=${outputDir}`,
  ], workspace)
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: unknown; type?: unknown }> }).content ?? []
  return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

function requiredRef(snapshot: string, role: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ref = new RegExp(`${role} "${escapedName}" \\[ref=([^\\]]+)\\]`, 'i').exec(snapshot)?.[1]
  if (ref === undefined) throw new Error(`页面快照中未找到 ${role} ${name}：${snapshot}`)
  return ref
}

async function assertSystemChrome(mcpProcessId: number | undefined): Promise<number[]> {
  if (mcpProcessId === undefined) throw new Error('未获取 Playwright MCP 进程。')
  if (process.platform === 'win32') {
    const records = await windowsProcesses()
    const descendants = windowsDescendantProcesses(records, mcpProcessId)
    const chrome = descendants.filter(isWindowsSystemChromeProcess)
    if (chrome.length === 0) {
      throw new Error(`未发现系统 Google Chrome 子进程：${descendants.map(processDescription).join('\n')}`)
    }
    return chrome.map(record => record.ProcessId)
  }
  const commands = await descendantCommands(mcpProcessId)
  if (!commands.some(command => command.includes('Google Chrome.app/Contents/MacOS/Google Chrome'))) {
    throw new Error(`未发现系统 Google Chrome 子进程：${commands.join('\n')}`)
  }
  return []
}

export function windowsDescendantProcesses(records: readonly WindowsProcessRecord[], parent: number): WindowsProcessRecord[] {
  const descendants: WindowsProcessRecord[] = []
  const queue = [parent]
  const visited = new Set(queue)
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const record of records) {
      if (record.ParentProcessId !== current || visited.has(record.ProcessId)) continue
      visited.add(record.ProcessId)
      queue.push(record.ProcessId)
      descendants.push(record)
    }
  }
  return descendants
}

export function isWindowsSystemChromeProcess(record: WindowsProcessRecord): boolean {
  if (record.Name?.toLowerCase() !== 'chrome.exe') return false
  const executable = record.ExecutablePath ?? record.CommandLine ?? ''
  return /\\Google\\Chrome\\Application\\chrome\.exe(?:$|["\s])/i.test(executable)
}

async function windowsProcesses(): Promise<WindowsProcessRecord[]> {
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress -Depth 3"
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024 })
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as WindowsProcessRecord | WindowsProcessRecord[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function waitForWindowsProcessesToExit(processIds: readonly number[]): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const running = await runningWindowsProcessIds(processIds)
    if (running.length === 0) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  const running = await runningWindowsProcessIds(processIds)
  if (running.length > 0) throw new Error(`关闭 MCP 后 Chrome 子进程未退出：${running.join(', ')}`)
}

async function runningWindowsProcessIds(processIds: readonly number[]): Promise<number[]> {
  if (processIds.length === 0) return []
  const live = new Set((await windowsProcesses()).map(record => record.ProcessId))
  return processIds.filter(processId => live.has(processId))
}

function processDescription(record: WindowsProcessRecord): string {
  return `${record.ProcessId} ${record.ExecutablePath ?? record.CommandLine ?? record.Name ?? '<unknown>'}`
}

async function descendantCommands(parent: number): Promise<string[]> {
  const queue = [parent]
  const commands: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    try {
      const { stdout } = await execFileAsync('pgrep', ['-P', String(current)])
      for (const raw of stdout.split(/\s+/)) {
        if (!/^\d+$/.test(raw)) continue
        const pid = Number(raw)
        queue.push(pid)
        const command = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])
        commands.push(command.stdout.trim())
      }
    } catch {
      // A leaf process has no descendants.
    }
  }
  return commands
}

async function startFixtureServer(): Promise<Server> {
  const html = `<!doctype html><meta charset="utf-8"><title>DSH browser smoke</title>
    <h1>DSH browser smoke</h1><label>Name <input aria-label="Name"></label><button>Save</button>
    <label>Workspace file <input type="file" aria-label="Workspace file"></label>
    <p aria-live="polite"></p><p id="upload" aria-live="polite">Uploaded: empty</p><script>
      const input = document.querySelector('input:not([type=file])'); const output = document.querySelector('p');
      const upload = document.querySelector('input[type=file]'); const uploadOutput = document.querySelector('#upload');
      output.textContent = 'Saved: ' + (localStorage.getItem('dsh-smoke') || 'empty');
      document.querySelector('button').addEventListener('click', () => {
        localStorage.setItem('dsh-smoke', input.value); output.textContent = 'Saved: ' + input.value;
      });
      upload.addEventListener('change', () => { uploadOutput.textContent = 'Uploaded: ' + (upload.files[0]?.name || 'empty'); });
    </script>`
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(html)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  return server
}

function addressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没有 TCP 端口。')
  return address.port
}

function stopFixtureServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
}

function readOptionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main()
