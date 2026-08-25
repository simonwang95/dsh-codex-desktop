import assert from 'node:assert/strict'
import test from 'node:test'

import { parseProductConfig, resolveProductConfig } from '../src/product-config.js'

test('桌面产品配置缺省为空，不会回退到任何旧 feed', () => {
  assert.deepEqual(resolveProductConfig({ env: {} }), {})
  assert.deepEqual(parseProductConfig({ desktopUpdateUrl: 'https://updates.example.test/desktop/' }), {
    desktopUpdateUrl: 'https://updates.example.test/desktop/',
  })
})

test('更新源只允许 HTTPS 或 loopback 测试 URL', () => {
  assert.throws(() => parseProductConfig({ desktopUpdateUrl: 'http://example.test/releases' }), /HTTPS/)
  assert.deepEqual(parseProductConfig({ desktopUpdateUrl: 'http://127.0.0.1:8080/' }), {
    desktopUpdateUrl: 'http://127.0.0.1:8080/',
  })
})
