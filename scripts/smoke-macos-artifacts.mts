import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('制品冒烟必须在 macOS arm64 原生执行。')
  const dmg = resolve(readArgument('--dmg'))
  const zip = resolve(readArgument('--zip'))
  const evidence = optionalArgument('--evidence')
  for (const path of [dmg, zip]) if (!existsSync(path)) throw new Error(`制品不存在：${path}`)
  const root = await mkdtemp(join(tmpdir(), 'dsh-mac-artifacts-'))
  const results: string[] = []
  try {
    const mount = join(root, 'mount')
    const dmgInstall = join(root, 'dmg-install')
    await execFileAsync('mkdir', ['-p', mount, dmgInstall])
    await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
    try {
      const mountedApp = await findApplication(mount)
      const copiedApp = join(dmgInstall, basename(mountedApp))
      await execFileAsync('ditto', [mountedApp, copiedApp])
      results.push(`DMG_COPY_OK source=${basename(dmg)} app=${copiedApp}`)
      results.push((await smoke(copiedApp)).trim())
    } finally {
      await execFileAsync('hdiutil', ['detach', mount])
    }

    const zipInstall = join(root, 'zip-install')
    await execFileAsync('mkdir', ['-p', zipInstall])
    await execFileAsync('ditto', ['-x', '-k', zip, zipInstall])
    const zippedApp = await findApplication(zipInstall)
    results.push(`ZIP_EXTRACT_OK source=${basename(zip)} app=${zippedApp}`)
    results.push((await smoke(zippedApp)).trim())
    const os = (await execFileAsync('sw_vers', ['-productVersion'])).stdout.trim()
    results.unshift(`RUNNER macOS=${os} arch=${process.arch}`)
    results.push('MACOS_ARTIFACT_SMOKE_OK dmg=true zip=true controlledExit=true')
    const report = `${results.join('\n')}\n`
    process.stdout.write(report)
    if (evidence !== undefined) await writeFile(resolve(evidence), report, 'utf8')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function smoke(applicationPath: string): Promise<string> {
  const script = join(import.meta.dirname, 'smoke-macos-package.mjs')
  return (await execFileAsync(process.execPath, [script, '--application-path', applicationPath], { maxBuffer: 4 * 1024 * 1024 })).stdout
}

async function findApplication(root: string): Promise<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name)
    if (entry.isDirectory() && entry.name.endsWith('.app')) return candidate
    if (entry.isDirectory()) {
      try { return await findApplication(candidate) } catch { /* keep looking */ }
    }
  }
  throw new Error(`未找到 .app：${root}`)
}

function readArgument(name: string): string {
  const value = optionalArgument(name)
  if (value === undefined) throw new Error(`缺少参数：${name}`)
  return value
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

await main()
