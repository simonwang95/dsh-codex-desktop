import { existsSync, readFileSync } from 'node:fs'

export interface ProductConfig {
  readonly desktopUpdateUrl?: string
  readonly feedbackUrl?: string
  readonly releaseNotesUrl?: string
}

function optionalHttpUrl(value: unknown, name: string, allowLoopbackHttp = false): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${name} 必须是 URL 字符串。`)
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw new Error(`${name} 必须使用 HTTPS${allowLoopbackHttp ? '（本机测试可用 HTTP）' : ''}。`)
  }
  return url.href
}

export function parseProductConfig(value: unknown): ProductConfig {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('产品配置必须是对象。')
  const config = value as Record<string, unknown>
  return {
    ...(optionalHttpUrl(config.desktopUpdateUrl, 'desktopUpdateUrl', true) === undefined ? {} : {
      desktopUpdateUrl: optionalHttpUrl(config.desktopUpdateUrl, 'desktopUpdateUrl', true),
    }),
    ...(optionalHttpUrl(config.feedbackUrl, 'feedbackUrl') === undefined ? {} : {
      feedbackUrl: optionalHttpUrl(config.feedbackUrl, 'feedbackUrl'),
    }),
    ...(optionalHttpUrl(config.releaseNotesUrl, 'releaseNotesUrl') === undefined ? {} : {
      releaseNotesUrl: optionalHttpUrl(config.releaseNotesUrl, 'releaseNotesUrl'),
    }),
  }
}

export function resolveProductConfig(options: {
  configPath?: string
  env?: NodeJS.ProcessEnv
} = {}): ProductConfig {
  const env = options.env ?? process.env
  let fileConfig: ProductConfig = {}
  if (options.configPath !== undefined && existsSync(options.configPath)) {
    fileConfig = parseProductConfig(JSON.parse(readFileSync(options.configPath, 'utf8')))
  }
  return parseProductConfig({
    desktopUpdateUrl: env.DSH_DESKTOP_UPDATE_URL ?? fileConfig.desktopUpdateUrl,
    feedbackUrl: env.DSH_DESKTOP_FEEDBACK_URL ?? fileConfig.feedbackUrl,
    releaseNotesUrl: env.DSH_DESKTOP_RELEASE_NOTES_URL ?? fileConfig.releaseNotesUrl,
  })
}
