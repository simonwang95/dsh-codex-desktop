import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('客户端桥接缺失或卸载后报告空能力且不猜测 DOM', async () => {
  const source = await readFile(new URL('../src/dsh-view-preload.cjs', import.meta.url), 'utf8')
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const sent: unknown[][] = []
  let domReady: (() => void) | undefined
  let exposed: { onAction(listener: (id: string) => void): () => void; reportState(state: unknown): void } | undefined
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void): void { listeners.set(channel, [...listeners.get(channel) ?? [], listener]) },
    removeListener(channel: string, listener: (...args: unknown[]) => void): void {
      listeners.set(channel, (listeners.get(channel) ?? []).filter(item => item !== listener))
    },
    send(...args: unknown[]): void { sent.push(args) },
  }
  vm.runInNewContext(source, {
    exports: {},
    module: { exports: {} },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => { exposed = api } }, ipcRenderer }),
    window: { addEventListener: (_name: string, callback: () => void) => { domReady = callback } },
  })
  domReady?.()
  assert.ok(exposed)
  const unregister = exposed.onAction(() => {})
  unregister()
  assert.equal(sent.some(args => JSON.stringify(args).includes('"supportedActions":[]')), true)
  assert.doesNotMatch(source, /querySelector|\.click\(\)|MutationObserver/)
})
