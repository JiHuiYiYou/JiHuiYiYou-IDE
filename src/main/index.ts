import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  utilityProcess,
} from 'electron'
import { stripAnsi } from '@shared/ansi'
import type { ClaudeStartOptions, ClaudeStatus } from '@shared/claude'
import { IPC, type CompileRequest, type IdeContext, type RunRequest } from '@shared/ipc'
import type { PtyBackendInfo, TerminalShell, TerminalStartRequest } from '@shared/terminal'
import { locateClaude } from './claude/locate'
import { buildMcpConfig } from './claude/mcp'
import { ClaudeSession } from './claude/session'
import { locateJhyy } from './compiler/locate'
import { parseDiagnostics } from './compiler/diagnostics'
import {
  compileContents,
  compileFile,
  ensureWorkDir,
  isControlCExit,
  ntstatusName,
  stopRunning,
} from './compiler/runner'
import { TerminalRegistry } from './terminalRegistry'
import {
  buildCommandChain,
  buildRunCommandChain,
  buildShellCommand,
  TerminalSession,
} from './terminal'
import { runInLiveShell, type LiveFallbackReason } from './liveRun'
import { defaultShell } from './ptyPipe'
import { ptyBackendInfo, reportPtyBackend } from './ptyFactory'
import { PtyHost, setPtyHost } from './ptyHostClient'
import { warmUpNodePty } from './ptyNode'
import type { PtySession } from './pty'
import { loadLoginShellEnv } from './shellEnv'
import { ProjectWatcher } from './watcher'

/** 用户在设置里指定的 jhyy.exe 路径（优先于自动探测）。 */
let toolchainOverride: string | undefined

/** 启动参数里带来的文件（`electron . xxx.jhyy`）。 */
let startupFilePath: string | null = null

/** 当前的 Claude Code 会话。 */
let claudeSession: ClaudeSession | null = null

/**
 * **终端登记表** —— 管着**多个**终端（VS Code 的模型）。
 *
 * ⚠️ 以前只有一个 `terminalSession` ⇒ 只能开一个、也不能关 ⇒
 *    用户要的是 VS Code 那套：能开新的、能关旧的、「运行」用当前那个、
 *    一个都没有就新开一个 ✓（见 `terminalRegistry.ts`）
 */
let terminals: TerminalRegistry | null = null
/**
 * 正在跑的**程序**（不是 shell）—— 「停止」按钮要能杀掉它。
 *
 * ⚠️ 程序现在跑在真控制台（pty）里 ⇒ 管道版 runner 那套 `stopRunning()`
 *    对它无效 ⇒ 得自己记着会话 ✓。
 */
let runningProgram: PtySession | null = null

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
    return { path, content, bytes: Buffer.byteLength(content, 'utf8') }
  })

  ipcMain.handle(IPC.fileSaveDialog, async (_e, _defaultName?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.SaveDialogOptions = {
      title: '保存 JHYY 源文件',
      filters: [{ name: 'JHYY 源文件', extensions: ['jhyy'] }],
    }
    /*
      ⚠️ **故意不给「文件名」的默认值**（只给**目录**）。

      Windows 的保存对话框会把「文件名」框里的内容**整段选中**（含后缀）。
      用户报过：「ctrl+n 以后另存为的时候，会自动把整个文件名包括后缀一同选上，
      要是能不选后缀就好了」。

      实测（三种都试过）：
      - 默认名**带**后缀（`未命名-1.jhyy`）⇒ 整段选中 ✗
      - 默认名**不带**后缀 ⇒ 对话框按过滤器**自动补**一个 ⇒ 补上的那段
        **跟着一起选中** ⇒ 还是整段 ✗
      - **不给默认名** ⇒ 框是空的 ⇒ 没有「被选中的后缀」✓

      ⇒ 干脆不给默认名。**其它一切不变**：过滤器还在（文件列表照样只显示
      `.jhyy`）、扩展名照样自动补（"hello" ⇒ "hello.jhyy"）✓。
      少掉的只是那个预填的名字 —— 标签页上写着「未命名-1.jhyy」，
      想保留就把它抄进文件名框即可。
    */
    options.defaultPath = lastOpenDir ?? undefined

    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    rememberOpenDir(dirname(result.filePath))
    return result.filePath
  })

  ipcMain.handle(IPC.fileRead, async (_e, path: string) => {
    const content = await readFile(path, 'utf8')
    // ⚠️ **字节数**（不是字符数）—— 判「大文件」要按字节算
    //   （中文一个字符 3 个字节 ⇒ 差三倍）⇒
    //   ⇒ `Buffer.byteLength` **不复制内容** ✓
    return { content, bytes: Buffer.byteLength(content, 'utf8') }
  })

  ipcMain.handle(IPC.fileWatch, async (_e, dir: string) => {
    projectWatcher.start(dir)
  })

  // 启动时命令行带来的文件
  ipcMain.handle(IPC.fileInitial, async () => {
    if (!startupFilePath) return null
    const content = await readFile(startupFilePath, 'utf8')
    return { path: startupFilePath, content, bytes: Buffer.byteLength(content, 'utf8') }
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
    /*
      ⚠️ **后台的实时诊断**（每 600 ms 一次的那种）**直接 spawn** ——
        它要的是「边写边报错」，**不能占用用户的终端** ⇒
        而且它 quiet（`req.quiet`）⇒ 终端里一个字都不显示 ✓
    */
    if (req.quiet) {
      /*
        ⚠️⚠️ **`contents` ⇒ 编的是「编辑器里现在这段」，不是磁盘上的旧文件** ——
          以前后台诊断直接编磁盘上那份 ⇒ **边打字边不报错**（用户改错了都看不见）✗
          而且诊断的行/列是**旧版本**的 ⇒ 波浪线落在错的行上 ✗
          ⇒ `compileContents` 把它写成一个临时文件再编（临时文件放在**源文件旁边**
          ⇒ 本地模块的 import 照样能解析 ⇒ 不会冒出假诊断）✓
      */
      if (req.contents !== undefined) {
        return compileContents({
          exePath: toolchain.exePath,
          file: req.file,
          contents: req.contents,
          noLink: req.noLink,
          extraArgs: req.extraArgs,
          timeoutMs: req.timeoutMs,
        })
      }
      return compileFile({
        exePath: toolchain.exePath,
        file: req.file,
        noLink: req.noLink,
        extraArgs: req.extraArgs,
        timeoutMs: req.timeoutMs,
      })
    }

    /*
      ⚠️⚠️ **「检查」⇒ 编译也在「当前那个终端」里跑**（用户要的）✓
        ⇒ 命令**敲进活着的 shell** ⇒ 编译完 shell 还活着 ⇒ 终端不死 ✓
        ⇒ 而且**不动 `activeId`** ⇒ 可见的终端页签**不跳** ✓
        ⇒（老路「一次性终端」现在是**保底**：没有 shell 集成 / 终端正忙时用）
    */
    const shell = defaultShell()
    const file = resolve(req.file)
    const fileDir = dirname(file)
    const work = ensureWorkDir()
    const outBase = join(work, `ide-check-${Date.now()}-${runSeq++}`)

    const started = Date.now()
    /*
      ⭐ **`activeOrCreate()` 复用已有终端时一个字节都不改**（**不动 `activeId`**）✓
        ⇒ ⇒ **可见的终端不会跳走** ⇒ 这就是「跳到别的终端」那个问题的修法 ✓
    */
    const session = ensureTerminals().activeOrCreate(fileDir)
    const live = await runInLiveShell({
      kind: 'check',
      session,
      shell,
      compiler: toolchain.exePath,
      src: file,
      outBase,
      workDir: work,
      runDir: fileDir,
      noLink: Boolean(req.noLink),
      ...(req.extraArgs ? { extraArgs: req.extraArgs } : {}),
      /*
        ⚠️ **跑完要 cd 回原目录** —— 不然 shell 就**永远停在 scratch 目录**了
        （渲染进程的 cd effect 只在「文件目录变了」时才发 cd）✗
      */
      returnCwd: session.shellState.cwd ?? session.currentCwd,
      /*
        ⚠️ **运行绑定到终端**（VS Code 的模型）✓
      */
      onStart: (s) => {
        s.setRunState('running')
        runningTerminal = s
        runningTerminalIsLive = true
      },
    })
    if (live.ok) {
      runningTerminal = null
      runningTerminalIsLive = false
      syncPtyBackend()
      // ⚠️ **live 路径下终端不会退出** ⇒ 必须由主进程显式置 `ok`/`failed` ✓
      session.setRunState('ok')
      const { diagnostics } = parseDiagnostics(live.compileText)
      const hasError = diagnostics.some((d) => d.severity === 'error')
      return {
        ok: live.compileExitCode === 0 && !hasError,
        exitCode: live.compileExitCode,
        stdout: '',
        stderr: live.compileText,
        diagnostics,
        raw: live.compileText.split('\n'),
        durationMs: Date.now() - started,
        noLink: Boolean(req.noLink),
      }
    }

    // ⚠️ **退回老路**（保底）：没有 shell 集成 / 终端正忙 / 终端死了 ⇒
    //   命令 = **shell 的启动参数** ⇒ 终端跑完自己退出 ⇒ 不依赖 OSC 633 ✓
    // ⚠️ **活 shell 那条路已经把「正在跑」打在当前终端上了** ⇒
    //   走保底 ⇒ **把它清掉**（不然当前终端会一直转圈）✓
    runningTerminal = null
    runningTerminalIsLive = false
    session.setRunState(undefined)

    const command = buildCommandChain(shell, [
      {
        command: buildShellCommand(shell, toolchain.exePath, [
          'compile',
          file,
          '-o',
          outBase,
          ...(req.noLink ? ['--no-link'] : []),
          ...(req.extraArgs ?? []),
        ]),
        cwd: work,
      },
    ])

    const { exitCode, text } = await runInOneShotTerminal(
      'check',
      shell,
      command,
      fileDir,
      live.fallback,
    )
    const { diagnostics } = parseDiagnostics(text)
    const hasError = diagnostics.some((d) => d.severity === 'error')
    return {
      ok: exitCode === 0 && !hasError,
      exitCode,
      stdout: '',
      stderr: text,
      diagnostics,
      raw: text.split('\n'),
      durationMs: Date.now() - started,
      noLink: Boolean(req.noLink),
    }
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

    /*
      ⚠️⚠️⚠️ **「运行」⇒ 在「当前那个活着的终端」里跑**（用户要的）✓
        ⇒ 命令**敲进活着的 shell**（`session.runCommand()`）
        ⇒ 程序是 **shell 的孩子** ⇒ stdout 就是控制台（不缓冲）、
          stdin 就是终端（`scanf` 读得到）✓
        ⇒ 跑完 **shell 还活着** ⇒ 提示符回来 ⇒ **终端不死** ✓✓
        ⇒ 而且**不动 `activeId`** ⇒ **可见的终端页签不跳** ✓✓

        ⇒（老路「一次性终端」现在是**保底**：没有 shell 集成 / 终端正忙时用
           —— VS Code 的任务终端模型：命令 = shell 的启动参数 ⇒ 跑完就退出）
    */
    const shell = defaultShell()
    const file = resolve(req.file)
    const fileDir = dirname(file)
    // ⚠️ **编译器的跨阶段临时文件走相对 CWD 的路径**（`compiler/build/obj/…`）
    //    且**编译器不会自己建那个目录** ⇒ 得给一个 scratch 目录 ✓
    const work = ensureWorkDir()
    const outBase = join(work, `ide-run-${Date.now()}-${runSeq++}`)

    const started = Date.now()
    /*
      ⭐ **`activeOrCreate()` 复用已有终端时一个字节都不改**（**不动 `activeId`**）✓
        ⇒ ⇒ **可见的终端不会跳走** ⇒ 这就是「跳到别的终端」那个问题的修法 ✓
        ⇒ ⇒ 正常路径下**一个一次性终端都不会被创建** ⇒ 终端列表保持干净 ✓
    */
    const session = ensureTerminals().activeOrCreate(fileDir)
    // ⚠️ **面板切到终端页**（程序的输出就在那儿）✓
    //    ⇒ **在跑之前就切** ⇒ 用户能看着输出一点点出来 ✓
    broadcast(IPC.terminalCommand, { command: `运行 ${basename(file)}`, focus: true })
    const live = await runInLiveShell({
      kind: 'run',
      session,
      shell,
      compiler: toolchain.exePath,
      src: file,
      outBase,
      workDir: work,
      runDir: fileDir,
      /*
        ⚠️ **运行绑定到终端**（VS Code 的模型）——
          「停止」的 Ctrl+C 必须发给**真正跑程序的那个**终端 ✓
          （以前发给 `terminals.active()` ⇒ 用户切了个终端就 Ctrl+C 不到了）✗
        ⇒ ⚠️ **在「等 shell 起来」之前就报** ⇒ 冷终端那十几秒里
          终端页签**在转圈** ⇒ 不然看着像「点了没反应」✗
      */
      onStart: (s) => {
        s.setRunState('running')
        runningTerminal = s
        runningTerminalIsLive = true
      },
    })

    if (live.ok) {
      runningTerminal = null
      runningTerminalIsLive = false
      syncPtyBackend()
      /*
        ⚠️⚠️ **live 路径下终端**不会退出** ⇒ 渲染进程的 `terminal.onExit`
          **不会**清掉 `run` 状态（`App.tsx` 那边）⇒
          ⇒ **必须由主进程显式置 `ok`/`failed`** ✓
          ⇒ 退出码不是「失败」的判据（用户明说）⇒ 只在**崩溃**时才是 ✗ ✓
      */
      const liveCrash = ntstatusName(live.ran ? live.programExitCode : live.compileExitCode)
      session.setRunState(
        liveCrash !== undefined && !isControlCExit(live.programExitCode) ? 'failed' : 'ok',
      )
      const { diagnostics } = parseDiagnostics(live.compileText)
      const hasError = diagnostics.some((d) => d.severity === 'error')
      // ⚠️ **退出码是「程序自己的」**（比一次性路径更准 —— 那条是整条链的）✓
      // ⚠️ **编译失败 ⇒ 程序没跑** ⇒ 退出码是**编译器**的，不是程序的 ✓
      const exitCode = live.ran ? live.programExitCode : live.compileExitCode
      const crashName = ntstatusName(exitCode)
      // ⚠️ **Ctrl+C 退出（0xC000013A）不是崩溃** —— 那是用户自己打断的 ✓
      const interrupted = isControlCExit(exitCode)
      // ⚠️ **「程序输出」那份纯文本** —— 给 Claude 的上下文用 ✓
      if (live.programText) broadcast(IPC.runOutput, { stream: 'stdout', text: live.programText })
      return {
        ok: !hasError,
        exitCode,
        stdout: '',
        stderr: live.compileText,
        diagnostics,
        raw: live.compileText.split('\n'),
        durationMs: Date.now() - started,
        noLink: false,
        ran: live.ran && !hasError,
        crashed: crashName !== undefined && !interrupted,
        interrupted,
        timedOut: live.timedOut,
        // ⚠️ **终端（shell）在跑的过程中死了** ⇒ 这次结果没收尾
        //    （渲染进程看到它就什么都不说 —— 用户自己关的终端，他自己知道）✓
        terminalClosed: live.terminalClosed,
        ...(crashName !== undefined ? { crashName } : {}),
        // ⚠️ **活 shell 那条路能拿到「程序自己的」输出**（保底那条拿不到 ⇒ 空）✓
        programStdout: live.programText,
        programStderr: '',
        truncated: false,
      }
    }

    /*
      ⚠️⚠️ **退回老路**（保底）—— VS Code 的任务终端模型：
        命令**不是敲进终端的 stdin**，而是 **shell 的启动参数**
        （`bash -c "…"` / `powershell -Command "…"`）
        ⇒ shell 跑完就退出 ⇒
        ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
        ⇒ ⇒ **不用等 shell 集成**、**不依赖 OSC 633** ⇒ 集成挂了也能跑 ✓

        ⇒ 代价：**跑命令的终端是「一次性的」**（跑完那条命令，shell 就退出）⇒
          但**它留在终端列表里**（输出能看）⇒ **下次跑复用它**（把 shell 重启一遍）
          ⇒ VS Code 的 task 终端就是这样（`terminalTaskSystem.ts:985` 留着复用）✓
    */
    const command = buildRunCommandChain(shell, {
      compiler: toolchain.exePath,
      src: file,
      outBase,
      workDir: work,
      runDir: fileDir,
    })

    // ⚠️ **活 shell 那条路已经把「正在跑」打在当前终端上了** ⇒
    //    走保底 ⇒ **把它清掉**（不然当前终端会一直转圈）✓
    runningTerminal = null
    runningTerminalIsLive = false
    session.setRunState(undefined)

    // ⚠️ **面板切到终端页**（程序的输出就在那儿）✓
    broadcast(IPC.terminalCommand, { command, focus: true })

    /*
      ⚠️⚠️ **判完成 = 等这个终端退出**（VS Code 的模型）⇒ 退出码就是它的退出码 ✓
        ⇒ 复用终端 ⇒ 每次跑 shell 都重启 ⇒ 是一轮新的 ⇒ 重新等 ✓
    */
    const { exitCode, text } = await runInOneShotTerminal(
      'run',
      shell,
      command,
      fileDir,
      live.fallback,
    )
    const durationMs = Date.now() - started

    const { diagnostics } = parseDiagnostics(text)
    const hasError = diagnostics.some((d) => d.severity === 'error')
    // ⚠️ **编译失败 ⇒ 程序没跑** ⇒ 退出码是**编译器**的，不是程序的 ✓
    const ran = !hasError

    const crashName = ntstatusName(exitCode)
    // ⚠️ **Ctrl+C 退出（0xC000013A）不是崩溃** —— 那是用户自己打断的 ✓
    const interrupted = isControlCExit(exitCode)
    // ⚠️ **「程序输出」那份纯文本** —— 给 Claude 的上下文用 ✓
    if (text) broadcast(IPC.runOutput, { stream: 'stdout', text })

    return {
      ok: !hasError,
      exitCode,
      stdout: '',
      stderr: text,
      diagnostics,
      raw: text.split('\n'),
      durationMs,
      noLink: false,
      ran,
      crashed: crashName !== undefined && !interrupted,
      interrupted,
      timedOut: false,
      // ⚠️ **降级了**（走了保底那条路）—— 用户在**那个终端里**能看到黄字说明 ✓
      //    （⚠️ **不往状态栏写** —— 状态栏只显示「坏」的事，CLAUDE.md 有规矩 ✓）
      degraded: true,
      ...(live.fallback ? { note: fallbackNote(live.fallback) } : {}),
      ...(crashName !== undefined ? { crashName } : {}),
      programStdout: '',
      programStderr: '',
      truncated: false,
    }
  })


  ipcMain.handle(IPC.stop, async () => {
    stopRunning()
    /*
      ⚠️⚠️ **「停止」= 打断「正在跑程序的那个终端」** ——
        ⚠️⚠️ **必须是「跑程序的那个」终端**，不是 `terminals.active()` ——
          用户可能已经切到别的终端了 ⇒ 打断的是**别的 shell** ✗
          （用户报过：程序停不下来）⇒

      ⚠️⚠️⚠️ **活 shell 那条路 ⇒ 绝对不能杀终端** ——
        活的路上程序是**用户 shell 的孩子** ⇒
        ⇒ 杀掉终端 = **毁掉用户的 shell 会话**（历史、conda、当前目录全丢）✗✗
        ⇒ **只发 Ctrl+C** 就够了（shell 的前台进程收到中断）✓
        （一次性终端那条老路才需要杀：那个 shell 的唯一孩子就是程序）
    */
    const term = runningTerminal
    if (term) {
      // 先给一个 Ctrl+C（真控制台下程序能优雅地收尾 ⇒ 退出码是 0xC000013A「中断」）
      term.interrupt()
      // ⚠️ **一次性终端那条老路** ⇒ 过一会儿还在跑 ⇒ 直接杀
      //    （taskkill /T /F 会连子孙一起杀 ✓）
      //    ⚠️ **管道版没有控制台** ⇒ 0x03 只是个普通字节 ⇒ 程序根本收不到 ✗
      if (!runningTerminalIsLive) {
        setTimeout(() => {
          if (runningTerminal === term && term.running) void term.kill()
        }, 1500)
      }
    }
    // ⚠️ **老路（没有 shell 集成的 shell）还在用** ⇒ 那个 pty 也得杀 ✓
    if (runningProgram) {
      const p = runningProgram
      runningProgram = null
      await p.kill()
    }
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
      appendSystemPrompt: opts.appendSystemPrompt ?? jhyyCheatSheet(opts.source),
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
  //
  // ⚠️ **可以有多个终端**（VS Code 的模型）——
  //    能开新的、能关旧的、当前那个是「运行」用的、
  //    一个都没有就新开一个 ✓（见 `terminalRegistry.ts`）

  /** 终端列表。 */
  ipcMain.handle(IPC.terminalList, async () => ensureTerminals().list())

  /** 开一个新的终端。 */
  ipcMain.handle(IPC.terminalCreate, async () => {
    const reg = ensureTerminals()
    const s = reg.create(app.getPath('home'))
    console.log(`[pty] 新终端 #${s.id}（${s.backend}）`)
    syncPtyBackend()
    const info = reg.list().find((t) => t.id === s.id)
    return info ?? { id: 0, name: 'bash', shell: defaultShell(), cwd: null }
  })

  /** 关掉一个终端（杀它的 shell）。 */
  ipcMain.handle(IPC.terminalClose, async (_e, id: number) => {
    terminals?.close(id)
  })

  /** 切换当前终端。 */
  ipcMain.on(IPC.terminalSelect, (_e, id: number) => {
    terminals?.setActive(id)
  })

  ipcMain.handle(IPC.terminalStart, async (_e, req: TerminalStartRequest) => {
    const shell: TerminalShell = req.shell ?? defaultShell()
    const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : app.getPath('home')
    try {
      const reg = ensureTerminals()
      // ⚠️ **复用当前那个**（VS Code 那样）—— 反复「运行」不新开终端 ✓
      const t = reg.active()
      if (t && t.running) {
        if (req.cwd && req.cwd !== t.currentCwd) t.cd(req.cwd)
        return { ok: true, shell: t.currentShell, cwd: t.currentCwd }
      }
      reg.create(cwd)
      return { ok: true, shell, cwd }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
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
    terminals?.active()?.write(data)
  })

  /**
   * 只写**显示层**（不进 stdin）。
   *
   * ⚠️ 往 stdin 写的东西会被 shell 当成**命令**执行掉 —— 所以 IDE 自己
   *    要往终端里显示一行字（比如「shell 起不来」）时走这条 ✓。
   */
  ipcMain.on(IPC.terminalDisplay, (_e, data: string) => {
    terminals?.active()?.display(data)
  })

  /**
   * 渲染进程回执：**这一批输出我已经写进 xterm 了**（背压）。
   *
   * ⚠️ 没有它，主进程只能一股脑往前推 ⇒ IPC 队列无限涨 ⇒ 内存被吃光 ⇒
   *    整个 IDE 卡死（用户报过：「运行 `while true` 的程序时整个 IDE 卡死」）✓
   */
  ipcMain.on(IPC.terminalAck, (_e, p: { terminalId: number; seq: number }) => {
    terminals?.get(p.terminalId)?.ack(p.seq)
  })

  /**
   * 渲染进程挂上来了（新的终端实例）—— **重置背压状态**。
   *
   * ⚠️ 窗口重载之后渲染进程是**新来的** ⇒ 它没回执过任何东西 ⇒
   *    主进程那边的「在途字节」会一直卡着 ⇒ **终端再也不出东西** ⇒
   *    ⇒ 这里把在途清空、队列里的接着发 ✓
   */
  ipcMain.on(IPC.terminalReady, (_e, terminalId: number) => {
    terminals?.get(terminalId)?.resetFlowControl()
  })

  /**
   * 渲染进程把终端内容存过来（序列化后的字符串）。
   *
   * ⚠️ **存的是主进程这边** ⇒ 窗口重载之后渲染进程没了、内容还在 ⇒
   *    新来的渲染进程一要就能恢复 ✓（VS Code 靠 pty 宿主进程保，我们靠这个）✓
   */
  ipcMain.on(IPC.terminalSaveBuffer, (_e, p: { terminalId: number; data: string }) => {
    terminals?.get(p.terminalId)?.saveBuffer(p.data)
  })

  /** 渲染进程来要之前存的终端内容（重载后恢复用）。 */
  ipcMain.handle(IPC.terminalGetBuffer, (_e, terminalId: number) =>
    terminals?.get(terminalId)?.getBuffer() ?? null,
  )

  ipcMain.handle(IPC.terminalKill, async () => {
    await terminals?.killAll()
    terminals = null
  })

  ipcMain.handle(IPC.terminalCd, async (_e, cwd: string) => {
    terminals?.active()?.cd(cwd)
  })

  /**
   * 窗口尺寸变了。
   *
   * ⚠️ 管道版**做不到实时改**（已经在跑的 shell 收不到 SIGWINCH）⇒ 只记下来，
   * 给**下一个**起的进程用（`COLUMNS`/`LINES`）。真控制台后端接上以后，
   * 这里就是 `ResizePseudoConsole` 的入口 ✓。
   */
  ipcMain.on(
    IPC.terminalResize,
    (_e, size: { terminalId: number; cols: number; rows: number }) => {
      terminals?.resize(size.terminalId, size.cols, size.rows)
    },
  )

  /**
   * 终端后端现在是「真控制台」还是「管道兜底」？
   *
   * ⚠️ **会变** —— node-pty 起不来时会退到管道版 ⇒ 状态栏上的徽章要能反映
   *    这个（用户报过「终端一会真一会假的」⇒ 得看得见才说得清）。
   */
  ipcMain.handle(IPC.terminalBackend, async () => ptyBackendInfo())

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
 * 后端状态变了 ⇒ **推给渲染进程**（状态栏那个徽章要跟着变）。
 *
 * ⚠️ node-pty 什么时候起不来是**运行期**才知道的（原生模块加载不了、cwd
 * 不存在、句柄不够 …）⇒ 只在启动时探一次不够 ⇒ 每次起完会话都看一眼 ✓。
 */
let lastBackend: PtyBackendInfo | null = null
function syncPtyBackend(): void {
  const info = ptyBackendInfo()
  if (lastBackend && lastBackend.backend === info.backend) return
  lastBackend = info
  broadcast(IPC.terminalBackendEvent, info)
}

/**
 * 拿到终端登记表（没有就建一个）。
 *
 * ⚠️ **IDE 一起来就开一个终端** —— 用户要的行为：
 *    「IDE 一起来就开一个真终端，然后一直就用」⇒
 *    ⇒ 反复点「运行」**不新开**（VS Code 那样）✓
 */
function ensureTerminals(): TerminalRegistry {
  if (!terminals) {
    terminals = new TerminalRegistry(defaultShell(), {
      onData: (event) => broadcast(IPC.terminalData, event),
      onExit: (event) => {
        broadcast(IPC.terminalExit, event)
        /*
          ⚠️⚠️ **这个终端死了 ⇒ 跑在它上面的运行要收场** ——
            VS Code 的模型：任务由**终端的 exit 事件**驱动收场
            （`tasks/browser/terminalTaskSystem.ts:971`）⇒
            关掉终端 ⇒ 任务结束 ⇒ 「运行中」不会永远亮着 ✓
            （用户报过：「有的终端杀掉了右上角还是在运行中」）✗
        */
        if (runningTerminal && runningTerminal.id === event.terminalId) {
          runningTerminal = null
        }
      },
      // ⚠️ shell 的状态（当前目录 / 空闲与否 / 退出码）—— **shell 自己报的**
      //    （OSC 633）⇒ 不是 IDE 猜的 ✓
      onState: (event) => broadcast(IPC.terminalState, event),
      onListChanged: () =>
        broadcast(IPC.terminalListEvent, {
          activeId: terminals?.activeTerminalId ?? null,
          terminals: terminals?.list() ?? [],
        }),
      // ⚠️ **终端被复用（shell 重启）⇒ 屏幕要清空**（VS Code 也清）✓
      onRestart: (terminalId) => broadcast(IPC.terminalRestart, terminalId),
    })
  }
  return terminals
}

/**
 * 拿到「当前那个」终端；**一个都没有就新开一个**。
 *
 * ⚠️ 这就是用户要的那条：「如果一个终端都没有，下次运行程序会开一个新的，
 *    后面重复用这个」✓（VS Code 的行为）
 */
function activeTerminal(cwd?: string): TerminalSession {
  const reg = ensureTerminals()
  const before = reg.activeTerminalId
  const a = reg.activeOrCreate(cwd)
  // ⚠️ **只在新开终端的时候报一次** —— 每次「运行」都打一遍就是刷屏 ✗
  if (reg.activeTerminalId !== before) {
    /*
      报一下**终端后端** —— 排查时第一眼就能看出「这台机器有没有真控制台」。

      `node-pty` 是可选依赖（原生模块，要按 Electron 的 ABI 重编 ⇒ 要 MSVC）
      ⇒ 装不上就静悄悄退回管道版 ⇒ 用户会以为「终端还是假的」。
    */
    console.log(`[pty] 新终端 #${a.id}（${a.backend}）`)
    syncPtyBackend()
  }
  return a
}

/**
 * **在一次性终端里跑一条命令**（VS Code 的任务终端模型）。
 *
 * ⚠️⚠️ **命令 = shell 的启动参数**（`bash -c "…"` / `powershell -Command "…"`）
 *   ⇒ shell 跑完就退出 ⇒
 *   ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
 *   ⇒ ⇒ **不用等 shell 集成**、**不依赖 OSC 633** ⇒ 集成挂了也能跑 ✓
 *   ⇒ ⇒ 冷终端也是「shell 一起来就跑」⇒ **不用干等** ✓
 *
 * ⇒ 终端跑完**留在列表里**（输出能看）⇒ **下次跑复用它**（VS Code 的 task 终端）✓
 *
 * @param kind    这条命令归谁（`run` / `check`）⇒ 各自一个终端，互不冲掉 ✓
 * @param shell   用哪个 shell
 * @param command 要跑的命令（已经拼好的那一行）
 * @param cwd     终端的起始目录
 * @param fallbackReason 为什么走了保底（**写进终端里** ⇒ 用户看得见 ⇒ 退化要看得见 ✓）
 */
async function runInOneShotTerminal(
  kind: 'run' | 'check',
  shell: TerminalShell,
  command: string,
  cwd: string,
  fallbackReason?: LiveFallbackReason,
): Promise<{ exitCode: number | null; text: string }> {
  // ⚠️ **用户看到的那行命令是 IDE 自己写的** ——
  //   命令是 shell 的**启动参数** ⇒ shell **不会回显**它
  //   ⇒ VS Code 也自己写一行 `Executing task: …` ⇒ 我们也自己写 ✓
  const initialText =
    (fallbackReason ? `\x1b[33m${fallbackNote(fallbackReason)}\x1b[0m\r\n` : '') +
    `\x1b[90m> ${command}\x1b[0m\r\n`
  const term = ensureTerminals().runTerminal(kind, {
    shellCommand: command,
    initialText,
    cwd,
    shell,
  })
  // ⚠️ **报「正在跑」** —— 终端页签上转圈（VS Code 的 task 页签）✓
  //    ⇒ 渲染进程的 `busy` 是**从这儿推出来的** ⇒ 不用自己维护布尔 ✓
  term.setRunState('running')
  // ⚠️ **「停止」的 Ctrl+C 要发给「正在跑程序的那个终端」** ✓
  runningTerminal = term
  runningTerminalIsLive = false
  const exitCode = await term.exited
  runningTerminal = null
  syncPtyBackend()
  /*
    ⚠️ **跑完了 ⇒ 终端页签上留个状态**（VS Code 的 task 页签：✓ / ✗）✓
      ⇒ 退出码不是「失败」的判据（用户明说）⇒ 只在**崩溃**时才是 ✗ ✓
  */
  const crash = ntstatusName(exitCode)
  term.setRunState(crash !== undefined && !isControlCExit(exitCode) ? 'failed' : 'ok')
  return { exitCode, text: stripAnsi(term.capturedOutput) }
}

/** 一次性终端的序号（产物/输出文件名要唯一 ⇒ 别撞上后台诊断的编译）✓ */
let runSeq = 0

/**
 * **为什么走了保底（一次性终端）** —— 写成一句话。
 *
 * ⚠️ **退化必须是「看得见」的**（CLAUDE.md 的规矩）⇒
 *   ⇒ 这一行**写进那个终端里**（黄字）⇒ 用户一眼知道「它换了个终端、为什么」✓
 *   ⇒ ⚠️ **不写状态栏** —— CLAUDE.md 明说状态栏只显示「坏」的事
 *     （「运行中…」「退出码 42」「降级运行…」**全都不显示**）✓
 */
function fallbackNote(reason: LiveFallbackReason): string {
  switch (reason) {
    case 'busy':
      return '⚠ 当前终端正在执行您自己的命令 ⇒ 本次运行改在这个终端里进行'
    case 'pending-input':
      return '⚠ 当前终端有一行没敲完的命令 ⇒ 本次运行改在这个终端里进行'
    case 'no-shell-integration':
      return '⚠ 当前终端没有 shell 集成 ⇒ 本次运行改在这个终端里进行'
    case 'integration-timeout':
      return '⚠ 当前终端的 shell 集成没起来 ⇒ 本次运行改在这个终端里进行'
    case 'shell-dead':
    default:
      return '⚠ 当前终端不可用 ⇒ 本次运行改在这个终端里进行'
  }
}

/**
 * **当前这次「运行」用的是哪个终端** —— 运行**绑定到终端**（VS Code 的模型）。
 *
 * ⚠️ **为什么要有它** ——
 *    ① 「停止」按钮的 Ctrl+C 必须发给**真正跑程序的那个**终端
 *       （以前发给 `terminals.active()` ⇒ 用户切了个终端就 Ctrl+C 不到了）✗
 *    ② 终端死了 ⇒ **运行要收场**（VS Code：`terminalTaskSystem.ts:971`
 *       ⇒ 任务由**终端的 exit 事件**驱动收场）✓
 */
let runningTerminal: TerminalSession | null = null

/**
 * **当前这次「运行」是不是在「活着的 shell」里跑的？**
 *
 * ⚠️ **为什么要有它** ——
 *   - **活 shell**：程序是**用户 shell 的孩子** ⇒
 *     「停止」**只发 Ctrl+C**、**绝不杀终端**（杀了 = 毁掉用户的会话）✗✗
 *   - **一次性终端**（保底路径）：程序是那个 shell 的唯一孩子 ⇒
 *     Ctrl+C 不管用时（管道版没控制台）可以直接杀那个终端 ✓
 */
let runningTerminalIsLive = false

/**
 * **在 shell 里编译**（VS Code 的 task 模型）——
 * 编译器的输出、程序的输出、提示符**全在同一条流里** ⇒ **提示符只出现一次** ✓。
 *
 * ## 为什么编译也要在 shell 里
 *
 * ⚠️⚠️ **以前编译是 IDE 直接 spawn 的**，输出靠 `display()` **注入**到终端 ⇒
 *    注入的内容**不在 conhost 的屏幕里** ⇒ 而 shell 的提示符**在它上面**
 *    ⇒ 用户看到的就是「先打印程序输出，然后又打印一遍 (base) PS ...」✗
 *    ⇒ **VS Code 的 task 终端**：命令写进 **shell 的 stdin** ⇒
 *      shell 自己回显、自己输出、自己打提示符 ⇒ **一条流、一个提示符** ✓
 *
 * ## 为什么要先 cd 到 scratch 目录
 *
 * ⚠️ **编译器的跨阶段临时文件走相对 CWD 的路径**（`compiler/build/obj/…`），
 *    而编译器**不会自己创建**那个目录 ⇒ 目录不存在就 fopen 失败 ⇒
 *    ⇒ CWD 必须是 IDE 自己管的 scratch 目录（`ensureWorkDir()`）✓
 *    ⇒ 不然就会在**用户的项目里**凭空造出 `compiler/build/obj/`（用户报过）✗
 *
 * ## 产物的 outBase 必须唯一
 *
 * ⚠️ `ensureWorkDir()` 是**固定的**目录 ⇒ 后台实时诊断的 `--no-link` 编译
 *    用的是**默认名字**（源文件名）⇒ 撞上了就互相覆盖 ✗

/**
 * IDE 的当前状态 —— 渲染进程告诉我们的（见 `IPC.ideContext`）。
 *
 * ⚠️ 用户提的：「agent 拿不到部分重要信息 —— **不知道你当前打开的是哪个文件**。
 * 系统提示里完全没有编辑器/IDE 的状态，只有工作目录」。
 */
let ideContext: IdeContext = {
  filePath: null,
  fileName: null,
  unsaved: false,
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
function jhyyCheatSheet(source?: string): string {
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
  /**
   * 把用户正在编辑的内容贴出来（磁盘上读不到/是旧的那一份）。
   *
   * ⚠️ **`source` 是 `undefined` 时不许贴一个空代码块** ——
   *   上面那行字还在说「下面代码块才是用户现在正在编辑的内容」，
   *   贴个空的等于**骗 Claude**（它会以为用户的内容是空的）✗
   *   ⇒ 改成一句话说明「内容太大没带过来，请让用户先保存」。
   */
  const pushSource = (): void => {
    if (source === undefined) {
      lines.push(
        '- ⚠️ 这个缓冲区**有还没保存的修改**，但**内容太大没有随会话带过来** ——' +
          '请让用户**先保存**，再读磁盘上的文件。',
      )
      return
    }
    lines.push('```jhyy')
    lines.push(source.replace(/\r\n/g, '\n').replace(/\s+$/, ''))
    lines.push('```')
  }
  if (ctx.filePath) {
    lines.push(`- **用户当前打开的文件：${ctx.filePath}**`)
    if (ctx.unsaved) {
      lines.push(
        '- ⚠️ 这个文件**有还没保存的修改** —— 磁盘上的内容是旧的。' +
          '下面代码块才是用户现在正在编辑的内容：',
      )
      pushSource()
    }
  } else if (ctx.fileName) {
    /*
      ⚠️ **新建的未命名文件**：它**没有路径**，磁盘上根本不存在 ——
      光看「有没有 filePath」分不清「用户没开文件」和「用户开了个新文件」
      （用户报过：新建的未命名文件在聊天里显示成「没打开文件」，这不对）。

      ⇒ 名字单独报一份，内容也**直接贴出来** —— Claude 在磁盘上读不到它，
      不贴的话它就只能瞎猜用户在写什么。
    */
    lines.push(`- **用户当前打开的是一个新文件（还没保存到磁盘）：${ctx.fileName}**`)
    lines.push(
      '- 这个文件**在磁盘上不存在** —— 你 `Read` 不到它。下面代码块就是用户' +
        '正在编辑的内容：',
    )
    pushSource()
    lines.push(
      '- 你要改它的话：告诉用户改法，或者用 Write 在他的项目里新建一个文件' +
        '（**别自己挑路径**，除非用户说了存哪）。',
    )
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

  /*
    预热 MCP 配置 —— **后台**做，别挡着界面。

    探测「哪个 python 装了 fastmcp」要起一个 python 进程 import 一下，
    要好几秒。以前这一步是在 `claude.start()` 里同步做的 ⇒ 主进程被卡住
    ⇒ 整个 IDE 卡住（用户报过「特别慢特别卡」）。

    ⇒ 现在挪到启动后台跑：用户第一次发消息时配置早好了 ✓。
  */
  void buildMcpConfig().catch(() => {
    /* 探不到就算了 —— Claude 只是少几个 jhyy 工具 */
  })

  /*
    预热**登录 shell 的环境变量** —— 后台做，别挡着界面。

    IDE 不是从登录 shell 起来的 ⇒ 用户 `.bashrc` 里的东西（nvm / rbenv /
    pyenv / conda init / 自建工具的 PATH）一个都没有 ⇒ 终端里「node 找不到」
    「go 不在了」。

    ⇒ 起一个登录 shell 把 env 导出来缓存住（`shellEnv.ts`），
    等用户真开终端时早就有 ✓（导出要 ~0.5-1 秒，不能挡着启动）。
  */
  void loadLoginShellEnv(defaultShell()).catch(() => {
    /* 导不到就退回 IDE 自己的环境 —— 终端照样能开 */
  })

  /*
    **预热 node-pty** —— 把原生模块加载进 Node 的模块缓存。

    ⚠️ **为什么必须趁启动时做**：node-pty 的原生模块是**懒加载**的
    （`require('node-pty')` 不碰它，**第一次 spawn 时**才 require），
    而 **`npm install` 会把那个文件删掉** —— node-pty 自己的 `postinstall`
    脚本有个 bug（拿绝对路径比相对文件名 ⇒ 比不中 ⇒ 把 `build/Release`
    整个清空；我们的 postinstall 随后会重编回来，但**中间有个窗口**）。

    ⇒ 那个窗口里，**正在跑的 IDE** 起新终端就会失败 ⇒ 静悄悄退回管道版
    ⇒ **「终端一会真一会假的」**（用户报过）✓

    ⇒ 启动时先起一个「马上就退出」的真控制台 ⇒ 原生模块进缓存 ⇒
    之后文件被删也不影响（`Module._cache` 按解析后的绝对路径做键）✓。

    ⚠️ **宿主进程那边也预热一遍**（`ptyHost.ts` 自己会做）⇒
      真控制台跑在独立进程里时，原生模块进的是**那个进程**的缓存 ✓
  */
  const warm = warmUpNodePty()
  if (warm.ok) {
    reportPtyBackend({ backend: 'node-pty' })
    console.log('[pty] 终端后端：node-pty（真控制台 / ConPTY）')
  } else {
    reportPtyBackend({ backend: 'pipe', reason: warm.error })
  }

  /*
    **开好第一个终端** —— 用户要的行为：「IDE 一起来就开一个真终端，
    然后一直就用」⇒ 反复点「运行」**不新开**（VS Code 那样）✓

    ⚠️ **别把 IDE 卡住** —— 起 shell 是有点慢的（几百毫秒）⇒
    ⇒ 放在后台，不挡着窗口出来 ✓
  */
  setTimeout(() => {
    try {
      const t = activeTerminal(app.getPath('home'))
      console.log(`[pty] 第一个终端 #${t.id}（${t.backend}）`)
    } catch (err) {
      console.error('[pty] 第一个终端起不来：', err)
    }
  }, 0)

  /*
    **起「pty 宿主进程」** —— 真控制台跑在**独立进程**里。

    ⚠️ **为什么要独立进程**（VS Code 也是这个架构）：
    - **node-pty 崩了不会把 IDE 带走** —— 它是原生模块，段错误就是整个
      Electron 进程死 ⇒ 用户的文件、Claude 会话、终端**全丢** ⇒
      挪出去以后，它崩了只是终端没了，IDE 还活着 ✓
    - **pty 的 I/O 不占主进程的事件循环** —— 主进程还管着编译器、
      Claude CLI、文件监听 ⇒ 终端狂打输出时不该把它们一起拖死 ✓

    ⇒ 宿主进程起不来也不致命 ⇒ 退回「主进程里直接跑 node-pty」✓
  */
  const host = new PtyHost((scriptPath) => {
    const child = utilityProcess.fork(scriptPath, [], { serviceName: 'jhyy-pty-host' })
    return {
      postMessage: (m) => child.postMessage(m),
      onMessage: (cb) => child.on('message', (m) => cb(m)),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
    }
  })
  setPtyHost(host)
  if (!host.start()) {
    console.warn(`[pty] pty 宿主进程起不来：${host.reason ?? '未知原因'} —— 退回主进程内跑 node-pty`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void terminals?.killAll()
  terminals = null
})

app.on('window-all-closed', () => {
  stopRunning()
  if (process.platform !== 'darwin') app.quit()
})
