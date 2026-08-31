import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { copyWorkspacePackages, officialRuntimeGlobalNodeModulesRoot, officialRuntimeNpmDependencies, officialRuntimeNpmInstallArgs, pruneStoreForPackaging, removePreparedPath, resolveBundledNodeSha256, writePnpmShims } from '../scripts/prepare-runtime.js'
import { DESKTOP_BRIDGE_FILES } from '../src/desktop-host.js'

const execFileAsync = promisify(execFile)

test('按目标平台选择随包 Node 的 SHA256', () => {
  const checksums = {
    'win32-x64': 'WINDOWS',
    'darwin-arm64': 'APPLE_SILICON',
    'darwin-x64': 'INTEL',
    'linux-x64': 'LINUX',
  }
  assert.equal(resolveBundledNodeSha256(checksums, 'darwin', 'arm64'), 'APPLE_SILICON')
  assert.equal(resolveBundledNodeSha256(checksums, 'darwin', 'x64'), 'INTEL')
  assert.equal(resolveBundledNodeSha256(checksums, 'linux', 'x64'), 'LINUX')
})

test('项目配置包含 Linux x64 的随包 Node SHA256', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    config?: { bundledNodeSha256?: unknown }
  }
  assert.equal(
    resolveBundledNodeSha256(manifest.config?.bundledNodeSha256, 'linux', 'x64'),
    'BC17C508FFEED0EC622934F9B7FA72F8E78DA65350E63C3ECEB56FA688AA5E12',
  )
})

test('跳过指向普通文件的工作区链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  try {
    const packagesRoot = join(root, 'packages')
    const packageRoot = join(packagesRoot, 'fixture', 'package')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/fixture' }), 'utf8')
    const sourceFile = join(root, 'CLAUDE.md')
    await writeFile(sourceFile, '无关文件', 'utf8')
    try {
      await symlink(sourceFile, join(packagesRoot, 'CLAUDE.md'), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') t.skip('当前环境不允许创建文件链接')
      else throw error
      return
    }

    const runtimeRoot = join(root, 'runtime')
    await copyWorkspacePackages(packagesRoot, 2, runtimeRoot)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'fixture', 'package.json')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('只把官方包复制进安装目录，社区插件不走这条路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-'))
  try {
    const packagesRoot = join(root, 'packages')
    const official = join(packagesRoot, 'official', 'package')
    const community = join(packagesRoot, 'community', 'package')
    await mkdir(official, { recursive: true })
    await mkdir(community, { recursive: true })
    await writeFile(join(official, 'package.json'), JSON.stringify({ name: '@deepseek-ai/fixture' }), 'utf8')
    await writeFile(join(community, 'package.json'), JSON.stringify({ name: '@michengai/dsh-codex-ui' }), 'utf8')
    const runtimeRoot = join(root, 'runtime')
    await copyWorkspacePackages(packagesRoot, 2, runtimeRoot)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'fixture', 'package.json')), true)
    assert.equal(existsSync(join(runtimeRoot, 'node_modules', '@michengai', 'dsh-codex-ui', 'package.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('core-only 打包配置不携带第三方离线插件仓库', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-plugins/store.tgz' && item.to === 'plugins-store.tgz'),
    false,
  )
})

test('Windows 只写 pnpm.cmd，避免和 pnpm 包装目录撞名', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pnpm-'))
  try {
    await mkdir(join(root, 'pnpm-package'), { recursive: true })
    await writePnpmShims(root, 'bin/pnpm.cjs', 'win32')
    assert.equal(existsSync(join(root, 'pnpm.cmd')), true)
    assert.equal(existsSync(join(root, 'pnpm')), false)
    const shim = await readFile(join(root, 'pnpm.cmd'), 'utf8')
    assert.match(shim, /pnpm-package\\bin\\pnpm.cjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('打包前删除 pnpm store 的 projects 链接，避免 7zip 扫到断裂路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const projects = join(root, 'v11', 'projects', 'broken')
    const files = join(root, 'v11', 'files')
    await mkdir(projects, { recursive: true })
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'keep.txt'), 'ok', 'utf8')
    await pruneStoreForPackaging(root)
    assert.equal(existsSync(projects), false)
    assert.equal(existsSync(join(files, 'keep.txt')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装器产品名、进程名和安装目录都使用 DSH Codex Desktop', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    desktopName?: string
    build?: { productName?: string, executableName?: string, nsis?: { include?: string, shortcutName?: string, uninstallDisplayName?: string } }
  }
  assert.equal(manifest.build?.productName, 'DSH Codex Desktop')
  assert.equal(manifest.desktopName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.executableName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.nsis?.include, 'build/installer.nsh')
  assert.equal(manifest.build?.nsis?.shortcutName, 'DSH Codex Desktop')
  assert.equal(manifest.build?.nsis?.uninstallDisplayName, 'DSH Codex Desktop')
  const installer = await readFile(new URL('../../build/installer.nsh', import.meta.url), 'utf8')
  assert.match(installer, /APP_FILENAME/)
  assert.match(installer, /onVerifyInstDir/)
})

test('打包配置把预装官方运行时放到 extraResources', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-dsh.tgz' && item.to === 'dsh-runtime.tgz'),
    true,
  )
})

test('打包配置包含固定版本的离线浏览器 MCP，且不内置浏览器二进制', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    config?: { browserRuntime?: { browser?: string; mcpVersion?: string } }
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  const lock = JSON.parse(await readFile(new URL('../../browser-runtime-lock/package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.deepEqual(manifest.config?.browserRuntime, { browser: 'chrome', mcpVersion: '0.0.79' })
  assert.equal(lock.dependencies?.['@playwright/mcp'], '0.0.79')
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'runtime-browser' && item.to === 'browser-runtime'),
    true,
  )
  for (const dependency of ['@playwright/mcp', 'playwright', 'playwright-core']) {
    assert.equal(
      manifest.build?.extraResources?.some(item => item.from === `runtime-browser/node_modules/${dependency}` && item.to === `browser-runtime/node_modules/${dependency}`),
      true,
    )
  }
})

test('清理运行时目录必须可重试，避免 Windows ENOTEMPTY', async () => {
  const source = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /export async function removePreparedPath/)
  assert.match(source, /maxRetries/)
  assert.match(source, /await removePreparedPath\(target\)/)
  const root = await mkdtemp(join(tmpdir(), 'dsh-rm-'))
  const nested = join(root, 'pnpm-package', 'artifacts', 'exe', 'dist', 'node_modules', 'undici', 'lib')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'keep.txt'), 'x', 'utf8')
  await removePreparedPath(root)
  assert.equal(existsSync(root), false)
})

test('打包配置显式映射完整编译产物', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { files?: Array<string | { from?: string; to?: string; filter?: string[] }> }
  }
  assert.equal(
    manifest.build?.files?.some(item => typeof item !== 'string'
      && item.from === 'dist'
      && item.to === 'dist'
      && item.filter?.includes('**/*')),
    true,
  )
})

test('Windows 冒烟检查使用实际产品可执行文件名', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /release\\win-unpacked\\DSH Codex Desktop\.exe/)
  assert.match(workflow, /smoke-browser-automation\.mjs --workspace/)
  assert.match(workflow, /-BrowserEnabled/)
})

test('官方运行时使用冻结 lock 和 npm ci 装配', () => {
  assert.deepEqual(officialRuntimeNpmInstallArgs('D:\\runtime'), [
    'ci',
    '--prefix=D:\\runtime',
    '--omit=dev',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
  ])
})

test('npm 全局安装目录按平台归一化', () => {
  assert.equal(officialRuntimeGlobalNodeModulesRoot('runtime', 'win32'), join('runtime', 'node_modules'))
  assert.equal(officialRuntimeGlobalNodeModulesRoot('runtime', 'linux'), join('runtime', 'lib', 'node_modules'))
})

test('官方运行时锁显式包含入口和启动必需 peer', () => {
  assert.equal(officialRuntimeNpmDependencies()['@deepseek-ai/dsh'], '0.1.1-rc.2')
  assert.equal(officialRuntimeNpmDependencies()['@deepseek-ai/cordis-plugin-group'], '1.0.1')
  assert.equal(officialRuntimeNpmDependencies()['@deepseek-ai/dsh-scope'], '0.1.1-rc.2')
  assert.equal(officialRuntimeNpmDependencies()['@deepseek-ai/dsh-atomic-write'], '0.1.1-rc.2')
  assert.equal(officialRuntimeNpmDependencies().react, '18.3.1')
})

test('桌面装配阶段给 rc.2 权限菜单应用中文补丁，且不包含本机绝对路径', async () => {
  const prepare = await readFile(new URL('../../scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  const patch = await readFile(
    new URL('../../patches/dsh-0.1.1-rc.2-permission-localization.patch', import.meta.url),
    'utf8',
  )
  const stageAt = prepare.indexOf('await stageOfficialRuntime(officialRuntimeRoot')
  const patchAt = prepare.indexOf('applyOfficialRuntimePatch(officialRuntimeRoot)')
  const packAt = prepare.indexOf('packDirectoryToTarGz(officialRuntimeRoot')
  assert.equal(stageAt < patchAt && patchAt < packAt, true)
  assert.match(patch, /dsh-client-ui-permission-presets\/lib\/client\.js/)
  assert.match(patch, /dsh-client-ui-conversation\/lib\/client\.js/)
  assert.match(patch, /"preset\.readOnly": "仅可查看"/)
  assert.match(patch, /"access\.preset\.readOnly": "仅可查看"/)
  assert.doesNotMatch(patch, /[A-Z]:\\\\Tools\\\\/i)
})

test('Windows 冒烟由应用完成候选验证并要求受控退出', async () => {
  const script = await readFile(new URL('../../scripts/smoke-package.ps1', import.meta.url), 'utf8')
  const macScript = await readFile(new URL('../../scripts/smoke-macos-package.mts', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /extract-runtime\.mjs/)
  assert.match(script, /--user-data-dir=/)
  assert.match(script, /--smoke-test/)
  assert.match(main, /DSH_SMOKE_BROWSER enabled=/)
  assert.match(script, /受控退出/)
  assert.match(script, /-WorkingDirectory \$tempRoot/)
  assert.match(macScript, /cwd: tempRoot/)
  assert.match(main, /--user-data-dir=/)
})

test('CI 仅手动生成未签名 Windows 临时制品，不包含标签或 Release 路径', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /version: 11\.22\.0/)
  assert.match(workflow, /workflow_dispatch/)
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
  assert.match(workflow, /smoke-windows-artifacts\.ps1/)
  assert.doesNotMatch(workflow, /refs\/tags|gh release|create GitHub Release|contents: write/)
  assert.match(workflow, /pnpm test\r?\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
  assert.match(workflow, /pnpm run dist -- --win --x64/)
})

test('打包态从 desktop-bridge 加载 DSH 主进程模块', async () => {
  const main = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  const host = await readFile(new URL('../../src/desktop-host.ts', import.meta.url), 'utf8')
  assert.match(main, /desktop-bridge.*dsh-process\.js/)
  assert.doesNotMatch(host, /from '\.\/dsh-process\.js'/)
})

test('安装阶段解压脚本带上自己的运行依赖', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: { from?: string; to?: string }[] }
  }
  assert.equal(
    manifest.build?.extraResources?.some(item => item.from === 'dist/src/runtime-archive.js' && item.to === 'runtime-archive.js'),
    true,
  )
})

test('desktop-bridge 资源清单包含完整运行依赖闭包', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { extraResources?: Array<{ to?: string; filter?: string[] }> }
  }
  const filter = manifest.build?.extraResources?.find(item => item.to === 'desktop-bridge')?.filter
  assert.deepEqual([...(filter ?? [])].sort(), [...DESKTOP_BRIDGE_FILES].sort())
})

test('desktop-bridge 独立目录可以完成 ESM 导入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-'))
  const previousVersion = process.env.DSH_BUNDLED_DSH_VERSION
  try {
    for (const file of DESKTOP_BRIDGE_FILES) {
      await copyFile(new URL(`../../dist/src/${file}`, import.meta.url), join(root, file))
    }
    // Profile 内的 bridge 由 Electron 主进程启动 DSH 时注入冻结版本；
    // Resources 内的 bridge 则由下面的安装态布局测试覆盖 app.asar 读取。
    process.env.DSH_BUNDLED_DSH_VERSION = '0.1.1-rc.2'
    await import(`${pathToFileURL(join(root, 'desktop-host.js')).href}?test=${Date.now()}`)
  } finally {
    if (previousVersion === undefined) delete process.env.DSH_BUNDLED_DSH_VERSION
    else process.env.DSH_BUNDLED_DSH_VERSION = previousVersion
    await rm(root, { recursive: true, force: true })
  }
})

test('安装态 desktop-bridge 脱离仓库工作目录仍可读取 app.asar 运行时清单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-installed-runtime-config-'))
  try {
    const resources = join(root, 'DSH Codex Desktop.app', 'Contents', 'Resources')
    const bridge = join(resources, 'desktop-bridge')
    const appAsar = join(resources, 'app.asar')
    const unrelatedWorkingDirectory = join(root, 'launch-services-working-directory')
    await mkdir(bridge, { recursive: true })
    await mkdir(appAsar, { recursive: true })
    await mkdir(unrelatedWorkingDirectory, { recursive: true })
    await copyFile(new URL('../../dist/src/runtime-config.js', import.meta.url), join(bridge, 'runtime-config.js'))
    await writeFile(join(appAsar, 'package.json'), JSON.stringify({
      config: {
        runtimeManifest: {
          schemaVersion: 1,
          dshVersion: '0.1.1-rc.2',
          nodeVersion: 'v24.19.0',
          pnpmVersion: '11.22.0',
        },
      },
    }), 'utf8')
    const { DSH_BUNDLED_DSH_VERSION: _ignored, ...environment } = process.env
    const moduleUrl = pathToFileURL(join(bridge, 'runtime-config.js')).href
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const runtime = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(runtime.OFFICIAL_DSH_VERSION);`,
    ], { cwd: unrelatedWorkingDirectory, env: environment })
    assert.equal(stdout, '0.1.1-rc.2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('更新产物使用不会被 GitHub 改写的固定文件名', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: {
      win?: { artifactName?: string }
      mac?: { artifactName?: string }
      linux?: { artifactName?: string }
    }
  }
  assert.equal(manifest.build?.win?.artifactName, 'dsh-codex-desktop-${version}-win-${arch}.${ext}')
  assert.equal(manifest.build?.mac?.artifactName, 'dsh-codex-desktop-${version}-mac-${arch}.${ext}')
  assert.equal(manifest.build?.linux?.artifactName, 'dsh-codex-desktop-${version}-linux-${arch}.${ext}')
})

test('手动 CI artifact 只上传 Windows EXE、ZIP 与证据', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/desktop-package.yml', import.meta.url), 'utf8')
  assert.match(workflow, /release\/dsh-codex-desktop-\*-win-x64\.exe/)
  assert.match(workflow, /release\/dsh-codex-desktop-\*-win-x64\.zip/)
  assert.doesNotMatch(workflow, /release\/\*\*/)
})
