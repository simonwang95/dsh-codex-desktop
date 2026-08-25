import { app, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, nativeImage, net, protocol, session, shell, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DESKTOP_APP_NAME, DESKTOP_APP_USER_MODEL_ID, resolveDesktopRuntimeDir, resolveDesktopUserDataDir } from './app-identity.js'
import { OFFICIAL_DSH_VERSION, compareReleaseVersions } from './bundled-plugins.js'
import { resolveAppIconPath, resolveCompactIconCrop, resolveRasterIconPath, TRAY_ICON_SIZE } from './app-icon.js'
import { WINDOW_ICON_PIXEL_SIZES, isLoopbackFaviconRequest } from './window-icon.js'
import { quitDesktopApp, shouldHideInsteadOfClose } from './app-lifecycle.js'
import type { DshServer, StartDshOptions } from './dsh-process.js'
import { isExternalOpenUrl, isSameOrigin } from './navigation.js'
import { applyPendingProfileUpdates, ensureProfileScaffold, resolvePnpmStoreDir, seedBundledPlugins, resolveWebProfileDir } from './plugin-seed.js'
import { parseUnresolvedBundleError, removeProfileBundle, startWithProfileSelfRepair } from './profile-repair.js'
import { resolveBundledPluginStore, resolvePluginBinDir } from './plugin-toolchain.js'
import { resolveDshBootstrap, resolveDshRuntime, resolveNodeExecutable } from './runtime.js'
import { extractPackagedRuntimeCandidate } from './extract-runtime.js'
import { resolvePrebuiltOfficialRuntime } from './runtime-prebuilt.js'
import { applyInitialWindowState } from './window-state.js'
import { WindowNavigationCoordinator } from './window-navigation.js'
import { installDesktopBridge, resolveDesktopBridgeDir } from './desktop-host.js'
import { isChineseLocale, localizedShellActions, localizedShellMenus, shellActionForShortcut, SHELL_ACTIONS, type ShellActionId, type ShellMenuId } from './shell-actions.js'
import { SHELL_BAR_HEIGHT, SHELL_IPC, type DshNavigationState, type DshShellActionId, type ShellBootstrap, type ShellMenuPopupRequest, type ShellState } from './shell-contract.js'
import { mayGetShellBootstrap, mayInvokeShellAction, mayPopupShellMenu, mayReportDshState, type ShellRendererKind } from './shell-ipc-policy.js'
import { watchProfileActivation } from './profile-watch.js'
import updater from 'electron-updater'
import { buildDesktopTrayItems, desktopUpdateChannel, desktopUpdatePrompt, formatDesktopReleaseNotes, publicDesktopUpdateError, type DesktopUpdateStatus } from './desktop-updater.js'
import { resolveProductConfig, type ProductConfig } from './product-config.js'
import { activateRuntime, currentRuntimeDir, currentRuntimeVersion, markCurrentRuntimeHealthy, readRuntimeState, rollbackPendingActivation, rollbackRuntime } from './runtime-manager.js'

interface DshProcessModule {
  isApplyPluginUpdatesIpc: (message: unknown) => boolean
  startDsh: (options: StartDshOptions) => Promise<DshServer>
}

const dshProcessModule = await import(app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, 'desktop-bridge', 'dsh-process.js')).href
  : './dsh-process.js') as DshProcessModule
const { isApplyPluginUpdatesIpc, startDsh } = dshProcessModule

let mainWindow: BrowserWindow | undefined
let dshView: WebContentsView | undefined
let shortcutsWindow: BrowserWindow | undefined
let aboutWindow: BrowserWindow | undefined
let server: DshServer | undefined
let tray: Tray | undefined
let isQuitting = false
let isRecycling = false
let lastStartOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> | undefined
let lastSeedOptions: Parameters<typeof applyPendingProfileUpdates>[0] | undefined
let profileWatcher: { stop: () => void; sync: () => void } | undefined
let updateStatus: DesktopUpdateStatus = { kind: 'idle' }
let productConfig: ProductConfig = {}
let activeRuntimeVersion = OFFICIAL_DSH_VERSION
const { autoUpdater } = updater
let isReportingUnexpectedError = false
const windowNavigation = new WindowNavigationCoordinator()
let dshNavigationState: DshNavigationState = { canBack: false, canForward: false, canNextChat: false, canPreviousChat: false, supportedActions: [] }
const shellActionIds = new Set<string>(SHELL_ACTIONS.map(action => action.id))

process.on('uncaughtException', handleUnexpectedMainError)
process.on('unhandledRejection', handleUnexpectedMainError)

app.setName(DESKTOP_APP_NAME)
app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID)
if (!process.argv.some(argument => argument.startsWith('--user-data-dir='))) {
  app.setPath('userData', resolveDesktopUserDataDir(app.getPath('appData')))
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'dsh-icon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => showMainWindow())
  app.on('before-quit', event => {
    if (isQuitting) return
    event.preventDefault()
    runMainTask(requestQuit())
  })

  runMainTask(startApplication())
}

async function requestQuit(): Promise<void> {
  await shutdownDesktop(() => app.exit())
}

async function shutdownDesktop(exit: () => void): Promise<void> {
  await quitDesktopApp({
    isQuitting,
    markQuitting: () => { isQuitting = true },
    destroyTray: () => {
      tray?.destroy()
      tray = undefined
      profileWatcher?.stop()
      profileWatcher = undefined
    },
    stopServer: async () => {
      const current = server
      server = undefined
      await current?.stop()
    },
    exit,
  })
}

async function startApplication(): Promise<void> {
  await app.whenReady()
  productConfig = resolveProductConfig({ configPath: join(process.resourcesPath, 'product-config.json') })
  installShellIpc()
  installDesktopFaviconReplacement()
  Menu.setApplicationMenu(null)
  configureDesktopUpdater()
  createTray()
  await showStartupWindow('加载中')

  try {
    const runtimeOptions = {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }
    const pathPrefix = resolvePluginBinDir(runtimeOptions)
    const pnpmEntry = pathPrefix === undefined ? process.env.npm_execpath : join(pathPrefix, 'pnpm-package', 'bin', 'pnpm.cjs')
    const profileDir = resolveWebProfileDir()
    const desktopRuntimeDir = resolveDesktopRuntimeDir(app.getPath('userData'), {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
    })
    rollbackPendingActivation(desktopRuntimeDir)
    if (app.isPackaged) {
      await extractPackagedRuntimeCandidate(process.resourcesPath, desktopRuntimeDir, OFFICIAL_DSH_VERSION)
    }
    const pluginStoreDir = resolveBundledPluginStore({
      ...runtimeOptions,
    })
    const profileStoreDir = resolvePnpmStoreDir(profileDir, pluginStoreDir)
    const prebuiltRuntimeDir = resolvePrebuiltOfficialRuntime(runtimeOptions)
    const nodeExecutable = resolveNodeExecutable(runtimeOptions)
    const validateRuntimeCandidate = (candidateDir: string): Promise<void> => validateRuntimeCandidateHealth({
      candidateDir,
      nodeExecutable,
      pathPrefix,
      runtimeOptions,
    })
    const seedOptions = {
      nodeExecutable,
      profileDir,
      desktopRuntimeDir,
      pluginStoreDir: pluginStoreDir ?? '',
      validateRuntimeCandidate,
      ...(prebuiltRuntimeDir === undefined ? {} : { prebuiltRuntimeDir }),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
    }
    const installedVersion = currentRuntimeVersion(desktopRuntimeDir)
    if (installedVersion !== undefined && compareReleaseVersions(OFFICIAL_DSH_VERSION, installedVersion) > 0) {
      const prompt = await dialog.showMessageBox({
        type: 'question',
        title: DESKTOP_APP_NAME,
        message: `安装包包含 DSH ${OFFICIAL_DSH_VERSION}，当前为 ${installedVersion}。是否先隔离验证并升级？`,
        buttons: ['验证并升级', '继续使用当前版本'],
        defaultId: 1,
        cancelId: 1,
      })
      if (prompt.response === 0) {
        const candidate = join(desktopRuntimeDir, 'versions', OFFICIAL_DSH_VERSION)
        await validateRuntimeCandidate(candidate)
        activateRuntime(desktopRuntimeDir, OFFICIAL_DSH_VERSION)
      }
    }
    try {
      const seeded = await seedBundledPlugins(seedOptions)
      if (seeded.seeded.length > 0) console.log(`已补种官方运行时和社区插件：${seeded.seeded.join('、')}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '内置插件补种失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-seed.log'), `${message}\n`, 'utf8').catch(() => undefined)
    }
    try {
      const updated = await applyPendingProfileUpdates(seedOptions)
      if (updated.length > 0) console.log('已在启动前应用插件更新：' + updated.join('、'))
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动前应用插件更新失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-update.log'), ` ${message}\n`, 'utf8').catch(() => undefined)

    }
    installDesktopBridge(profileDir, resolveDesktopBridgeDir(runtimeOptions))
    lastSeedOptions = seedOptions
    const activeRuntimeDir = currentRuntimeDir(desktopRuntimeDir)
    if (activeRuntimeDir === undefined) throw new Error('没有可启动的 current DSH 运行时。')
    activeRuntimeVersion = currentRuntimeVersion(desktopRuntimeDir) ?? OFFICIAL_DSH_VERSION
    const runtime = resolveDshRuntime({ ...runtimeOptions, profileDir, desktopRuntimeDir: activeRuntimeDir })
    let startOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> = {
      bootstrapPath: resolveDshBootstrap(runtimeOptions),
      ...(pathPrefix === undefined ? {} : { pathPrefix }),
      runtime,
      nodeExecutable,
      environment: {
        DSH_HOME: resolve(profileDir, '..', '..'),
        DSH_PROFILE_DIR: profileDir,
        DSH_PROFILE_NAME: 'web',
        DSH_RUNTIME_DIR: desktopRuntimeDir,
        DSH_BUNDLED_DSH_VERSION: OFFICIAL_DSH_VERSION,
        ...(pnpmEntry === undefined ? {} : { DSH_PNPM_ENTRY: pnpmEntry }),
        ...(profileStoreDir === undefined ? {} : { DSH_PNPM_STORE_DIR: profileStoreDir }),
      },
    }
    const managed = await startManagedRuntime(startOptions, seedOptions)
    startOptions = managed.startOptions
    lastStartOptions = startOptions
    const started = managed.started
    server = started.result
    if (started.repaired.length > 0) console.log('已自我修复损坏的插件清单：' + started.repaired.join('、'))
    profileWatcher?.stop()
    profileWatcher = watchProfileActivation(profileDir, () => {
      if (isQuitting || isRecycling) return
      runMainTask(recycleDshForPluginUpdate())
    }, { onError: handleUnexpectedMainError })
    await createMainWindow(server.url)
    if (process.argv.includes('--smoke-test')) {
      console.log(`DSH_SMOKE_READY ${server.url}`)
      setTimeout(() => { runMainTask(requestQuit()) }, 5_000).unref?.()
    }
  } catch (error) {
    await reportStartupFailure(error)
  }
}

async function validateRuntimeCandidateHealth(options: {
  candidateDir: string
  nodeExecutable: string
  pathPrefix?: string
  runtimeOptions: { appPath: string; isPackaged: boolean; resourcesPath: string }
}): Promise<void> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-health-'))
  const profileDir = join(isolatedRoot, 'profiles', 'web')
  let candidateServer: DshServer | undefined
  try {
    await ensureProfileScaffold(profileDir)
    installDesktopBridge(profileDir, resolveDesktopBridgeDir(options.runtimeOptions))
    const runtime = resolveDshRuntime({ ...options.runtimeOptions, profileDir, desktopRuntimeDir: options.candidateDir })
    candidateServer = await startDsh({
      bootstrapPath: resolveDshBootstrap(options.runtimeOptions),
      runtime,
      nodeExecutable: options.nodeExecutable,
      ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
      environment: {
        DSH_HOME: isolatedRoot,
        DSH_PROFILE_DIR: profileDir,
        DSH_PROFILE_NAME: 'web',
        DSH_RUNTIME_DIR: options.candidateDir,
        DSH_BUNDLED_DSH_VERSION: OFFICIAL_DSH_VERSION,
      },
    })
  } finally {
    await candidateServer?.stop().catch(() => undefined)
    await rm(isolatedRoot, { recursive: true, force: true })
  }
}

async function startManagedRuntime(
  baseStartOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'>,
  seedOptions: Parameters<typeof applyPendingProfileUpdates>[0],
): Promise<{
  startOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'>
  started: { result: DshServer; repaired: string[] }
}> {
  const runtimeRoot = seedOptions.desktopRuntimeDir
  if (runtimeRoot === undefined) throw new Error('未配置受管 DSH 运行时根目录。')
  const resolveStartOptions = (): Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'> => {
    const activeDir = currentRuntimeDir(runtimeRoot)
    if (activeDir === undefined) throw new Error('current DSH 运行时不可启动。')
    return {
      ...baseStartOptions,
      runtime: resolveDshRuntime({
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        profileDir: seedOptions.profileDir,
        desktopRuntimeDir: activeDir,
      }),
    }
  }
  const launch = (startOptions: Omit<StartDshOptions, 'onUnexpectedExit' | 'onIpcMessage'>) => startWithProfileSelfRepair({
    profileDir: seedOptions.profileDir,
    extraDirs: [startOptions.runtime.root],
    start: () => startDsh({
      ...startOptions,
      onUnexpectedExit: handleUnexpectedDshExit,
      onIpcMessage: handleDshIpc,
    }),
  })

  let startOptions = resolveStartOptions()
  let started: Awaited<ReturnType<typeof launch>>
  try {
    started = await launch(startOptions)
  } catch (error) {
    const state = readRuntimeState(runtimeRoot)
    if (state.activationPending !== true || state.lastKnownGood === undefined) throw error
    const fallback = rollbackRuntime(runtimeRoot, 'first-real-start', error)
    await writeTextFile(join(app.getPath('userData'), 'runtime-upgrade.log'), '首次真实启动失败，已回滚 last-known-good。\n', 'utf8').catch(() => undefined)
    if (fallback === undefined) throw error
    startOptions = resolveStartOptions()
    started = await launch(startOptions)
  }
  markCurrentRuntimeHealthy(runtimeRoot)
  activeRuntimeVersion = currentRuntimeVersion(runtimeRoot) ?? OFFICIAL_DSH_VERSION
  return { startOptions, started }
}

function resolveStartupHtml(): string | undefined {
  const packaged = join(process.resourcesPath, 'startup.html')
  const dev = join(app.getAppPath(), 'assets', 'startup.html')
  if (existsSync(packaged)) return packaged
  if (existsSync(dev)) return dev
  return undefined
}

let cachedWindowIcon: Electron.NativeImage | undefined

function resolveWindowIconFilePath(): string | undefined {
  return resolveRasterIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  }) ?? resolveWindowIconPath()
}

function resolveWindowIconImage(): Electron.NativeImage | undefined {
  if (cachedWindowIcon !== undefined && !cachedWindowIcon.isEmpty()) return cachedWindowIcon
  const iconPath = resolveWindowIconFilePath()
  if (iconPath === undefined) return undefined
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) return undefined
  const compactSource = source.crop(resolveCompactIconCrop(source.getSize()))
  const icon = nativeImage.createEmpty()
  for (const size of WINDOW_ICON_PIXEL_SIZES) {
    const resized = compactSource.resize({ width: size, height: size, quality: 'best' })
    icon.addRepresentation({
      width: size,
      height: size,
      buffer: resized.toPNG(),
      scaleFactor: 1,
    })
  }
  cachedWindowIcon = icon.isEmpty() ? source : icon
  return cachedWindowIcon
}

function installDesktopFaviconReplacement(): void {
  const iconPath = resolveWindowIconFilePath()
  if (iconPath === undefined) return
  const iconUrl = pathToFileURL(iconPath).href
  protocol.handle('dsh-icon', () => net.fetch(iconUrl))
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!isLoopbackFaviconRequest(details.url)) {
      callback({})
      return
    }
    callback({ redirectURL: 'dsh-icon://app/favicon.ico' })
  })
}

async function showStartupWindow(message: string): Promise<void> {
  const window = mainWindow ??= createWindow()
  const view = requireDshView()
  const html = resolveStartupHtml()
  if (html !== undefined) {
    await windowNavigation.navigate(
      view,
      () => view.webContents.loadFile(html),
      () => view.webContents.executeJavaScript('document.getElementById("msg").textContent = ' + JSON.stringify(message)),
    )
    return
  }
  const escaped = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
  await windowNavigation.navigate(
    view,
    () => view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main style="font-family:sans-serif;padding:48px"><h1>DSH Codex Desktop</h1><p>' + escaped + '</p></main>')),
  )
}

let allowedOrigin = ''

async function createMainWindow(serverUrl: string): Promise<void> {
  allowedOrigin = new URL(serverUrl).origin
  mainWindow ??= createWindow()
  const view = requireDshView()
  await windowNavigation.navigate(view, () => view.webContents.loadURL(serverUrl))
}

async function reportStartupFailure(error: unknown): Promise<void> {
  const logPath = join(app.getPath('userData'), 'startup-error.log')
  const message = error instanceof Error ? error.message : '未知启动错误。'
  await writeTextFile(logPath, message + '\n', 'utf8').catch(() => undefined)
  const short = message.split(/\r?\n/)[0]?.slice(0, 240) ?? '未知启动错误。'
  try {
    await showStartupWindow('启动失败：' + short + '\n日志：' + logPath)
  } catch (displayError) {
    console.error('显示启动错误页面失败。', displayError)
  }
}

function handleUnexpectedMainError(error: unknown): void {
  console.error('主进程发生未处理异常。', error)
  if (!app.isReady() || isQuitting || isReportingUnexpectedError) return
  isReportingUnexpectedError = true
  void reportStartupFailure(error)
    .catch(reportError => { console.error('主进程异常报告失败。', reportError) })
    .finally(() => { isReportingUnexpectedError = false })
}

function runMainTask(task: Promise<unknown>): void {
  void task.catch(handleUnexpectedMainError)
}


function handleDshIpc(message: unknown): void {
  if (!isApplyPluginUpdatesIpc(message)) return
  runMainTask(recycleDshForPluginUpdate())
}

async function recycleDshForPluginUpdate(): Promise<void> {
  if (isQuitting || isRecycling || lastStartOptions === undefined || lastSeedOptions === undefined) return
  const startOptions = lastStartOptions
  const seedOptions = lastSeedOptions
  isRecycling = true
  broadcastShellState()
  try {
    await showStartupWindow('加载中')
    const current = server
    server = undefined
    await current?.stop()
    try {
      const updated = await applyPendingProfileUpdates(seedOptions)
      if (updated.length > 0) console.log('已热更新插件：' + updated.join('、'))
    } catch (error) {
      const message = error instanceof Error ? error.message : '运行时或插件升级失败。'
      await writeTextFile(join(app.getPath('userData'), 'plugin-update.log'), `${message}\n`, 'utf8').catch(() => undefined)
      console.error('升级失败，继续启动 current 运行时。', error)
    }
    const managed = await startManagedRuntime(startOptions, seedOptions)
    lastStartOptions = managed.startOptions
    server = managed.started.result
    await createMainWindow(server.url)
  } catch (error) {
    await reportStartupFailure(error)
  } finally {
    profileWatcher?.sync()
    isRecycling = false
    broadcastShellState()
  }
}

function handleUnexpectedDshExit(message: string): void {
  if (isQuitting || isRecycling) return
  server = undefined
  const missing = parseUnresolvedBundleError(message)
  if (missing !== undefined && lastSeedOptions !== undefined) {
    runMainTask(removeProfileBundle(lastSeedOptions.profileDir, missing).then((removed) => {
      if (removed) runMainTask(recycleDshForPluginUpdate())
    }))
    return
  }
  void writeTextFile(join(app.getPath('userData'), 'startup-error.log'), `${message}\n`, 'utf8').catch(() => undefined)
  runMainTask(showStartupWindow('DSH 已停止运行。请重新启动应用。'))
}

function resolveWindowIconPath(): string | undefined {
  return resolveAppIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
}

function resolveShellAsset(name: 'shell.html' | 'shortcuts.html' | 'about.html'): string {
  const packaged = join(process.resourcesPath, name)
  return existsSync(packaged) ? packaged : join(app.getAppPath(), 'assets', name)
}

function resolvePreload(name: 'shell-preload.cjs' | 'dsh-view-preload.cjs'): string {
  return join(app.getAppPath(), 'dist', 'src', name)
}

function requireDshView(): WebContentsView {
  if (dshView === undefined) throw new Error('DSH 内容视图尚未创建。')
  return dshView
}

function layoutDshView(window: BrowserWindow): void {
  const bounds = window.getContentBounds()
  dshView?.setBounds({ x: 0, y: SHELL_BAR_HEIGHT, width: bounds.width, height: Math.max(0, bounds.height - SHELL_BAR_HEIGHT) })
}

function createWindow(): BrowserWindow {
  const windowIcon = resolveWindowIconImage()
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: true,
    title: DESKTOP_APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#1c1f1e', symbolColor: '#d7d9d8', height: SHELL_BAR_HEIGHT } }),
    ...(windowIcon === undefined ? {} : { icon: windowIcon }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolvePreload('shell-preload.cjs'),
      sandbox: true,
    },
  })
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: resolvePreload('dsh-view-preload.cjs'),
    sandbox: true,
  } })
  dshView = view
  window.contentView.addChildView(view)
  layoutDshView(window)
  window.on('resize', () => layoutDshView(window))
  window.on('maximize', () => layoutDshView(window))
  window.on('unmaximize', () => layoutDshView(window))
  runMainTask(window.loadFile(resolveShellAsset('shell.html')))

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, url) => {
    if (windowNavigation.isNavigating()) {
      event.preventDefault()
      return
    }
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
  })
  view.webContents.on('will-redirect', (event, url) => {
    if (isSameOrigin(url, allowedOrigin)) return
    event.preventDefault()
    if (isExternalOpenUrl(url, allowedOrigin)) runMainTask(shell.openExternal(url))
  })
  installShortcutHandler(window.webContents)
  installShortcutHandler(view.webContents)
  applyInitialWindowState(window)
  window.on('enter-full-screen', broadcastShellState)
  window.on('leave-full-screen', broadcastShellState)
  window.on('close', event => {
    if (!shouldHideInsteadOfClose(isQuitting)) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
      dshView = undefined
    }
  })
  return window
}

function currentShellState(): ShellState {
  const window = mainWindow
  const zoomFactor = dshView?.webContents.getZoomFactor() ?? 1
  return {
    ...dshNavigationState,
    fullscreen: window?.isFullScreen() ?? false,
    reloading: isRecycling,
    zoomPercent: Math.round(zoomFactor * 100),
  }
}

function shellBootstrap(): ShellBootstrap {
  const locale = app.getLocale()
  return {
    actions: localizedShellActions(locale, process.platform),
    locale,
    menus: localizedShellMenus(locale),
    platform: process.platform,
    runtimeVersion: activeRuntimeVersion,
    state: currentShellState(),
    version: app.getVersion(),
  }
}

function broadcastShellState(): void {
  const state = currentShellState()
  for (const window of [mainWindow, shortcutsWindow, aboutWindow]) {
    if (window !== undefined && !window.isDestroyed()) window.webContents.send(SHELL_IPC.state, state)
  }
}

function installShellIpc(): void {
  ipcMain.removeHandler(SHELL_IPC.getBootstrap)
  ipcMain.removeHandler(SHELL_IPC.action)
  ipcMain.removeHandler(SHELL_IPC.popupMenu)
  ipcMain.handle(SHELL_IPC.getBootstrap, event => {
    if (!mayGetShellBootstrap(shellRendererKind(event.sender))) return
    return shellBootstrap()
  })
  ipcMain.handle(SHELL_IPC.action, (event, id: unknown) => {
    if (typeof id !== 'string' || !shellActionIds.has(id)) return
    const actionId = id as ShellActionId
    if (!mayInvokeShellAction(shellRendererKind(event.sender), actionId)) return
    return executeShellAction(actionId)
  })
  ipcMain.handle(SHELL_IPC.popupMenu, (event, request: ShellMenuPopupRequest) => {
    if (!mayPopupShellMenu(shellRendererKind(event.sender))) return
    return popupShellMenu(request)
  })
  ipcMain.removeAllListeners(SHELL_IPC.dshState)
  ipcMain.on(SHELL_IPC.dshState, (event, state: Partial<DshNavigationState>) => {
    if (!mayReportDshState(shellRendererKind(event.sender))) return
    if (typeof state !== 'object' || state === null) return
    dshNavigationState = {
      canBack: state.canBack === true,
      canForward: state.canForward === true,
      canNextChat: state.canNextChat === true,
      canPreviousChat: state.canPreviousChat === true,
      supportedActions: Array.isArray(state.supportedActions)
        ? state.supportedActions.filter((id): id is string => typeof id === 'string' && shellActionIds.has(id))
        : [],
    }
    broadcastShellState()
  })
}

function shellRendererKind(sender: WebContents): ShellRendererKind {
  if (sender === mainWindow?.webContents) return 'main'
  if (sender === shortcutsWindow?.webContents) return 'shortcuts'
  if (sender === aboutWindow?.webContents) return 'about'
  if (sender === dshView?.webContents) return 'dsh'
  return 'unknown'
}

function isActionEnabled(id: ShellActionId): boolean {
  if (id === 'reload') return !isRecycling && lastStartOptions !== undefined && lastSeedOptions !== undefined
  if (id === 'back') return dshNavigationState.canBack
  if (id === 'forward') return dshNavigationState.canForward
  if (id === 'previous-chat') return dshNavigationState.canPreviousChat
  if (id === 'next-chat') return dshNavigationState.canNextChat
  if (id === 'new-chat' || id === 'open-folder' || id === 'settings' || id === 'toggle-sidebar' || id === 'find') {
    return dshNavigationState.supportedActions.includes(id)
  }
  if (id === 'check-updates') return productConfig.desktopUpdateUrl !== undefined
  if (id === 'whats-new') return productConfig.releaseNotesUrl !== undefined
  if (id === 'feedback') return productConfig.feedbackUrl !== undefined
  return true
}

function popupShellMenu(request: ShellMenuPopupRequest): void {
  if (request === null || typeof request !== 'object') return
  if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) return
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  const menuId = request.menu as ShellMenuId
  const actions = localizedShellActions(app.getLocale(), process.platform).filter(action => action.menu === menuId)
  if (actions.length === 0) return
  const template: MenuItemConstructorOptions[] = []
  let group = actions[0]?.group
  for (const action of actions) {
    if (group !== undefined && action.group !== group) template.push({ type: 'separator' })
    group = action.group
    template.push({
      label: action.label,
      enabled: isActionEnabled(action.id),
      ...(action.acceleratorLabel === undefined ? {} : { accelerator: action.acceleratorLabel }),
      click: () => { runMainTask(Promise.resolve(executeShellAction(action.id))) },
    })
  }
  Menu.buildFromTemplate(template).popup({
    window,
    x: Math.round(request.x),
    y: Math.round(request.y),
  })
}

function installShortcutHandler(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input: Input) => {
    if (input.type !== 'keyDown') return
    const id = shellActionForShortcut(input, process.platform)
    if (id === undefined || !isActionEnabled(id)) return
    event.preventDefault()
    const auxiliaryWindow = [shortcutsWindow, aboutWindow].find(window => window?.webContents === contents)
    if (id === 'close-window' && auxiliaryWindow !== undefined) {
      auxiliaryWindow.close()
      return
    }
    runMainTask(Promise.resolve(executeShellAction(id)))
  })
}

function sendDshAction(id: DshShellActionId): void {
  if (dshView !== undefined && !dshView.webContents.isDestroyed()) dshView.webContents.send(SHELL_IPC.dshAction, id)
}

async function executeShellAction(id: ShellActionId): Promise<void> {
  if (!isActionEnabled(id)) return
  const contents = dshView?.webContents
  if (id === 'new-chat' || id === 'open-folder' || id === 'settings' || id === 'toggle-sidebar' || id === 'find' || id === 'previous-chat' || id === 'next-chat' || id === 'back' || id === 'forward') {
    sendDshAction(id)
    return
  }
  if (id === 'close-window') { mainWindow?.hide(); return }
  if (id === 'quit') { await requestQuit(); return }
  if (contents === undefined) return
  if (id === 'undo') contents.undo()
  else if (id === 'redo') contents.redo()
  else if (id === 'cut') contents.cut()
  else if (id === 'copy') contents.copy()
  else if (id === 'paste') contents.paste()
  else if (id === 'delete') contents.delete()
  else if (id === 'select-all') contents.selectAll()
  else if (id === 'zoom-in') contents.setZoomFactor(Math.min(2, contents.getZoomFactor() + 0.1))
  else if (id === 'zoom-out') contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() - 0.1))
  else if (id === 'zoom-reset') contents.setZoomFactor(1)
  else if (id === 'toggle-fullscreen') mainWindow?.setFullScreen(!(mainWindow?.isFullScreen() ?? false))
  else if (id === 'show-shortcuts') showShortcutsWindow()
  else if (id === 'reload') await recycleDshForPluginUpdate()
  else if (id === 'check-updates') await checkDesktopUpdate()
  else if (id === 'whats-new' && productConfig.releaseNotesUrl !== undefined) await shell.openExternal(productConfig.releaseNotesUrl)
  else if (id === 'feedback' && productConfig.feedbackUrl !== undefined) await shell.openExternal(productConfig.feedbackUrl)
  else if (id === 'about') showAboutWindow()
  broadcastShellState()
}

function showShortcutsWindow(): void {
  if (shortcutsWindow !== undefined && !shortcutsWindow.isDestroyed()) {
    shortcutsWindow.show(); shortcutsWindow.focus(); return
  }
  const window = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 620,
    height: 650,
    minWidth: 520,
    minHeight: 480,
    title: isChineseLocale(app.getLocale()) ? '键盘快捷键' : 'Keyboard Shortcuts',
    autoHideMenuBar: true,
    backgroundColor: '#262827',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  shortcutsWindow = window
  window.on('closed', () => { if (shortcutsWindow === window) shortcutsWindow = undefined })
  installShortcutHandler(window.webContents)
  runMainTask(window.loadFile(resolveShellAsset('shortcuts.html')))
}

function showAboutWindow(): void {
  if (aboutWindow !== undefined && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return
  }
  const icon = resolveWindowIconImage()
  const window = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 560,
    height: 680,
    minWidth: 560,
    minHeight: 680,
    maxWidth: 560,
    maxHeight: 680,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: isChineseLocale(app.getLocale()) ? `关于 ${DESKTOP_APP_NAME}` : `About ${DESKTOP_APP_NAME}`,
    autoHideMenuBar: true,
    backgroundColor: '#202322',
    ...(icon === undefined ? {} : { icon }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: resolvePreload('shell-preload.cjs'), sandbox: true },
  })
  aboutWindow = window
  window.on('closed', () => { if (aboutWindow === window) aboutWindow = undefined })
  installShortcutHandler(window.webContents)
  runMainTask(window.loadFile(resolveShellAsset('about.html')))
}

function configureDesktopUpdater(): void {
  if (productConfig.desktopUpdateUrl === undefined) return
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.setFeedURL({ provider: 'generic', url: productConfig.desktopUpdateUrl })
  const channel = desktopUpdateChannel()
  if (channel !== undefined) {
    autoUpdater.channel = channel
    autoUpdater.allowDowngrade = false
  }
  autoUpdater.on('download-progress', progress => {
    updateStatus = { kind: 'downloading', percent: progress.percent }
    refreshTrayMenu()
  })
  autoUpdater.on('update-downloaded', info => {
    updateStatus = { kind: 'ready', version: info.version }
    refreshTrayMenu()
  })
  autoUpdater.on('error', error => {
    updateStatus = { kind: 'error', message: publicDesktopUpdateError(error) }
    refreshTrayMenu()
  })
}

function createTray(): void {
  if (tray !== undefined) {
    refreshTrayMenu()
    return
  }
  const rasterPath = resolveRasterIconPath({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  const source = rasterPath === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(rasterPath)
  const icon = source.isEmpty()
    ? nativeImage.createEmpty()
    : source
        .crop(resolveCompactIconCrop(source.getSize()))
        .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
  try {
    tray = new Tray(icon)
  } catch {
    return
  }
  tray.setToolTip(DESKTOP_APP_NAME)
  tray.on('click', () => showMainWindow())
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (tray === undefined) return
  const items = buildDesktopTrayItems({
    status: updateStatus,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    configured: productConfig.desktopUpdateUrl !== undefined,
  })
  tray.setContextMenu(Menu.buildFromTemplate(items.map(item => {
    if (item.type === 'separator') return { type: 'separator' }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => { runMainTask(handleTrayUpdateAction(item.id)) },
    }
  })))
}

async function handleTrayUpdateAction(id: string): Promise<void> {
  if (id === 'show') {
    showMainWindow()
    return
  }
  if (id === 'reload') {
    await recycleDshForPluginUpdate()
    return
  }
  if (id === 'quit') {
    await requestQuit()
    return
  }
  if (id === 'check') {
    await checkDesktopUpdate()
    return
  }
  if (id === 'download') {
    await downloadDesktopUpdate()
    return
  }
  if (id === 'install') {
    await installDesktopUpdate()
  }
}

async function checkDesktopUpdate(): Promise<void> {
  if (productConfig.desktopUpdateUrl === undefined) {
    await dialog.showMessageBox({
      type: 'info',
      title: DESKTOP_APP_NAME,
      message: '此构建未配置桌面更新源，不会联网检查更新。',
    })
    return
  }
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: DESKTOP_APP_NAME,
      message: '开发态不能检查安装包更新，请使用发布的安装包。',
    })
    return
  }
  updateStatus = { kind: 'checking' }
  refreshTrayMenu()
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version
    if (version === undefined || version === app.getVersion()) {
      updateStatus = { kind: 'none' }
      refreshTrayMenu()
      await dialog.showMessageBox({
        type: 'info',
        title: DESKTOP_APP_NAME,
        message: '当前已是最新桌面端版本。',
      })
      return
    }
    updateStatus = { kind: 'available', version, releaseNotes: formatDesktopReleaseNotes(result?.updateInfo.releaseNotes) }
    refreshTrayMenu()
    const prompt = await dialog.showMessageBox({
      type: 'question',
      title: DESKTOP_APP_NAME,
      message: desktopUpdatePrompt(updateStatus),
      buttons: ['下载并安装', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (prompt.response === 0) await downloadDesktopUpdate()
  } catch (error) {
    const message = publicDesktopUpdateError(error)
    updateStatus = { kind: 'error', message }
    refreshTrayMenu()
    await dialog.showMessageBox({
      type: 'error',
      title: DESKTOP_APP_NAME,
      message,
    })
  }
}

async function downloadDesktopUpdate(): Promise<void> {
  if (updateStatus.kind !== 'available') return
  const version = updateStatus.version
  updateStatus = { kind: 'downloading', percent: 0 }
  refreshTrayMenu()
  try {
    await autoUpdater.downloadUpdate()
    const ready = { kind: 'ready' as const, version }
    updateStatus = ready
    refreshTrayMenu()
    const prompt = await dialog.showMessageBox({
      type: 'question',
      title: DESKTOP_APP_NAME,
      message: desktopUpdatePrompt(ready),
      buttons: ['现在安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (prompt.response === 0) await installDesktopUpdate()
  } catch (error) {
    const message = publicDesktopUpdateError(error)
    updateStatus = { kind: 'error', message }
    refreshTrayMenu()
    await dialog.showMessageBox({
      type: 'error',
      title: DESKTOP_APP_NAME,
      message,
    })
  }
}

async function installDesktopUpdate(): Promise<void> {
  await shutdownDesktop(() => { autoUpdater.quitAndInstall(false, true) })
}

function showMainWindow(): void {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
