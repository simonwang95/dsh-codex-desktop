import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractTarGz, verifyFileSha256 } from './runtime-archive.js'
import { stageRuntimeCandidate } from './runtime-manager.js'

/** 校验随包归档并安装到版本化候选目录；这里只 staging，不切换 current。 */
export async function extractPackagedRuntimeCandidate(
  resourcesDir: string,
  runtimeRoot: string,
  version: string,
): Promise<string | undefined> {
  const archive = join(resourcesDir, 'dsh-runtime.tgz')
  if (!existsSync(archive)) return undefined
  verifyFileSha256(archive)
  return stageRuntimeCandidate({
    root: runtimeRoot,
    version,
    install: directory => { extractTarGz(archive, directory) },
  })
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const installDir = process.argv[2] ?? dirname(dirname(self))
  const resourcesDir = process.argv[3] ?? join(installDir, 'resources')
  const version = process.argv[4]
  if (version === undefined) throw new Error('安装阶段缺少 DSH 运行时版本参数。')
  await extractPackagedRuntimeCandidate(resourcesDir, join(installDir, 'dsh-runtime'), version)
}
