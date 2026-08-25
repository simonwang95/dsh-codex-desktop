import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('构建产物包含所有平台冒烟脚本', () => {
  for (const script of ['smoke-macos-package.mjs', 'smoke-macos-artifacts.mjs', 'smoke-linux-package.mjs']) {
    assert.equal(existsSync(join('dist', 'scripts', script)), true, `缺少构建产物：${script}`)
  }
})

test('Windows 制品冒烟不覆盖 PowerShell 只读 HOME 自动变量', () => {
  const script = readFileSync(join('scripts', 'smoke-windows-artifacts.ps1'), 'utf8')
  assert.doesNotMatch(script, /\$home\b/i)
  assert.match(script, /\$smokeHome\b/)
})
