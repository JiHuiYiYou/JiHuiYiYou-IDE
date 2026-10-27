import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeEvent, ClaudeStatus } from '@shared/claude'
import { IPC, type CompileRequest, type RunRequest } from '@shared/ipc'

/**
 * 渲染进程只能通过这个窄接口碰主进程能力。
 * 渲染进程本身不开 nodeIntegration，所以它拿不到 fs / child_process。
 */
const api = {
  toolchain: {
    locate: () => ipcRenderer.invoke(IPC.toolchainLocate),
    setPath: (exePath: string) => ipcRenderer.invoke(IPC.toolchainSetPath, exePath),
  },
  file: {
    openDialog: () => ipcRenderer.invoke(IPC.fileOpenDialog),
    initial: () => ipcRenderer.invoke(IPC.fileInitial),
    read: (path: string) => ipcRenderer.invoke(IPC.fileRead, path),
    write: (path: string, content: string) => ipcRenderer.invoke(IPC.fileWrite, path, content),
    onChanged: (cb: (path: string) => void) => {
      const handler = (_e: unknown, path: string) => cb(path)
      ipcRenderer.on(IPC.fileChanged, handler)
      return () => ipcRenderer.removeListener(IPC.fileChanged, handler)
    },
    watch: (dir: string) => ipcRenderer.invoke(IPC.fileWatch, dir),
  },
  jhyy: {
    compile: (req: CompileRequest) => ipcRenderer.invoke(IPC.compile, req),
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.run, req),
    stop: () => ipcRenderer.invoke(IPC.stop),
  },
  claude: {
    locate: () => ipcRenderer.invoke(IPC.claudeLocate),
    start: (opts: import('@shared/claude').ClaudeStartOptions) =>
      ipcRenderer.invoke(IPC.claudeStart, opts),
    send: (text: string) => ipcRenderer.invoke(IPC.claudeSend, text),
    stop: () => ipcRenderer.invoke(IPC.claudeStop),
    onEvent: (cb: (event: ClaudeEvent) => void) => {
      const handler = (_e: unknown, event: ClaudeEvent) => cb(event)
      ipcRenderer.on(IPC.claudeEvent, handler)
      return () => ipcRenderer.removeListener(IPC.claudeEvent, handler)
    },
    onStatus: (cb: (status: ClaudeStatus) => void) => {
      const handler = (_e: unknown, status: ClaudeStatus) => cb(status)
      ipcRenderer.on(IPC.claudeStatus, handler)
      return () => ipcRenderer.removeListener(IPC.claudeStatus, handler)
    },
  },
}

contextBridge.exposeInMainWorld('jhyyIde', api)

export type JhyyIdeApi = typeof api
