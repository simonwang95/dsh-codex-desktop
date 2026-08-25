const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

const IPC = {
  dshAction: 'dsh-shell:dsh-action',
  dshState: 'dsh-shell:dsh-state',
} as const

let registrationCount = 0

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send(IPC.dshState, {
    canBack: false,
    canForward: false,
    canNextChat: false,
    canPreviousChat: false,
    supportedActions: [],
  })
})

contextBridge.exposeInMainWorld('dshDesktopShell', {
  onAction: (listener: (id: string) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, id: string) => listener(id)
    registrationCount += 1
    ipcRenderer.on(IPC.dshAction, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.dshAction, wrapped)
      registrationCount = Math.max(0, registrationCount - 1)
      if (registrationCount === 0) {
        ipcRenderer.send(IPC.dshState, {
          canBack: false,
          canForward: false,
          canNextChat: false,
          canPreviousChat: false,
          supportedActions: [],
        })
      }
    }
  },
  reportState: (state: unknown) => { ipcRenderer.send(IPC.dshState, state) },
})
