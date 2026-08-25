interface DesktopNavigationState {
  canBack: boolean
  canForward: boolean
  canNextChat: boolean
  canPreviousChat: boolean
  supportedActions: string[]
}

interface SessionList {
  ids: string[]
  current?: string
}

interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): void
  layout: { toggleSidebar(): void }
  sessions: {
    list: { getSnapshot(): SessionList; subscribe(listener: () => void): () => void }
    open(id: string): void
  }
  workspaces: {
    create(input: { path: string }): Promise<{ id?: string; workspaceId?: string } | string>
    pickDirectory(): Promise<string | null>
    startSession(workspaceId?: string): void
  }
}

interface DesktopShellBridge {
  onAction(listener: (id: string) => void): () => void
  reportState(state: DesktopNavigationState): void
}

export function desktopBridgeClientFactory(): { apply(ctx: ClientContext): void; inject: string[] } {
    const inject = ['sessions', 'workspaces', 'layout']

    const apply = (ctx: ClientContext): void => {
      const bridge = (window as Window & { dshDesktopShell?: DesktopShellBridge }).dshDesktopShell
      if (bridge === undefined) return
      let history: string[] = []
      let historyIndex = -1

      const snapshot = (): SessionList => ctx.sessions.list.getSnapshot()
      const report = (): void => {
        const sessions = snapshot()
        const currentIndex = sessions.current === undefined ? -1 : sessions.ids.indexOf(sessions.current)
        bridge.reportState({
          canBack: historyIndex > 0,
          canForward: historyIndex >= 0 && historyIndex < history.length - 1,
          canPreviousChat: currentIndex > 0,
          canNextChat: currentIndex >= 0 && currentIndex < sessions.ids.length - 1,
          supportedActions: ['new-chat', 'open-folder', 'toggle-sidebar', 'previous-chat', 'next-chat', 'back', 'forward'],
        })
      }
      const trackCurrent = (): void => {
        const current = snapshot().current
        if (current !== undefined && history[historyIndex] !== current) {
          history = history.slice(0, historyIndex + 1)
          history.push(current)
          historyIndex = history.length - 1
        }
        queueMicrotask(report)
      }
      const openHistory = (offset: number): void => {
        const next = historyIndex + offset
        const id = history[next]
        if (id === undefined) return
        historyIndex = next
        ctx.sessions.open(id)
        queueMicrotask(report)
      }
      const openAdjacent = (offset: number): void => {
        const sessions = snapshot()
        const index = sessions.current === undefined ? -1 : sessions.ids.indexOf(sessions.current)
        const id = sessions.ids[index + offset]
        if (id !== undefined) ctx.sessions.open(id)
        queueMicrotask(report)
      }
      const openFolder = async (): Promise<void> => {
        const path = await ctx.workspaces.pickDirectory()
        if (path === null) return
        const created = await ctx.workspaces.create({ path })
        const workspaceId = typeof created === 'string'
          ? created
          : typeof created === 'object' && created !== null
            ? created.id ?? created.workspaceId
            : undefined
        if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
          throw new Error('创建工作区后未返回有效的 workspaceId。')
        }
        ctx.workspaces.startSession(workspaceId)
      }
      const onAction = (id: string): void => {
        // Omitting the id inherits the selected Session's Workspace, exactly like
        // the DSH “新建任务” control.
        if (id === 'new-chat') ctx.workspaces.startSession()
        else if (id === 'open-folder') void openFolder().catch(error => { console.error('打开文件夹失败。', error) })
        else if (id === 'toggle-sidebar') ctx.layout.toggleSidebar()
        else if (id === 'previous-chat') openAdjacent(-1)
        else if (id === 'next-chat') openAdjacent(1)
        else if (id === 'back') openHistory(-1)
        else if (id === 'forward') openHistory(1)
      }

      ctx.effect(() => {
        const stopAction = bridge.onAction(onAction)
        const stopList = ctx.sessions.list.subscribe(trackCurrent)
        trackCurrent()
        return () => { stopAction(); stopList() }
      }, 'desktop-shell bridge')
    }

    return { apply, inject }
}

export function desktopBridgeClientBundle(): string {
  return `window.__ModuleLoader__.load({id:'dsh-desktop-bridge',factory:${desktopBridgeClientFactory.toString()}});\n`
}
