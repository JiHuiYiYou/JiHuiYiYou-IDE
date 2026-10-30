import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import type { ClaudeStartOptions, ClaudeStatus } from '@shared/claude'
import { IPC, type CompileRequest, type IdeContext, type RunRequest } from '@shared/ipc'
import type { TerminalShell, TerminalStartRequest } from '@shared/terminal'
import { locateClaude } from './claude/locate'
import { ClaudeSession } from './claude/session'
import { locateJhyy } from './compiler/locate'
import { compileFile, runFile, stopRunning } from './compiler/runner'
import { TerminalSession, defaultShell } from './terminal'
import { ProjectWatcher } from './watcher'

/** 用户在设置里指定的 jhyy.exe 路径（优先于自动探测）。 */
let toolchainOverride: string | undefined

/** 启动参数里带来的文件（`electron . xxx.jhyy`）。 */
let startupFilePath: string | null = null

/** 当前的 Claude Code 会话。 */
let claudeSession: ClaudeSession | null = null

/** 当前的终端会话（懒启动 —— 只有切到「终端」页签才拉起来）。 */
let terminalSession: TerminalSession | null = null

/**
 * IDE 自己刚写过的文件（路径 → 写的时间戳）。
 *
 * watcher 盯的是**目录**，所以 IDE 自己保存文件也会触发回调 —— 不挡一下的话，
 * 每次保存都会弹「文件在外部被修改」的横幅（用户刚保存的东西被说成外部改动）。
 *
 * ⚠️ **不能用「一次性的 Set + 第一个事件就删掉」** ——
 * `fs.watch` 在 Windows 上一次写入可能触发**好几个**事件（change + rename），
 * 第一个被挡掉、第二个就漏出去了 ⇒ **每次保存都误报**（用户报过：
 * 「现在IDE不会自动刷新，每次都会显示有更改」）。
 * 所以改成「最近写过」的时间戳判断：一段时间内的所有事件都算自己的。
 */
const selfWrittenFiles = new Map<string, number>()

/** 「自己写的」这个标记的有效期（毫秒）。 */
const SELF_WRITE_TTL = 15_000

/**
 * Claude（**IDE 自己的 agent**）改过的文件。
 *
 * 这类是「**内部**改动」—— 用户就是让 Claude 改的 ⇒ 直接应用到编辑器，
 * 不用弹「文件在外部被修改了」。
 * 外部程序（别的编辑器、git checkout…）改的才提示。
 */
const claudeWrittenFiles = new Map<string, number>()

/** 记一笔「这个文件是 IDE 自己写的」。 */
function markSelfWritten(path: string): void {
  selfWrittenFiles.set(resolve(path), Date.now())
}

/** 这个文件是不是 IDE 自己（或者自己的 Claude）刚写过的？ */
function isSelfWritten(path: string): boolean {
  const key = resolve(path)
  const at = selfWrittenFiles.get(key)
  if (at !== undefined && Date.now() - at <= SELF_WRITE_TTL) return true
  selfWrittenFiles.delete(key)
  return false
}

/** 这个文件是不是 **Claude** 刚写过的（⇒ 内部改动，直接应用）？ */
function isClaudeWritten(path: string): boolean {
  const key = resolve(path)
  const at = claudeWrittenFiles.get(key)
  if (at !== undefined && Date.now() - at <= SELF_WRITE_TTL) return true
  claudeWrittenFiles.delete(key)
  return false
}

/**
 * 「打开 / 另存为」对话框上次用的**目录**。
 *
 * 用户报过：「每次打开新文件的时候那个文件资源管理器都会在下载目录，
 * 每次都得重定位到自己想要的」—— 下次 `Ctrl+O` 应该直接落在上次那个文件夹。
 *
 * ⚠️ **要记到磁盘上**（不只是内存里）—— 「就算你重新启动软件，
 * 他下次还是不会默认跳到下载目录」⇒ 重启后也得记住 ✓。
 */
const SETTINGS_FILE = 'dialog-state.json'

interface DialogState {
  lastOpenDir: string | null
}

function readDialogState(): DialogState {
  try {
    const raw = readFileSync(join(app.getPath('userData'), SETTINGS_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DialogState>
    return { lastOpenDir: parsed.lastOpenDir ?? null }
  } catch {
    // 没有 / 读不出来 —— 就当没记过
    return { lastOpenDir: null }
  }
}

function writeDialogState(state: DialogState): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(
      join(app.getPath('userData'), SETTINGS_FILE),
      JSON.stringify(state, null, 2),
      'utf8',
    )
  } catch {
    // 写不进去就算了 —— 下次回到默认目录而已
  }
}

let lastOpenDir: string | null = readDialogState().lastOpenDir

/** 记住「上次用的那个目录」。 */
function rememberOpenDir(dir: string): void {
  lastOpenDir = dir
  writeDialogState({ lastOpenDir: dir })
}

/** 项目文件监听器 —— 用来发现「文件在 IDE 外面被改了」。 */
const projectWatcher = new ProjectWatcher((path) => {
  // IDE 自己保存的 —— 忽略（编辑器里已经是最新了）
  if (isSelfWritten(path)) return
  // Claude 改的 —— 内部改动，渲染进程会**直接应用**
  broadcast(IPC.fileChanged, { path, internal: isClaudeWritten(path) })
})

function createWindow(): void {
  // 窗口图标 —— 延用编译器仓库的品牌图标。
  //
  // 打包后 exe 里已经嵌了同一张图标（见 electron-builder.yml 的 `win.icon`），
  // 所以这个路径**只在开发模式下存在**（`npm run dev` 跑的是 Electron 默认
  // 二进制，没有自己的图标）—— 用 existsSync 挡一下，打包版不受影响。
  const windowIcon = join(__dirname, '../../assets/jhyy-icon-256.png')

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14161c',
    title: 'JHYY IDE',
    ...(existsSync(windowIcon) ? { icon: windowIcon } : {}),
    // ── VS Code 式标题栏 ──────────────────────────────────────
    //
    // `titleBarStyle: 'hidden'` 把系统标题栏藏掉，标题栏我们自己画（菜单栏 /
    // 命令中心 / 布局开关）。
    //
    // ⚠️ **不要用 `frame: false`** —— 那会连 Windows 原生的调整边框、投影、
    // Aero Snap 一起去掉，得自己手搓 8 个拖拽热区 + 一堆 IPC。
    //
    // `titleBarOverlay` 让系统**继续画真正的最小化/最大化/关闭按钮**，只是盖在
    // 我们的网页内容右上角（所以标题栏右侧要留 ~138px 空位）。这样窗口照样能拖、
    // 能调边框，而且**不需要任何窗口控制 IPC**。
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1b1e26',
      symbolColor: '#d7dce5',
      height: 36,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // 把渲染进程的 console / 未捕获异常转发到主进程终端 ——
  // Electron 里渲染进程的报错默认看不见，调试时非常难查。
  win.webContents.on('console-message', (event) => {
    const d = event as unknown as {
      level: string
      message: string
      lineNumber: number
      sourceId: string
    }
    console.log(`[renderer:${d.level}] ${d.message}  (${d.sourceId}:${d.lineNumber})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] 渲染进程挂了:', details)
  })

  // 外部链接走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 启动参数里带 .jhyy 路径就直接打开它。
 * `electron . samples/demo.jhyy` —— 跟 VS Code / notepad++ 一个习惯。
 */
function filePathFromArgv(argv: string[]): string | null {
  // argv[0] 是 electron 可执行文件；dev 下 argv[1] 是应用目录（"."），要跳过
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    if (arg === '.') continue
    if (arg.toLowerCase().endsWith('.jhyy') && existsSync(arg)) return resolve(arg)
  }
  return null
}

function registerIpc(): void {
  ipcMain.handle(IPC.toolchainLocate, async () => {
    return locateJhyy(app.getAppPath(), toolchainOverride)
  })

  ipcMain.handle(IPC.toolchainSetPath, async (_e, exePath: string) => {
    toolchainOverride = exePath || undefined
    return locateJhyy(app.getAppPath(), toolchainOverride)
  })

  ipcMain.handle(IPC.fileOpenDialog, async () => {
    // getFocusedWindow() 可能是 null（比如窗口还没获得 OS 焦点），退到第一个窗口
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: '打开 JHYY 源文件',
      filters: [{ name: 'JHYY 源文件', extensions: ['jhyy'] }],
      properties: ['openFile'],
      // ⚠️ **落在上次那个文件夹** —— 用户报过「每次都在下载目录，每次都得重定位」。
      defaultPath: lastOpenDir ?? undefined,
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    rememberOpenDir(dirname(path))
    const content = await readFile(path, 'utf8')
    return { path, content }
  })

  ipcMain.handle(IPC.fileSaveDialog, async (_e, defaultName?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.SaveDialogOptions = {
      title: '保存 JHYY 源文件',
      filters: [{ name: 'JHYY 源文件', extensions: ['jhyy'] }],
    }
    // 落在上次那个文件夹里（文件名还是当前那个）
    if (lastOpenDir) {
      options.defaultPath = defaultName ? join(lastOpenDir, defaultName) : lastOpenDir
    } else if (defaultName) {
      options.defaultPath = defaultName
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    rememberOpenDir(dirname(result.filePath))
    return result.filePath
  })

  ipcMain.handle(IPC.fileRead, async (_e, path: string) => readFile(path, 'utf8'))

  ipcMain.handle(IPC.fileWatch, async (_e, dir: string) => {
    projectWatcher.start(dir)
  })

  // 启动时命令行带来的文件
  ipcMain.handle(IPC.fileInitial, async () => {
    if (!startupFilePath) return null
    const content = await readFile(startupFilePath, 'utf8')
    return { path: startupFilePath, content }
  })

  ipcMain.handle(IPC.fileWrite, async (_e, path: string, content: string) => {
    // 记一笔「这是 IDE 自己写的」—— watcher 报上来时好挡掉，
    // 不然每次保存都误报「文件在外部被修改」。
    markSelfWritten(path)
    await writeFile(path, content, 'utf8')
  })

  /** 没有打开文件时，Claude 会话 / 终端的默认工作目录。 */
  ipcMain.handle(IPC.fileCwd, async () => {
    if (startupFilePath) return dirname(startupFilePath)
    return app.getPath('home')
  })

  ipcMain.handle(IPC.compile, async (_e, req: CompileRequest) => {
    const toolchain = await locateJhyy(app.getAppPath(), toolchainOverride)
    if (!toolchain.available) {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `找不到可用的 jhyy 编译器。\n${toolchain.error ?? ''}`,
        diagnostics: [],
        raw: [],
        durationMs: 0,
        noLink: Boolean(req.noLink),
      }
    }
    // 像 VS Code 那样：IDE 跑的命令在终端里看得见
    //
    // ⚠️ **后台的实时诊断不回显** —— 那是每 600 ms 一次的自动编译，
    // 回显的话终端会被刷满（用户报过「都会触发就很烦人」）。
    if (!req.quiet) {
      showCommand(
        `jhyy compile ${req.noLink ? '--no-link ' : ''}"${req.file}"`,
        dirname(resolve(req.file)),
        false,
      )
    }
    const result = await compileFile({
      exePath: toolchain.exePath,
      file: req.file,
      noLink: req.noLink,
      extraArgs: req.extraArgs,
      timeoutMs: req.timeoutMs,
    })
    // 让 shell 重打一遍提示符 —— 否则终端里少 `user@host ~/dir` 那一行
    if (!req.quiet) terminalSession?.prompt()
    return result
  })

  ipcMain.handle(IPC.run, async (_e, req: RunRequest) => {
    const toolchain = await locateJhyy(app.getAppPath(), toolchainOverride)
    if (!toolchain.available) {
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `找不到可用的 jhyy 编译器。\n${toolchain.error ?? ''}`,
        diagnostics: [],
        raw: [],
        durationMs: 0,
        noLink: false,
        ran: false,
        crashed: false,
        programStdout: '',
        programStderr: '',
      }
    }
    // IDE 跑的是「编译 + 执行产物」（`jhyy run` 不捕获 stdout —— 见 runner.ts）
    showCommand(`jhyy compile "${req.file}"`, dirname(resolve(req.file)), true)
    const result = await runFile({
      exePath: toolchain.exePath,
      file: req.file,
      timeoutMs: req.timeoutMs,
      // ⚠️ **边跑边推** —— 跟 VS Code 的任务终端一样，用户能实时看到输出。
      //   （VS Code 那边是 PTY + xterm 增量渲染；我们没 PTY，就自己推。）
      onOutput: (stream, text) => {
        broadcast(IPC.runOutput, { stream, text })
        // 终端里也实时显示 —— 只走 `display()`（只写显示层），
        // 走 `write()` 会被 shell 当成**输入的命令**执行掉。
        terminalSession?.display(text)
      },
    })
    // 让 shell 重打一遍提示符 —— 否则终端里少 `user@host ~/dir` 那一行
    terminalSession?.prompt()
    return result
  })

  ipcMain.handle(IPC.stop, async () => {
    stopRunning()
  })

  // ── Claude Code ──────────────────────────────────────────────
  ipcMain.handle(IPC.claudeLocate, async () => {
    return locateClaude()
  })

  ipcMain.handle(IPC.claudeStart, async (_e, opts: ClaudeStartOptions) => {
    if (claudeSession) {
      await claudeSession.stop()
      claudeSession = null
    }
    const binary = await locateClaude()
    if (!binary) {
      const error = '找不到 Claude Code 可执行文件（claude CLI）。'
      broadcast(IPC.claudeStatus, { state: 'error', error } satisfies ClaudeStatus)
      return { ok: false, error }
    }

    claudeSession = new ClaudeSession({
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      appendSystemPrompt: opts.appendSystemPrompt ?? jhyyCheatSheet(),
      onEvent: (event) => {
        // Claude 用 Edit/Write 改了文件 —— 记一笔，watcher 报上来时好区分
        // 「这是内部改动」（直接应用）还是「外部程序改的」（提示用户）。
        if (event.type === 'message' && event.message.role === 'assistant') {
          for (const t of event.message.toolUses ?? []) {
            if (t.name !== 'Edit' && t.name !== 'Write' && t.name !== 'MultiEdit') continue
            const filePath = (t.input as { file_path?: string } | undefined)?.file_path
            if (filePath) claudeWrittenFiles.set(resolve(filePath), Date.now())
          }
        }
        broadcast(IPC.claudeEvent, event)
      },
    })
    try {
      await claudeSession.start(binary.path)
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      broadcast(IPC.claudeStatus, { state: 'error', error } satisfies ClaudeStatus)
      return { ok: false, error }
    }
  })

  ipcMain.handle(IPC.claudeSend, async (_e, text: string) => {
    return claudeSession?.send(text) ?? false
  })

  ipcMain.handle(IPC.claudeStop, async () => {
    await claudeSession?.stop()
    claudeSession = null
  })

  // ── 终端 ────────────────────────────────────────────────────
  ipcMain.handle(IPC.terminalStart, async (_e, req: TerminalStartRequest) => {
    const shell: TerminalShell = req.shell ?? defaultShell()
    const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : app.getPath('home')
    if (terminalSession?.running) {
      if (req.cwd && req.cwd !== terminalSession.currentCwd) terminalSession.cd(req.cwd)
      return { ok: true, shell: terminalSession.currentShell, cwd: terminalSession.currentCwd }
    }
    try {
      ensureTerminal(cwd, shell)
      return { ok: true, shell, cwd }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      terminalSession = null
      return { ok: false, shell, cwd, error }
    }
  })

  /**
   * 逐键写入 —— 走 `on`/`send` 而不是 `handle`/`invoke`。
   *
   * 这是本仓库**第一个** `ipcMain.on`（其余全是 `handle`）。有意为之：
   * 每个按键一次 promise 往返纯属浪费，输入延迟会直接体现在手感上。
   */
  ipcMain.on(IPC.terminalWrite, (_e, data: string) => {
    terminalSession?.write(data)
  })

  ipcMain.handle(IPC.terminalKill, async () => {
    await terminalSession?.kill()
    terminalSession = null
  })

  ipcMain.handle(IPC.terminalCd, async (_e, cwd: string) => {
    terminalSession?.cd(cwd)
  })

  // ── 剪贴板 / 窗口 ───────────────────────────────────────────
  //
  // 走 Electron 的 clipboard 模块，不用 `navigator.clipboard`：
  // 后者要 clipboard-read 权限，而且 `document.execCommand('paste')`
  // 在 Chromium 里是明令禁止的。
  ipcMain.handle(IPC.clipboardReadText, async () => clipboard.readText())

  ipcMain.handle(IPC.clipboardWriteText, async (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle(IPC.windowSetEdited, async (_e, edited: boolean) => {
    for (const win of BrowserWindow.getAllWindows()) win.setDocumentEdited(edited)
  })

  // IDE 的当前状态（当前文件 / 诊断 / 输出）—— 写进 Claude 的系统提示
  ipcMain.on(IPC.ideContext, (_e, ctx: IdeContext) => {
    ideContext = ctx
  })
}

/** 给所有窗口广播一个事件。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 保证有一个活着的终端会话（没有就拉起来）。
 *
 * ⚠️ 拉起来的是**后台的 shell** —— 用户看不到它，除非终端页签被打开。
 * 这正是 VS Code 的做法：任务终端平时不占地方。
 */
function ensureTerminal(cwd: string, shell: TerminalShell = defaultShell()): TerminalSession {
  if (terminalSession?.running) {
    if (cwd && cwd !== terminalSession.currentCwd) terminalSession.cd(cwd)
    return terminalSession
  }
  terminalSession = new TerminalSession({
    shell,
    cwd,
    onData: (event) => broadcast(IPC.terminalData, event),
    onExit: (event) => broadcast(IPC.terminalExit, event),
  })
  terminalSession.start()
  return terminalSession
}

/**
 * IDE 的按钮执行了一条命令 —— **像 VS Code 那样把它显示在终端里**。
 *
 * 只显示，不执行（命令已经跑完了）；同时广播给渲染进程。
 * `focus` 决定要不要把底部面板切到「终端」页签：
 * 运行要（程序输出就在终端里），检查不要（用户是来看诊断的）。
 */
function showCommand(cmdline: string, cwd: string, focus: boolean): void {
  try {
    ensureTerminal(cwd).echo(cmdline)
  } catch {
    // 终端起不来就算了 —— 不能因为它把「运行」搞挂
  }
  broadcast(IPC.terminalCommand, { command: cmdline, focus })
}

/**
 * IDE 的当前状态 —— 渲染进程告诉我们的（见 `IPC.ideContext`）。
 *
 * ⚠️ 用户提的：「agent 拿不到部分重要信息 —— **不知道你当前打开的是哪个文件**。
 * 系统提示里完全没有编辑器/IDE 的状态，只有工作目录」。
 */
let ideContext: IdeContext = {
  filePath: null,
  cwd: null,
  diagnostics: [],
  outputTail: '',
  readOnly: false,
}

/**
 * 追加给 Claude Code 的 system prompt —— 一份 JHYY 速查 + **IDE 的当前状态**。
 *
 * ⚠️ 用的是 `--append-system-prompt`（**追加**）而不是 `--system-prompt`
 * （**替换**）—— 替换会把 Claude Code 内置的工具用法说明一起顶掉，
 * 它用工具的能力会明显变差。
 */
function jhyyCheatSheet(): string {
  const ctx = ideContext
  const lines = [
    '你在给 JHYY（机会翼游）语言写代码。JHYY 是 Rust 风格的自举系统语言。',
    '',
    '要点：',
    '- 入口是 fn main_jhyy() -> i32（不是 main！），返回值就是进程退出码。',
    '- 类型必须显式标注：let x: i32 = 5;。参数也要标：fn f(a: i32) -> i32。',
    '- 整数与浮点之间不能隐式转换，要写 as：let f: f64 = 3 as f64;',
    '- 没有 print 内建；输出用 extern fn printf(fmt: *u8, val: i32) -> i32; 声明后调用。',
    '- type X = struct { ... } 结尾**不能**带分号；enum 同理。',
    '- import 只写模块名本身：import vec;（不是 import std::vec;）',
    '- 运算符：&& || 是短路逻辑，& | ^ << >> 是位运算；as 的优先级跟 * 一样。',
    '- if/else 是表达式，分支体是表达式不是语句块；match 的区间是闭区间，for 的区间是半开。',
    '- 泛型：type Pair<T> = struct { a: T }，调用写 max::<i32>(3, 5)。',
    '- 闭包 |x: i32| { x + 1 } 不能捕获外层变量。',
  ]

  // ── IDE 的当前状态 ────────────────────────────────────────
  lines.push('', '## 你现在在哪个 IDE 里（重要）', '')
  if (ctx.filePath) {
    lines.push(`- **用户当前打开的文件：${ctx.filePath}**`)
  } else {
    lines.push('- 用户当前**没有打开任何文件**。')
  }
  if (ctx.cwd) lines.push(`- 终端 / 程序运行的工作目录：${ctx.cwd}`)
  if (ctx.diagnostics.length > 0) {
    lines.push('- 问题面板里现在的诊断：')
    for (const d of ctx.diagnostics.slice(0, 20)) {
      lines.push(`  - ${d.file}:${d.line}:${d.col}: ${d.message}`)
    }
  } else {
    lines.push('- 问题面板里现在**没有**诊断。')
  }
  if (ctx.outputTail.trim()) {
    lines.push('- 输出面板的最后几行：', '```', ctx.outputTail.trimEnd(), '```')
  }
  lines.push(
    '',
    '用户问「我打开的是哪个文件」「现在报了什么错」这类问题时，**直接用上面这些信息回答**，',
    '不要去猜、也不要问用户「你打开的是哪个文件」。',
  )

  if (ctx.readOnly) {
    lines.push(
      '',
      '⚠️ **用户开了「只读」模式** —— 你**只给建议、不要修改任何文件**。',
      '要改代码就把改法写出来给用户看，别动磁盘上的文件。',
    )
  }

  lines.push(
    '',
    '写完代码后，用 jhyy_check 工具编译检查，用 jhyy_run 工具实际跑一遍，',
    '根据真实报错修改 —— 别靠猜。',
  )

  return lines.join('\n')
}

void app.whenReady().then(() => {
  /**
   * ⚠️ **必须把默认应用菜单摘掉。**
   *
   * Electron 会自动装一个默认菜单（文件/编辑/查看/窗口/帮助）。它的 **accelerator
   * 会在渲染进程看到按键之前就被吃掉**：
   * - `F5` / `Ctrl+R` = 重新加载窗口（会把整个 IDE 重载掉！）
   * - `Ctrl+W` = 关窗口，`Ctrl+Q` = 退出
   * - Edit 菜单还占着 `Ctrl+C/X/V/A/Z/Y`
   *
   * `titleBarStyle: 'hidden'` 只是把菜单栏**藏起来**，accelerator 照旧生效。
   * 菜单我们自己用 React 画（见 `src/renderer/workbench/MenuBar.tsx`），
   * 快捷键也自己接管（见 `src/renderer/commands/useKeybindings.ts`）。
   */
  Menu.setApplicationMenu(null)

  registerIpc()
  startupFilePath = filePathFromArgv(process.argv)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void terminalSession?.kill()
  terminalSession = null
})

app.on('window-all-closed', () => {
  stopRunning()
  if (process.platform !== 'darwin') app.quit()
})
