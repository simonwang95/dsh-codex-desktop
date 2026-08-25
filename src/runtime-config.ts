import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const candidates = [join(process.cwd(), 'package.json'), new URL('../../package.json', import.meta.url)]
  const path = candidates.find(candidate => existsSync(candidate))
  if (path === undefined) throw new Error('无法定位包含运行时清单的 package.json。')
  return JSON.parse(readFileSync(path, 'utf8')) as ProjectManifest
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
