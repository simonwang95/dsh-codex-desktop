import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BROWSER_AUTOMATION_ENV,
  browserServerName,
  browserSessionDirectories,
  browserToolDecision,
} from './browser-automation.js'

interface AgentLike {
  readonly ctx: CordisLike
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string; readonly origin?: string } }
}

interface CordisLike {
  readonly logger?: { error(message: string): void; info?(message: string): void }
  effect?(callback: () => void | (() => void | Promise<void>), label?: string): () => void
  on(event: string, callback: (...args: any[]) => unknown): () => void
  plugin(plugin: unknown, config?: unknown): PromiseLike<unknown> & { dispose?(): void | Promise<void> }
}

interface McpPluginModule {
  readonly apply: (...args: unknown[]) => unknown
  readonly name: string
}

interface BrowserMcpConfig {
  readonly args: string[]
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly failOnStartupError: boolean
  readonly reconnect: { readonly enabled: boolean; readonly initialDelayMs: number; readonly maxAttempts: number; readonly maxDelayMs: number }
  readonly serverName: string
  readonly toolCallTimeoutMs: number
  readonly transport: 'stdio'
}

/** Install one isolated Playwright MCP process for every root DSH session. */
export async function installDesktopBrowserAutomation(
  ctx: CordisLike,
  dependencies: { loadMcpPlugin?: (runtimeDir: string) => Promise<McpPluginModule> } = {},
): Promise<void> {
  if (process.env[BROWSER_AUTOMATION_ENV.enabled] !== '1') return
  const mcpEntry = requiredEnvironment(BROWSER_AUTOMATION_ENV.mcpEntry)
  const profileRoot = requiredEnvironment(BROWSER_AUTOMATION_ENV.profileRoot)
  const outputRoot = requiredEnvironment(BROWSER_AUTOMATION_ENV.outputRoot)
  const runtimeDir = requiredEnvironment(BROWSER_AUTOMATION_ENV.runtimeDir)
  const mcpPlugin = await (dependencies.loadMcpPlugin ?? loadMcpPlugin)(runtimeDir)
  const installed = new WeakSet<AgentLike>()

  const stopCreated = ctx.on('agent/created', ({ agent }: { agent: AgentLike }) => {
    // `agent/created` already carries the scoped Agent. Reading the root Agent
    // registry here would cross Cordis' injection boundary and veto resume.
    if (installed.has(agent) || !isBrowserAutomationRootAgent(agent)) return
    installed.add(agent)

    const config = browserMcpConfig(agent.id, agent.session.header.cwd, mcpEntry, profileRoot, outputRoot)
    let fiber: ReturnType<CordisLike['plugin']> | undefined
    const ready = prepareSessionDirectories(config).then(async () => {
      fiber = agent.ctx.plugin(mcpPlugin, config)
      await fiber
    })
    const stopGate = agent.ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<unknown>) => {
      try {
        await ready
      } catch (error) {
        agent.ctx.logger?.error(`browser-automation(${config.serverName}): ${errorMessage(error)}`)
      }
      return next()
    })
    const stopPolicy = agent.ctx.on('tools/pre-execute', async (exec: {
      readonly agent?: AgentLike
      readonly arguments: unknown
      readonly name: string
    }, next: () => Promise<{ kind: string }>) => {
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      return browserToolDecision(exec.name, exec.arguments, exec.agent?.session.header.cwd ?? agent.session.header.cwd)
    })
    const runExclusive = createBrowserTaskLock(`mcp__${config.serverName}__`)
    const stopLock = agent.ctx.on('tools/execute', (exec: { readonly name: string }, next: () => Promise<unknown>) => {
      return runExclusive(exec.name, next)
    })
    agent.ctx.effect?.(() => async () => {
      stopLock()
      stopPolicy()
      stopGate()
      try {
        await ready
        await fiber?.dispose?.()
      } catch {
        // A failed startup owns no live browser process.
      }
    }, `browser-automation(${config.serverName})`)
  })
  ctx.effect?.(() => stopCreated, 'browser-automation.sessions')
}

export function isBrowserAutomationRootAgent(agent: Pick<AgentLike, 'session'>): boolean {
  return agent.session.header.origin !== 'subagent'
}

/** Serialize every browser call in one session, including nested Code Mode dispatches. */
export function createBrowserTaskLock(prefix: string): (name: string, next: () => Promise<unknown>) => Promise<unknown> {
  let tail = Promise.resolve()
  return async (name, next) => {
    if (!name.startsWith(prefix)) return next()
    const previous = tail
    let release = (): void => undefined
    tail = new Promise<void>(resolveRelease => { release = resolveRelease })
    await previous
    try {
      return await next()
    } finally {
      release()
    }
  }
}

export function browserMcpConfig(
  sessionId: string,
  workspaceDir: string | undefined,
  mcpEntry: string,
  profileRoot: string,
  outputRoot: string,
): BrowserMcpConfig {
  const directories = browserSessionDirectories(profileRoot, outputRoot, sessionId)
  return {
    args: [
      mcpEntry,
      '--browser=chrome',
      `--user-data-dir=${directories.profileDir}`,
      `--output-dir=${directories.outputDir}`,
    ],
    command: process.execPath,
    cwd: workspaceDir ?? dirname(directories.outputDir),
    env: {},
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxAttempts: 3, maxDelayMs: 5_000 },
    serverName: browserServerName(sessionId),
    toolCallTimeoutMs: 120_000,
    transport: 'stdio',
  }
}

async function prepareSessionDirectories(config: BrowserMcpConfig): Promise<void> {
  const profileArg = config.args.find(argument => argument.startsWith('--user-data-dir='))
  const outputArg = config.args.find(argument => argument.startsWith('--output-dir='))
  if (profileArg === undefined || outputArg === undefined) throw new Error('browser automation directories are missing')
  await Promise.all([
    mkdir(profileArg.slice('--user-data-dir='.length), { recursive: true }),
    mkdir(outputArg.slice('--output-dir='.length), { recursive: true }),
  ])
}

async function loadMcpPlugin(runtimeDir: string): Promise<McpPluginModule> {
  const request = createRequire(join(runtimeDir, 'package.json'))
  const entry = request.resolve('@deepseek-ai/dsh-mcp-client')
  const module = await import(pathToFileURL(entry).href) as Partial<McpPluginModule>
  if (typeof module.apply !== 'function' || typeof module.name !== 'string') {
    throw new Error('@deepseek-ai/dsh-mcp-client 导出无效。')
  }
  return module as McpPluginModule
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`浏览器自动化缺少环境变量：${name}`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
