import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { extractPackagedRuntimeCandidate } from '../src/extract-runtime.js'
import { packDirectoryToTarGz, writeFileSha256 } from '../src/runtime-archive.js'
import { readRuntimeState } from '../src/runtime-manager.js'

const version = '0.1.1-rc.2'

async function writeRuntimeFixture(dir: string): Promise<void> {
  const packages = [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-timeout',
    '@deepseek-ai/dsh-invariants',
  ]
  for (const packageName of packages) {
    const packageDir = join(dir, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8')
  }
  const cordisDir = join(dir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
  await mkdir(cordisDir, { recursive: true })
  await writeFile(join(cordisDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis-plugin-group', version: '1.0.1' }), 'utf8')
  await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'ok', 'utf8')
}

async function createArchive(root: string): Promise<string> {
  const resources = join(root, 'resources')
  const source = join(root, 'source')
  await writeRuntimeFixture(source)
  await mkdir(resources, { recursive: true })
  const archive = join(resources, 'dsh-runtime.tgz')
  packDirectoryToTarGz(source, archive)
  writeFileSha256(archive)
  return resources
}

test('随包运行时只安装为版本化候选，不静默切换 current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-'))
  try {
    const resources = await createArchive(root)
    const runtimeRoot = join(root, 'user-data', 'dsh-runtime')
    const candidate = await extractPackagedRuntimeCandidate(resources, runtimeRoot, version)
    assert.equal(candidate, join(runtimeRoot, 'versions', version))
    assert.equal(await readFile(join(candidate!, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8'), 'ok')
    assert.equal(readRuntimeState(runtimeRoot).current, undefined)
    assert.equal(readRuntimeState(runtimeRoot).available, version)
    assert.equal(await extractPackagedRuntimeCandidate(resources, runtimeRoot, version), candidate)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('随包归档被篡改时拒绝创建候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-hash-'))
  try {
    const resources = await createArchive(root)
    await writeFile(join(resources, 'dsh-runtime.tgz'), 'tampered', 'utf8')
    await assert.rejects(extractPackagedRuntimeCandidate(resources, join(root, 'runtime'), version), /SHA256/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
