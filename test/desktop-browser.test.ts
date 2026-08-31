import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BROWSER_AUTOMATION_ENV } from '../src/browser-automation.js'
import { browserMcpConfig, createBrowserTaskLock, installDesktopBrowserAutomation, isBrowserAutomationRootAgent } from '../src/desktop-browser.mjs'

test('逐会话 MCP 固定使用系统 Chrome、持久配置目录和可审计输出目录', () => {
  const config = browserMcpConfig('session-a', '/workspace', '/runtime/mcp/cli.js', '/profiles', '/outputs')
  assert.equal(config.transport, 'stdio')
  assert.equal(config.command, process.execPath)
  assert.equal(config.cwd, '/workspace')
  assert.equal(config.failOnStartupError, true)
  assert.equal(config.toolCallTimeoutMs, 120_000)
  assert.deepEqual(config.args.slice(0, 2), ['/runtime/mcp/cli.js', '--browser=chrome'])
  assert.equal(config.args.some(argument => argument.startsWith('--user-data-dir=/profiles/')), true)
  assert.equal(config.args.some(argument => argument.startsWith('--output-dir=/outputs/')), true)
  assert.equal(config.args.includes('--headless'), false)
  assert.equal(config.args.includes('--isolated'), false)
  assert.equal(config.args.includes('--no-sandbox'), false)
})

test('不同会话得到不同 MCP 名称、Chrome 配置和输出目录', () => {
  const first = browserMcpConfig('session-a', '/workspace', '/mcp.js', '/profiles', '/outputs')
  const second = browserMcpConfig('session-b', '/workspace', '/mcp.js', '/profiles', '/outputs')
  assert.notEqual(first.serverName, second.serverName)
  assert.notEqual(first.args.find(argument => argument.startsWith('--user-data-dir=')), second.args.find(argument => argument.startsWith('--user-data-dir=')))
  assert.notEqual(first.args.find(argument => argument.startsWith('--output-dir=')), second.args.find(argument => argument.startsWith('--output-dir=')))
})

test('会话恢复只按持久化 origin 判定根 Agent', () => {
  assert.equal(isBrowserAutomationRootAgent({ session: { header: {} } }), true)
  assert.equal(isBrowserAutomationRootAgent({ session: { header: { origin: 'desktop' } } }), true)
  assert.equal(isBrowserAutomationRootAgent({ session: { header: { origin: 'subagent' } } }), false)
})

test('agent/created 不读取未注入的根 Agent 注册表，旧会话恢复不会被否决', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-resume-'))
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries({
    [BROWSER_AUTOMATION_ENV.enabled]: '1',
    [BROWSER_AUTOMATION_ENV.mcpEntry]: join(root, 'mcp.js'),
    [BROWSER_AUTOMATION_ENV.outputRoot]: join(root, 'outputs'),
    [BROWSER_AUTOMATION_ENV.profileRoot]: join(root, 'profiles'),
    [BROWSER_AUTOMATION_ENV.runtimeDir]: join(root, 'runtime'),
  })) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    let created: ((payload: { agent: any }) => void) | undefined
    let preStep: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    let pluginCalls = 0
    const agentContext = {
      effect: (): (() => void) => () => undefined,
      on: (event: string, callback: (...args: any[]) => unknown): (() => void) => {
        if (event === 'agent/pre-step') preStep = callback as typeof preStep
        return () => undefined
      },
      plugin: (): PromiseLike<unknown> & { dispose(): void } => {
        pluginCalls += 1
        return Object.assign(Promise.resolve(), { dispose: (): void => undefined })
      },
    }
    const baseContext = {
      effect: (): (() => void) => () => undefined,
      on: (event: string, callback: (payload: { agent: any }) => void): (() => void) => {
        if (event === 'agent/created') created = callback
        return () => undefined
      },
    }
    const context = new Proxy(baseContext, {
      get(target, property, receiver) {
        if (property === 'agents') throw new Error('cannot get property "agents" without inject')
        return Reflect.get(target, property, receiver)
      },
    })
    await installDesktopBrowserAutomation(context as any, {
      loadMcpPlugin: async () => ({ apply: () => undefined, name: 'fake-mcp' }),
    })
    assert.ok(created)
    assert.doesNotThrow(() => created?.({
      agent: { ctx: agentContext, id: 'restored-session', session: { header: { cwd: root } } },
    }))
    assert.ok(preStep)
    await preStep?.({}, async () => undefined)
    assert.equal(pluginCalls, 1)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('同一会话的浏览器调用严格串行，非浏览器工具不占浏览器锁', async () => {
  const lock = createBrowserTaskLock('mcp__browser_a__')
  const order: string[] = []
  let releaseFirst = (): void => undefined
  const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve })
  const first = lock('mcp__browser_a__browser_click', async () => {
    order.push('first:start')
    await firstBarrier
    order.push('first:end')
  })
  await Promise.resolve()
  const second = lock('mcp__browser_a__browser_snapshot', async () => { order.push('second') })
  await lock('read', async () => { order.push('read') })
  assert.deepEqual(order, ['first:start', 'read'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'read', 'first:end', 'second'])
})
