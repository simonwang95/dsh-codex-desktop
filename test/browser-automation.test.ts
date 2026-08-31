import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BROWSER_AUTOMATION_ENV,
  BROWSER_MCP_VERSION,
  browserAutomationSettingsPath,
  browserRawToolName,
  browserServerName,
  browserSessionDirectories,
  browserToolDecision,
  readBrowserAutomationSettings,
  resolveBrowserMcpEntry,
  withBrowserAutomationEnvironment,
  writeBrowserAutomationSettings,
} from '../src/browser-automation.js'

const tool = (rawName: string): string => `mcp__browser_0123456789abcdef__${rawName}`

test('浏览器自动化默认关闭且设置以原子 JSON 持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-settings-'))
  try {
    assert.deepEqual(await readBrowserAutomationSettings(root), { enabled: false, schemaVersion: 1 })
    await writeBrowserAutomationSettings(root, true)
    assert.deepEqual(await readBrowserAutomationSettings(root), { enabled: true, schemaVersion: 1 })
    assert.deepEqual(JSON.parse(await readFile(browserAutomationSettingsPath(root), 'utf8')), { enabled: true, schemaVersion: 1 })
    await writeFile(browserAutomationSettingsPath(root), '{bad json', 'utf8')
    assert.equal((await readBrowserAutomationSettings(root)).enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装态和开发态都解析固定的离线 Playwright MCP 入口', () => {
  assert.equal(BROWSER_MCP_VERSION, '0.0.79')
  assert.equal(
    resolveBrowserMcpEntry({ appPath: '/app', isPackaged: false, resourcesPath: '/resources' }),
    '/app/runtime-browser/node_modules/@playwright/mcp/cli.js',
  )
  assert.equal(
    resolveBrowserMcpEntry({ appPath: '/app', isPackaged: true, resourcesPath: '/resources' }),
    '/resources/browser-runtime/node_modules/@playwright/mcp/cli.js',
  )
})

test('启停环境不会留下半启用状态', () => {
  const runtime = { mcpEntry: '/mcp/cli.js', outputRoot: '/out', profileRoot: '/profiles', runtimeDir: '/runtime' }
  const enabled = withBrowserAutomationEnvironment({ KEEP: 'yes' }, runtime, true)
  assert.equal(enabled.KEEP, 'yes')
  assert.equal(enabled[BROWSER_AUTOMATION_ENV.enabled], '1')
  assert.equal(enabled[BROWSER_AUTOMATION_ENV.mcpEntry], '/mcp/cli.js')
  const disabled = withBrowserAutomationEnvironment(enabled, runtime, false)
  assert.equal(disabled.KEEP, 'yes')
  assert.equal(disabled[BROWSER_AUTOMATION_ENV.enabled], undefined)
  assert.equal(disabled[BROWSER_AUTOMATION_ENV.mcpEntry], undefined)
  assert.equal(disabled[BROWSER_AUTOMATION_ENV.runtimeDir], '/runtime')
})

test('同一会话稳定复用配置，不同会话的 Chrome 配置和命名空间隔离', () => {
  assert.equal(browserServerName('session-a'), browserServerName('session-a'))
  assert.notEqual(browserServerName('session-a'), browserServerName('session-b'))
  assert.match(browserServerName('session-a'), /^browser_[0-9a-f]{16}$/)
  const first = browserSessionDirectories('/profiles', '/outputs', 'session-a')
  const resumed = browserSessionDirectories('/profiles', '/outputs', 'session-a')
  const other = browserSessionDirectories('/profiles', '/outputs', 'session-b')
  assert.deepEqual(first, resumed)
  assert.notEqual(first.profileDir, other.profileDir)
  assert.notEqual(first.outputDir, other.outputDir)
})

test('浏览器工具名只接受逐会话命名空间', () => {
  assert.equal(browserRawToolName(tool('browser_click')), 'browser_click')
  assert.equal(browserRawToolName('mcp__browser__browser_click'), undefined)
  assert.equal(browserRawToolName('mcp__other_0123456789abcdef__browser_click'), undefined)
})

test('浏览器门禁允许读取类操作并拦截危险协议与工作区外上传', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  await writeFile(join(workspace, 'report.txt'), 'report', 'utf8')
  assert.deepEqual(browserToolDecision(tool('browser_snapshot'), {}), { kind: 'allow' })
  assert.deepEqual(browserToolDecision(tool('browser_navigate'), { url: 'https://example.com' }), { kind: 'allow' })
  assert.equal(browserToolDecision(tool('browser_navigate'), { url: 'file:///etc/passwd' }).kind, 'deny')
  assert.equal(browserToolDecision(tool('browser_file_upload'), { paths: ['report.txt'] }, workspace).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_file_upload'), { paths: ['/etc/passwd'] }, workspace).kind, 'deny')
  assert.equal(browserToolDecision(tool('browser_file_upload'), { paths: ['../secret'] }, workspace).kind, 'deny')
  await rm(workspace, { recursive: true, force: true })
})

test('表单提交、页面代码、接受对话框和高风险点击都必须询问', () => {
  assert.equal(browserToolDecision(tool('browser_type'), { submit: true }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_press_key'), { key: 'Enter' }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_run_code'), { code: '1 + 1' }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_evaluate'), { function: '() => 1' }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_handle_dialog'), { accept: true }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_click'), { element: '确认支付' }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_click'), { element: 'Open details' }).kind, 'ask')
  assert.equal(browserToolDecision(tool('browser_future_action'), {}).kind, 'ask')
})
