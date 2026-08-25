import { existsSync, readFileSync } from 'node:fs'

export interface RuntimeManifest {
  readonly schemaVersion: 1
  readonly dshVersion: string
  readonly nodeVersion: string
  readonly pnpmVersion: string
}

interface ProjectManifest {
  config?: { runtimeManifest?: unknown }
  engines?: { node?: string; pnpm?: string }
  packageManager?: string
}

const exactVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function readProjectManifest(): ProjectManifest {
  // 编译态位于 dist/src，ASAR 内也保持相同层级；desktop-bridge 则位于
  // Resources/desktop-bridge，需要显式回到相邻的 app.asar。不能依赖 cwd，
  // LaunchServices、Windows 快捷方式和测试 runner 的工作目录都可能不同。
  const candidates = [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
    new URL('../app.asar/package.json', import.meta.url),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectManifest
    if (project.config?.runtimeManifest !== undefined) return project
  }
  throw new Error('无法定位包含运行时清单的 package.json。')
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('package.json 缺少 config.runtimeManifest。')
  }
  const manifest = value as Partial<RuntimeManifest>
  if (manifest.schemaVersion !== 1) throw new Error('不支持的运行时清单版本。')
  for (const [name, version] of [
    ['DSH', manifest.dshVersion],
    ['Node', manifest.nodeVersion],
    ['pnpm', manifest.pnpmVersion],
  ] as const) {
    if (typeof version !== 'string' || !exactVersion.test(version)) throw new Error(`${name} 版本无效。`)
  }
  return manifest as RuntimeManifest
}

export function runtimeManifest(): RuntimeManifest {
  return parseRuntimeManifest(readProjectManifest().config?.runtimeManifest)
}

export function assertProjectToolchainMatchesRuntimeManifest(project = readProjectManifest()): void {
  const runtime = parseRuntimeManifest(project.config?.runtimeManifest)
  if (project.engines?.node !== runtime.nodeVersion.replace(/^v/, '')) throw new Error('engines.node 与运行时清单不一致。')
  if (project.engines?.pnpm !== runtime.pnpmVersion) throw new Error('engines.pnpm 与运行时清单不一致。')
  if (project.packageManager !== `pnpm@${runtime.pnpmVersion}`) throw new Error('packageManager 与运行时清单不一致。')
}

export const OFFICIAL_DSH_VERSION = process.env.DSH_BUNDLED_DSH_VERSION ?? runtimeManifest().dshVersion
