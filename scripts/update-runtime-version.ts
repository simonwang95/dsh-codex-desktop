import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function updateRuntimeVersionManifests(project: Record<string, any>, runtimeLock: Record<string, any>, version: string): void {
  if (!versionPattern.test(version)) throw new Error('必须提供精确 DSH SemVer。')
  if (project.config?.runtimeManifest === undefined) throw new Error('缺少 config.runtimeManifest。')
  project.config.runtimeManifest.dshVersion = version
  const dependencies = runtimeLock.dependencies as Record<string, string> | undefined
  if (dependencies === undefined || dependencies['@deepseek-ai/dsh'] === undefined) throw new Error('运行时锁清单缺少官方 DSH。')
  for (const packageName of Object.keys(dependencies)) {
    if (packageName === '@deepseek-ai/dsh' || packageName.startsWith('@deepseek-ai/dsh-')) dependencies[packageName] = version
  }
}

async function main(): Promise<void> {
  const version = process.argv[2]
  if (version === undefined) throw new Error('用法：pnpm runtime:update <精确 DSH 版本>')
  const projectPath = join(projectRoot, 'package.json')
  const runtimeLockPath = join(projectRoot, 'runtime-lock', 'package.json')
  const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<string, any>
  const runtimeLock = JSON.parse(await readFile(runtimeLockPath, 'utf8')) as Record<string, any>
  updateRuntimeVersionManifests(project, runtimeLock, version)
  await writeFile(projectPath, `${JSON.stringify(project, undefined, 2)}\n`, 'utf8')
  await writeFile(runtimeLockPath, `${JSON.stringify(runtimeLock, undefined, 2)}\n`, 'utf8')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const locked = spawnSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
    cwd: join(projectRoot, 'runtime-lock'),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (locked.status !== 0) throw new Error('更新冻结依赖图失败。')
  const patch = join(projectRoot, 'patches', `dsh-${version}-permission-localization.patch`)
  console.log(existsSync(patch)
    ? `已找到版本补丁映射：${patch}`
    : `DSH ${version} 没有桌面补丁映射；装配时将保留并验证上游资源。`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
