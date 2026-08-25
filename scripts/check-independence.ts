import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(import.meta.dirname, '..', '..')
const forbiddenOwner = ['micheng', 'ai'].join('')
const activeRoots = ['package.json', 'src', 'scripts', 'build', 'assets/about.html', '.github/workflows', 'README.md', 'README.zh-CN.md']
const legacyAllowlist = new Map([
  ['src/bundled-plugins.ts', ['SUITE_PACKAGE']],
])

export async function independenceViolations(root = projectRoot): Promise<string[]> {
  const violations: string[] = []
  for (const activeRoot of activeRoots) {
    const path = join(root, activeRoot)
    if (!existsSync(path)) continue
    for (const file of await filesUnder(path)) {
      const name = relative(root, file).replaceAll('\\', '/')
      if (name === 'scripts/check-independence.ts') continue
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      lines.forEach((line, index) => {
        const normalized = line.toLowerCase()
        if (!normalized.includes(forbiddenOwner) && !normalized.includes(`@${forbiddenOwner}/`)) return
        const allowedMarkers = legacyAllowlist.get(name) ?? []
        if (allowedMarkers.some(marker => line.includes(marker))) return
        violations.push(`${name}:${index + 1}`)
      })
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    build?: { publish?: unknown; extraResources?: Array<{ from?: string }> }
  }
  if (manifest.build?.publish !== undefined) violations.push('package.json:build.publish')
  if (manifest.build?.extraResources?.some(item => item.from?.startsWith('runtime-plugins'))) {
    violations.push('package.json:runtime-plugins')
  }
  const bundledScope = join(root, 'runtime-plugins', 'store', 'v11', 'files')
  if (existsSync(bundledScope)) violations.push('runtime-plugins:default-store-present')
  return violations
}

async function filesUnder(path: string): Promise<string[]> {
  if ((await stat(path)).isFile()) return [path]
  const files: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue
    const candidate = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(candidate))
    else if (entry.isFile() && /\.(?:c?m?[jt]s|json|ya?ml|md|html|nsh|ps1)$/.test(entry.name)) files.push(candidate)
  }
  return files
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await independenceViolations()
  if (violations.length > 0) throw new Error(`独立性闸门失败：${violations.join('、')}`)
  console.log('独立性闸门通过：默认构建、运行与更新配置没有旧 owner 依赖。')
}
