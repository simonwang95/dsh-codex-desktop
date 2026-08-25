import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  activateRuntime,
  candidateRuntimeDir,
  currentRuntimeDir,
  markCurrentRuntimeHealthy,
  readRuntimeState,
  rollbackPendingActivation,
  rollbackRuntime,
  stageRuntimeCandidate,
  validateRuntimeCandidate,
  writeRuntimeState,
} from '../src/runtime-manager.js'

async function writeCandidate(dir: string, version: string, mismatch?: string): Promise<void> {
  const packages = [
    ['@deepseek-ai/dsh', version],
    ['@deepseek-ai/dsh-scope', mismatch ?? version],
    ['@deepseek-ai/dsh-timeout', version],
    ['@deepseek-ai/dsh-invariants', version],
    ['@deepseek-ai/cordis-plugin-group', '1.0.1'],
  ] as const
  for (const [name, packageVersion] of packages) {
    const packageDir = join(dir, 'node_modules', ...name.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version: packageVersion }), 'utf8')
  }
  await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
}

test('候选通过完整性和健康检查后才原子切换并保留 last-known-good', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-state-'))
  try {
    const old = candidateRuntimeDir(root, '1.0.0')
    await writeCandidate(old, '1.0.0')
    writeRuntimeState(root, { schemaVersion: 1, current: '1.0.0' })
    let checked = false
    await stageRuntimeCandidate({
      root,
      version: '1.1.0',
      install: dir => writeCandidate(dir, '1.1.0'),
      healthCheck: async () => { checked = true },
    })
    assert.equal(currentRuntimeDir(root), old)
    activateRuntime(root, '1.1.0')
    assert.equal(checked, true)
    assert.equal(readRuntimeState(root).lastKnownGood, '1.0.0')
    assert.equal(readRuntimeState(root).activationPending, true)
    markCurrentRuntimeHealthy(root)
    assert.equal(readRuntimeState(root).activationPending, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('安装失败或候选健康失败时 current 保持不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-failure-'))
  try {
    const old = candidateRuntimeDir(root, '1.0.0')
    await writeCandidate(old, '1.0.0')
    writeRuntimeState(root, { schemaVersion: 1, current: '1.0.0' })
    await assert.rejects(stageRuntimeCandidate({
      root,
      version: '1.1.0',
      install: async () => { throw new Error('install failed at /Users/example/private') },
    }), /install failed/)
    assert.equal(currentRuntimeDir(root), old)
    assert.doesNotMatch(readRuntimeState(root).failure?.message ?? '', /Users\/example/)
    await assert.rejects(stageRuntimeCandidate({
      root,
      version: '1.1.0',
      install: dir => writeCandidate(dir, '1.1.0'),
      healthCheck: async () => { throw new Error('health failed') },
    }), /health failed/)
    assert.equal(currentRuntimeDir(root), old)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('首次真实启动未确认或明确失败时自动回滚 last-known-good', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-rollback-'))
  try {
    for (const version of ['1.0.0', '1.1.0']) await writeCandidate(candidateRuntimeDir(root, version), version)
    writeRuntimeState(root, { schemaVersion: 1, current: '1.0.0' })
    activateRuntime(root, '1.1.0')
    assert.equal(rollbackPendingActivation(root), candidateRuntimeDir(root, '1.0.0'))
    assert.equal(readRuntimeState(root).current, '1.0.0')
    writeRuntimeState(root, { schemaVersion: 1, current: '1.1.0', lastKnownGood: '1.0.0', activationPending: true })
    assert.equal(rollbackRuntime(root, 'first-real-start', new Error('boom')), candidateRuntimeDir(root, '1.0.0'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH 官方依赖族版本不一致时拒绝候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-mismatch-'))
  try {
    await writeCandidate(root, '1.1.0', '1.0.0')
    await assert.rejects(validateRuntimeCandidate(root, '1.1.0'), /版本不一致/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
