import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('构建产物包含所有平台冒烟脚本', () => {
  for (const script of ['smoke-browser-automation.mjs', 'smoke-macos-package.mjs', 'smoke-macos-artifacts.mjs', 'smoke-linux-package.mjs']) {
    assert.equal(existsSync(join('dist', 'scripts', script)), true, `缺少构建产物：${script}`)
  }
})

test('Windows 制品冒烟使用最终就绪信号且不依赖 PowerShell 只读或残留自动变量', () => {
  const script = readFileSync(join('scripts', 'smoke-windows-artifacts.ps1'), 'utf8')
  const packageSmoke = readFileSync(join('scripts', 'smoke-package.ps1'), 'utf8')
  assert.doesNotMatch(script, /\$home\b/i)
  assert.doesNotMatch(script, /\$LASTEXITCODE/)
  assert.match(script, /\$smokeHome\b/)
  assert.match(script, /Get-AuthenticodeSignature/)
  assert.match(script, /SIGNING_DISABLED nsis=NotSigned/)
  assert.match(script, /smoke-browser-automation\.mjs/)
  assert.match(script, /SYSTEM_CHROME_OK zip=true installed=true workspaceWrite=true workspaceUpload=true/)
  assert.match(packageSmoke, /DSH_SMOKE_READY/)
  assert.match(packageSmoke, /DSH_SMOKE_BROWSER\\s\+enabled=true\\s\+runtime=true/)
  assert.match(packageSmoke, /browser-automation\.json/)
  assert.match(packageSmoke, /isolatedUserData=true/)
  assert.match(packageSmoke, /-RedirectStandardOutput/)
  assert.match(packageSmoke, /AddSeconds\(180\)/)
  assert.doesNotMatch(packageSmoke, /Get-NetTCPConnection/)
})
