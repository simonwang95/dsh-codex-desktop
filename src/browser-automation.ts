import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { writeTextFileAtomic } from './atomic-file.js'

export const BROWSER_AUTOMATION_SETTINGS_FILE = 'browser-automation.json'
export const BROWSER_AUTOMATION_SETTINGS_VERSION = 1
export const BROWSER_MCP_VERSION = '0.0.79'

export const BROWSER_AUTOMATION_ENV = {
  enabled: 'DSH_BROWSER_AUTOMATION_ENABLED',
  mcpEntry: 'DSH_BROWSER_MCP_ENTRY',
  outputRoot: 'DSH_BROWSER_OUTPUT_ROOT',
  profileRoot: 'DSH_BROWSER_PROFILE_ROOT',
  runtimeDir: 'DSH_ACTIVE_RUNTIME_DIR',
} as const

export interface BrowserAutomationSettings {
  readonly enabled: boolean
  readonly schemaVersion: typeof BROWSER_AUTOMATION_SETTINGS_VERSION
}

export interface BrowserAutomationRuntime {
  readonly mcpEntry: string
  readonly outputRoot: string
  readonly profileRoot: string
  readonly runtimeDir: string
}

export type BrowserToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }

const browserToolNamePattern = /^mcp__browser_[0-9a-f]{16}__(browser_[A-Za-z0-9_-]+)$/
const readOnlyBrowserTools = new Set([
  'browser_close',
  'browser_console_messages',
  'browser_cookie_get',
  'browser_cookie_list',
  'browser_find',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_network_requests',
  'browser_resize',
  'browser_snapshot',
  'browser_storage_get',
  'browser_storage_list',
  'browser_take_screenshot',
  'browser_wait_for',
])

export function defaultBrowserAutomationSettings(): BrowserAutomationSettings {
  return { enabled: false, schemaVersion: BROWSER_AUTOMATION_SETTINGS_VERSION }
}

export function browserAutomationSettingsPath(userDataDir: string): string {
  return join(userDataDir, BROWSER_AUTOMATION_SETTINGS_FILE)
}

export async function readBrowserAutomationSettings(userDataDir: string): Promise<BrowserAutomationSettings> {
  try {
    const value = JSON.parse(await readFile(browserAutomationSettingsPath(userDataDir), 'utf8')) as Partial<BrowserAutomationSettings>
    if (value.schemaVersion !== BROWSER_AUTOMATION_SETTINGS_VERSION || typeof value.enabled !== 'boolean') {
      return defaultBrowserAutomationSettings()
    }
    return { enabled: value.enabled, schemaVersion: BROWSER_AUTOMATION_SETTINGS_VERSION }
  } catch {
    return defaultBrowserAutomationSettings()
  }
}

export async function writeBrowserAutomationSettings(userDataDir: string, enabled: boolean): Promise<void> {
  await mkdir(userDataDir, { recursive: true })
  const settings: BrowserAutomationSettings = { enabled, schemaVersion: BROWSER_AUTOMATION_SETTINGS_VERSION }
  await writeTextFileAtomic(browserAutomationSettingsPath(userDataDir), `${JSON.stringify(settings, undefined, 2)}\n`)
}

export function resolveBrowserMcpEntry(options: { appPath: string; isPackaged: boolean; resourcesPath: string }): string {
  const root = options.isPackaged ? join(options.resourcesPath, 'browser-runtime') : join(options.appPath, 'runtime-browser')
  return join(root, 'node_modules', '@playwright', 'mcp', 'cli.js')
}

export function resolveBrowserAutomationRuntime(options: {
  activeRuntimeDir: string
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  userDataDir: string
}): BrowserAutomationRuntime {
  return {
    mcpEntry: resolveBrowserMcpEntry(options),
    outputRoot: join(options.userDataDir, 'browser-automation', 'outputs'),
    profileRoot: join(options.userDataDir, 'browser-automation', 'profiles'),
    runtimeDir: options.activeRuntimeDir,
  }
}

export function browserAutomationRuntimeAvailable(runtime: BrowserAutomationRuntime): boolean {
  return existsSync(runtime.mcpEntry)
}

/** Adds or removes the complete browser capability environment as one unit. */
export function withBrowserAutomationEnvironment(
  environment: NodeJS.ProcessEnv,
  runtime: BrowserAutomationRuntime,
  enabled: boolean,
): NodeJS.ProcessEnv {
  const next = { ...environment }
  for (const key of Object.values(BROWSER_AUTOMATION_ENV)) delete next[key]
  next[BROWSER_AUTOMATION_ENV.runtimeDir] = runtime.runtimeDir
  if (!enabled) return next
  next[BROWSER_AUTOMATION_ENV.enabled] = '1'
  next[BROWSER_AUTOMATION_ENV.mcpEntry] = runtime.mcpEntry
  next[BROWSER_AUTOMATION_ENV.outputRoot] = runtime.outputRoot
  next[BROWSER_AUTOMATION_ENV.profileRoot] = runtime.profileRoot
  return next
}

export function browserSessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
}

export function browserServerName(sessionId: string): string {
  return `browser_${browserSessionKey(sessionId)}`
}

export function browserSessionDirectories(profileRoot: string, outputRoot: string, sessionId: string): {
  outputDir: string
  profileDir: string
} {
  const key = browserSessionKey(sessionId)
  return { outputDir: join(outputRoot, key), profileDir: join(profileRoot, key) }
}

export function browserRawToolName(publicName: string): string | undefined {
  return browserToolNamePattern.exec(publicName)?.[1]
}

export function browserToolDecision(name: string, args: unknown, workspaceDir?: string): BrowserToolDecision {
  const rawName = browserRawToolName(name)
  if (rawName === undefined) return { kind: 'allow' }
  const record = asRecord(args)

  if (rawName === 'browser_navigate') {
    const url = typeof record.url === 'string' ? record.url : ''
    if (!isAllowedNavigationUrl(url)) {
      return { kind: 'deny', reason: '浏览器自动化只允许访问 http、https 和 about:blank 地址。' }
    }
  }

  if (rawName === 'browser_file_upload') {
    const paths = Array.isArray(record.paths) ? record.paths.filter((path): path is string => typeof path === 'string') : []
    if (workspaceDir === undefined || paths.length === 0 || paths.some(path => !isPathInsideWorkspace(path, workspaceDir))) {
      return { kind: 'deny', reason: '浏览器只能上传当前工作区内的文件。' }
    }
    return { kind: 'ask', reason: '浏览器即将把工作区文件上传到网页。' }
  }

  if (rawName === 'browser_drop' && Array.isArray(record.paths)) {
    const paths = record.paths.filter((path): path is string => typeof path === 'string')
    if (workspaceDir === undefined || paths.some(path => !isPathInsideWorkspace(path, workspaceDir))) {
      return { kind: 'deny', reason: '浏览器只能拖放当前工作区内的文件。' }
    }
  }
  if (readOnlyBrowserTools.has(rawName)) return { kind: 'allow' }
  const element = typeof record.element === 'string' && record.element.trim() !== ''
    ? `：${record.element.trim().slice(0, 120)}`
    : ''
  return { kind: 'ask', reason: `浏览器即将执行可能改变网页、账户或浏览器状态的操作${element}` }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isAllowedNavigationUrl(value: string): boolean {
  if (value === 'about:blank') return true
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isPathInsideWorkspace(path: string, workspaceDir: string): boolean {
  try {
    const candidate = realpathSync(resolve(workspaceDir, path))
    const workspace = realpathSync(resolve(workspaceDir))
    const child = relative(workspace, candidate)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  } catch {
    return false
  }
}
