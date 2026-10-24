// Narrow bridge: the renderer can only invoke named methods (validated in the main process)
// and subscribe to push events. No Node APIs, file paths, or credentials are exposed.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  invoke: (method: string, input?: unknown) => ipcRenderer.invoke('relay:invoke', method, input),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on('relay:event', listener)
    return () => {
      ipcRenderer.removeListener('relay:event', listener)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('relay', api)

export type RelayBridge = typeof api
