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
  PtyBackendInfo,
  TerminalInfo,
  TerminalListEvent,
  TerminalStateEvent,
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
    /**
     * 只写**显示层**，不进 stdin。
     *
     * ⚠️ 往 stdin 写的东西会被 shell 当成**命令**执行掉 ⇒
     *    IDE 自己要显示一行字时走这里 ✓。
     */
    display: (data: string) => ipcRenderer.send(IPC.terminalDisplay, data),
    kill: () => ipcRenderer.invoke(IPC.terminalKill),
    cd: (cwd: string) => ipcRenderer.invoke(IPC.terminalCd, cwd),
    /**
     * 窗口尺寸变了（列 / 行）。
     *
     * ⚠️ 管道版**做不到实时改**（已经在跑的 shell 收不到）⇒ 只记下来给下一个
     * 进程用；真控制台版（ConPTY / node-pty）才会实时 resize。
     *
     * ⚠️ **必须带 `terminalId`** —— 每个终端的尺寸各是各的 ✓
     */
    resize: (terminalId: number, cols: number, rows: number) =>
      ipcRenderer.send(IPC.terminalResize, { terminalId, cols, rows }),
    /**
     * 现在是「真控制台」还是「管道兜底」？
     *
     * ⚠️ **会变** —— node-pty 起不来时会退到管道版 ⇒ 状态栏上的徽章要能反映
     *    这个（用户报过「终端一会真一会假的」）。
     */
    backend: (): Promise<PtyBackendInfo> => ipcRenderer.invoke(IPC.terminalBackend),
    /** 订阅「后端变了」—— 状态栏的徽章要跟着变 */
    onBackendChange: (cb: (info: PtyBackendInfo) => void) => {
      const handler = (_e: unknown, info: PtyBackendInfo) => cb(info)
      ipcRenderer.on(IPC.terminalBackendEvent, handler)
      return () => ipcRenderer.removeListener(IPC.terminalBackendEvent, handler)
    },
    /**
     * 告诉主进程「用户正在看 / 没在看这个终端」。
     *
     * ⚠️ 看不见时主进程**不补提示符** ⇒ 后台跑命令不会攒一堆「空提示符」
     *    （用户报过：「有时候会打印一堆这种空的」）⇒ 打开终端时补**一个** ✓。
     */
    /** 终端列表（VS Code 那样：可以有多个）。 */
    list: (): Promise<TerminalInfo[]> => ipcRenderer.invoke(IPC.terminalList),
    /** 开一个新的终端。 */
    create: (): Promise<TerminalInfo> => ipcRenderer.invoke(IPC.terminalCreate),
    /** 关掉一个终端（杀它的 shell）。 */
    close: (id: number): Promise<void> => ipcRenderer.invoke(IPC.terminalClose, id),
    /** 切换当前终端。 */
    select: (id: number) => ipcRenderer.send(IPC.terminalSelect, id),
    /** 订阅「终端列表变了」。 */
    onList: (cb: (event: TerminalListEvent) => void) => {
      const handler = (_e: unknown, event: TerminalListEvent) => cb(event)
      ipcRenderer.on(IPC.terminalListEvent, handler)
      return () => ipcRenderer.removeListener(IPC.terminalListEvent, handler)
    },
    onData: (cb: (event: TerminalDataEvent) => void) => {
      const handler = (_e: unknown, event: TerminalDataEvent) => cb(event)
      ipcRenderer.on(IPC.terminalData, handler)
      return () => ipcRenderer.removeListener(IPC.terminalData, handler)
    },
    /**
     * 回执：**这一批输出我已经写进 xterm 了**（背压）。
     *
     * ⚠️ 主进程靠它限速 ⇒ 没有它，终端狂打输出时 IDE 会卡死
     *    （用户报过：「运行 `while true` 的程序时整个 IDE 卡死」）。
     */
    ack: (terminalId: number, seq: number) =>
      ipcRenderer.send(IPC.terminalAck, { terminalId, seq }),
    /** 告诉主进程「我（新的）终端准备好了」—— 重置背压状态 */
    ready: (terminalId: number) => ipcRenderer.send(IPC.terminalReady, terminalId),
    /** 把终端的当前内容（序列化后的）存到主进程 —— 重载后恢复用 */
    saveBuffer: (terminalId: number, data: string) =>
      ipcRenderer.send(IPC.terminalSaveBuffer, { terminalId, data }),
    /** 要之前存的终端内容（重载后恢复用） */
    getBuffer: (terminalId: number): Promise<string | null> =>
      ipcRenderer.invoke(IPC.terminalGetBuffer, terminalId),
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
    /**
     * 订阅 shell 的状态（当前目录 / 空闲与否 / 上一条命令的退出码）。
     *
     * ⚠️ 这些是 **shell 自己报上来的**（OSC 633）⇒ 不是 IDE 猜的 ✓。
     */
    onState: (cb: (event: TerminalStateEvent) => void) => {
      const handler = (_e: unknown, event: TerminalStateEvent) => cb(event)
      ipcRenderer.on(IPC.terminalState, handler)
      return () => ipcRenderer.removeListener(IPC.terminalState, handler)
    },
    /**
     * 订阅「终端被重启了」（复用 ⇒ shell 重启 ⇒ 屏幕要清空）。
     *
     * ⚠️ VS Code 复用任务终端时会 `clearBuffer()`
     *   （`tasks/browser/terminalTaskSystem.ts:1614`）✓
     */
    onRestart: (cb: (terminalId: number) => void) => {
      const handler = (_e: unknown, terminalId: number) => cb(terminalId)
      ipcRenderer.on(IPC.terminalRestart, handler)
      return () => ipcRenderer.removeListener(IPC.terminalRestart, handler)
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
