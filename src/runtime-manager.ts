import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { writeTextFileAtomicSync } from './atomic-file.js'

export interface RuntimeState {
  readonly schemaVersion: 1
  readonly current?: string
  readonly lastKnownGood?: string
  readonly staging?: string
  readonly available?: string
  readonly activationPending?: boolean
  readonly failure?: { readonly stage: string; readonly message: string; readonly version?: string }
}

export interface RuntimeCandidateValidation {
  readonly packages: Readonly<Record<string, string>>
  readonly version: string
}

const stateName = 'runtime-state.json'
const legacyPointer = '@legacy'
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function runtimeEntry(dir: string): string {
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function runtimeLaunchable(dir: string): boolean {
  return existsSync(runtimeEntry(dir))
    && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group', 'package.json'))
    && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json'))
    && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-timeout', 'package.json'))
    && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-invariants', 'package.json'))
}

function installedDshVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

export function runtimeStatePath(root: string): string {
  return join(root, stateName)
}

export function readRuntimeState(root: string): RuntimeState {
  try {
    const value = JSON.parse(readFileSync(runtimeStatePath(root), 'utf8')) as RuntimeState
    if (value.schemaVersion !== 1) throw new Error('不支持的运行时状态版本。')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { schemaVersion: 1 }
  }
}

export function writeRuntimeState(root: string, state: RuntimeState): void {
  mkdirSync(root, { recursive: true })
  writeTextFileAtomicSync(runtimeStatePath(root), `${JSON.stringify(state, undefined, 2)}\n`)
}

export function runtimePointerDir(root: string, pointer: string): string {
  if (pointer === legacyPointer) return root
  if (!versionPattern.test(pointer) && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?--[a-f0-9]{8}$/.test(pointer)) {
    throw new Error('运行时指针无效。')
  }
  return join(root, 'versions', pointer)
}

export function adoptLegacyRuntime(root: string): RuntimeState {
  const state = readRuntimeState(root)
  if (state.current !== undefined || !runtimeLaunchable(root)) return state
  const next: RuntimeState = { ...state, current: legacyPointer }
  writeRuntimeState(root, next)
  return next
}

export function currentRuntimeDir(root: string): string | undefined {
  const state = adoptLegacyRuntime(root)
  if (state.current === undefined) return undefined
  const dir = runtimePointerDir(root, state.current)
  return runtimeLaunchable(dir) ? dir : undefined
}

export function currentRuntimeVersion(root: string): string | undefined {
  const dir = currentRuntimeDir(root)
  return dir === undefined ? undefined : installedDshVersion(dir)
}

export function candidateRuntimeDir(root: string, version: string): string {
  if (!versionPattern.test(version)) throw new Error('候选运行时版本无效。')
  return join(root, 'versions', version)
}

export function markRuntimeAvailable(root: string, version: string): void {
  const state = adoptLegacyRuntime(root)
  writeRuntimeState(root, { ...state, staging: undefined, available: version, failure: undefined })
}

export function activateRuntime(root: string, version: string): void {
  const candidate = candidateRuntimeDir(root, version)
  if (!runtimeLaunchable(candidate)) throw new Error('候选运行时不可启动，拒绝切换。')
  const state = adoptLegacyRuntime(root)
  writeRuntimeState(root, {
    schemaVersion: 1,
    current: version,
    ...(state.current === undefined ? {} : { lastKnownGood: state.current }),
    activationPending: true,
  })
}

export function markCurrentRuntimeHealthy(root: string): void {
  const state = readRuntimeState(root)
  if (state.activationPending !== true) return
  writeRuntimeState(root, { ...state, activationPending: false, failure: undefined })
}

export function rollbackRuntime(root: string, stage: string, error: unknown): string | undefined {
  const state = readRuntimeState(root)
  const fallback = state.lastKnownGood
  const message = sanitizeRuntimeFailure(error)
  const next: RuntimeState = {
    schemaVersion: 1,
    ...(fallback === undefined ? {} : { current: fallback }),
    failure: {
      stage,
      message,
      ...(state.current === undefined || state.current === legacyPointer ? {} : { version: state.current }),
    },
  }
  writeRuntimeState(root, next)
  return fallback === undefined ? undefined : runtimePointerDir(root, fallback)
}

export function rollbackPendingActivation(root: string): string | undefined {
  const state = readRuntimeState(root)
  if (state.activationPending !== true) return currentRuntimeDir(root)
  return rollbackRuntime(root, 'previous-start', new Error('上次切换后的首次启动未确认成功，已自动回滚。'))
}

export function sanitizeRuntimeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[A-Za-z]:\\[^\s]+|\/(?:Users|home|private|tmp)\/[^\s]+/g, '<path>').replace(/\s+/g, ' ').slice(0, 400)
}

export async function validateRuntimeCandidate(dir: string, expectedVersion: string): Promise<RuntimeCandidateValidation> {
  if (!versionPattern.test(expectedVersion)) throw new Error('候选运行时目标版本无效。')
  if (!runtimeLaunchable(dir)) throw new Error('候选运行时缺少入口或启动依赖。')
  const packages: Record<string, string> = {}
  await collectDshFamilyPackages(join(dir, 'node_modules'), packages)
  if (packages['@deepseek-ai/dsh'] !== expectedVersion) throw new Error('候选 DSH 实际版本与目标版本不一致。')
  const mismatched = Object.entries(packages).filter(([, version]) => version !== expectedVersion)
  if (mismatched.length > 0) {
    throw new Error(`候选 DSH 依赖族版本不一致：${mismatched.map(([name, version]) => `${name}@${version}`).join('、')}`)
  }
  return { packages, version: expectedVersion }
}

async function collectDshFamilyPackages(directory: string, packages: Record<string, string>, depth = 0): Promise<void> {
  if (depth > 8 || !existsSync(directory)) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name === 'node_modules') {
      await collectDshFamilyPackages(path, packages, depth + 1)
      continue
    }
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      await collectDshFamilyPackages(path, packages, depth + 1)
      continue
    }
    if (!entry.isDirectory()) continue
    const manifestPath = join(path, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/dsh') && typeof manifest.version === 'string') {
        const previous = packages[manifest.name]
        if (previous !== undefined && previous !== manifest.version) throw new Error(`候选包含重复版本：${manifest.name}`)
        packages[manifest.name] = manifest.version
      }
    }
    await collectDshFamilyPackages(join(path, 'node_modules'), packages, depth + 1)
  }
}

export async function stageRuntimeCandidate(options: {
  root: string
  version: string
  install: (directory: string) => Promise<void> | void
  healthCheck?: (directory: string) => Promise<void>
}): Promise<string> {
  const versionsDir = join(options.root, 'versions')
  mkdirSync(versionsDir, { recursive: true })
  const finalDir = candidateRuntimeDir(options.root, options.version)
  if (existsSync(finalDir)) {
    await validateRuntimeCandidate(finalDir, options.version)
    await options.healthCheck?.(finalDir)
    markRuntimeAvailable(options.root, options.version)
    return finalDir
  }
  const stagingDir = mkdtempSync(join(versionsDir, `.${basename(finalDir)}-`))
  writeRuntimeState(options.root, { ...adoptLegacyRuntime(options.root), staging: basename(stagingDir), failure: undefined })
  try {
    await options.install(stagingDir)
    await validateRuntimeCandidate(stagingDir, options.version)
    await options.healthCheck?.(stagingDir)
    renameSync(stagingDir, finalDir)
    markRuntimeAvailable(options.root, options.version)
    return finalDir
  } catch (error) {
    const state = readRuntimeState(options.root)
    writeRuntimeState(options.root, {
      ...state,
      staging: undefined,
      failure: { stage: 'candidate', message: sanitizeRuntimeFailure(error), version: options.version },
    })
    throw error
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}
