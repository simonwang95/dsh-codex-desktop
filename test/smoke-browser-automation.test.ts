import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isWindowsSystemChromeProcess,
  resolveBrowserSmokeRuntime,
  windowsDescendantProcesses,
  type WindowsProcessRecord,
} from '../scripts/smoke-browser-automation.mjs'

test('Windows 开发态和安装态解析随包 Node 与 Playwright MCP', () => {
  assert.deepEqual(resolveBrowserSmokeRuntime({
    cwd: 'D:\\src\\DSH Desktop',
    platform: 'win32',
  }), {
    mcpEntry: 'D:\\src\\DSH Desktop\\runtime-browser\\node_modules\\@playwright\\mcp\\cli.js',
    nodeExecutable: 'D:\\src\\DSH Desktop\\runtime-node\\node.exe',
  })
  assert.deepEqual(resolveBrowserSmokeRuntime({
    applicationPath: 'release\\win-unpacked\\DSH Codex Desktop.exe',
    cwd: 'D:\\src\\DSH Desktop',
    platform: 'win32',
  }), {
    mcpEntry: 'D:\\src\\DSH Desktop\\release\\win-unpacked\\resources\\browser-runtime\\node_modules\\@playwright\\mcp\\cli.js',
    nodeExecutable: 'D:\\src\\DSH Desktop\\release\\win-unpacked\\resources\\node\\node.exe',
  })
})

test('Windows 只认可 Playwright MCP 后代中的系统 Google Chrome', () => {
  const processes: WindowsProcessRecord[] = [
    { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', ExecutablePath: 'D:\\app\\resources\\node\\node.exe' },
    { ProcessId: 300, ParentProcessId: 200, Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { ProcessId: 301, ParentProcessId: 300, Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { ProcessId: 400, ParentProcessId: 1, Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { ProcessId: 500, ParentProcessId: 200, Name: 'chrome.exe', ExecutablePath: 'D:\\portable\\chrome.exe' },
  ]
  const descendants = windowsDescendantProcesses(processes, 100)
  assert.deepEqual(descendants.map(process => process.ProcessId), [200, 300, 500, 301])
  assert.deepEqual(descendants.filter(isWindowsSystemChromeProcess).map(process => process.ProcessId), [300, 301])
  assert.equal(isWindowsSystemChromeProcess(processes[3]!), true)
  assert.equal(isWindowsSystemChromeProcess(processes[4]!), false)
})

test('Windows Chrome 识别兼容 CIM 只返回命令行的情况', () => {
  assert.equal(isWindowsSystemChromeProcess({
    CommandLine: '"C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="D:\\profiles\\a"',
    ExecutablePath: null,
    Name: 'CHROME.EXE',
    ParentProcessId: 10,
    ProcessId: 11,
  }), true)
})
