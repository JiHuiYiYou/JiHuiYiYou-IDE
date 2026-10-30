import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeEvent, ClaudeStatus } from '@shared/claude'
import {
  IPC,
  type CompileRequest,
  type FileChangedEvent,
  type IdeContext,
  type JhyyIdeApi,
  type RunOutputEvent,
  type RunRequest,
} from '@shared/ipc'
import type {
  TerminalCommandEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStartRequest,
} from '@shared/terminal'

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
    saveDialog: (defaultName?: string) => ipcRenderer.invoke(IPC.fileSaveDialog, defaultName),
    initial: () => ipcRenderer.invoke(IPC.fileInitial),
    read: (path: string) => ipcRenderer.invoke(IPC.fileRead, path),
    write: (path: string, content: string) => ipcRenderer.invoke(IPC.fileWrite, path, content),
    onChanged: (cb: (e: FileChangedEvent) => void) => {
      const handler = (_e: unknown, event: FileChangedEvent) => cb(event)
      ipcRenderer.on(IPC.fileChanged, handler)
      return () => ipcRenderer.removeListener(IPC.fileChanged, handler)
    },
    watch: (dir: string) => ipcRenderer.invoke(IPC.fileWatch, dir),
    cwd: () => ipcRenderer.invoke(IPC.fileCwd),
  },
  jhyy: {
    compile: (req: CompileRequest) => ipcRenderer.invoke(IPC.compile, req),
    run: (req: RunRequest) => ipcRenderer.invoke(IPC.run, req),
    stop: () => ipcRenderer.invoke(IPC.stop),
    onOutput: (cb: (e: RunOutputEvent) => void) => {
      const handler = (_e: unknown, event: RunOutputEvent) => cb(event)
      ipcRenderer.on(IPC.runOutput, handler)
      return () => ipcRenderer.removeListener(IPC.runOutput, handler)
    },
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
  terminal: {
    start: (req: TerminalStartRequest) => ipcRenderer.invoke(IPC.terminalStart, req),
    /**
     * 逐键触发 —— 走 `send` 不走 `invoke`。
     *
     * 每个按键一次 promise 往返纯属浪费，而且输入延迟会直接体现在手感上。
     * 这是本仓库**第一个** `ipcRenderer.send`（其余全是 invoke）。
     */
    write: (data: string) => ipcRenderer.send(IPC.terminalWrite, data),
    kill: () => ipcRenderer.invoke(IPC.terminalKill),
    cd: (cwd: string) => ipcRenderer.invoke(IPC.terminalCd, cwd),
    onData: (cb: (event: TerminalDataEvent) => void) => {
      const handler = (_e: unknown, event: TerminalDataEvent) => cb(event)
      ipcRenderer.on(IPC.terminalData, handler)
      return () => ipcRenderer.removeListener(IPC.terminalData, handler)
    },
    onExit: (cb: (event: TerminalExitEvent) => void) => {
      const handler = (_e: unknown, event: TerminalExitEvent) => cb(event)
      ipcRenderer.on(IPC.terminalExit, handler)
      return () => ipcRenderer.removeListener(IPC.terminalExit, handler)
    },
    onCommand: (cb: (event: TerminalCommandEvent) => void) => {
      const handler = (_e: unknown, event: TerminalCommandEvent) => cb(event)
      ipcRenderer.on(IPC.terminalCommand, handler)
      return () => ipcRenderer.removeListener(IPC.terminalCommand, handler)
    },
  },
  clipboard: {
    readText: () => ipcRenderer.invoke(IPC.clipboardReadText),
    writeText: (text: string) => ipcRenderer.invoke(IPC.clipboardWriteText, text),
  },
  window: {
    setEdited: (edited: boolean) => ipcRenderer.invoke(IPC.windowSetEdited, edited),
  },
  ide: {
    setContext: (ctx: IdeContext) => ipcRenderer.send(IPC.ideContext, ctx),
  },
}

/**
 * 编译期防漂移。
 *
 * `src/renderer/global.d.ts` 里 `window.jhyyIde` 的类型来自 `src/shared/ipc.ts`
 * 里**手写**的 `JhyyIdeApi`（不是本文件的 `typeof api`）—— 两份手抄的接口迟早对不上。
 * 这一行让编译期盯着：preload 少一个方法、或者类型对不上，直接编译失败。
 */
const _typeCheck: JhyyIdeApi = api
void _typeCheck

contextBridge.exposeInMainWorld('jhyyIde', api)

export type { JhyyIdeApi }
