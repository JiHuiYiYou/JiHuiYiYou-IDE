import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ClaudeStartOptions, ClaudeStatus } from '@shared/claude'
import { IPC, type CompileRequest, type RunRequest } from '@shared/ipc'
import { locateClaude } from './claude/locate'
import { ClaudeSession } from './claude/session'
import { locateJhyy } from './compiler/locate'
import { compileFile, runFile, stopRunning } from './compiler/runner'
import { ProjectWatcher } from './watcher'

/** 用户在设置里指定的 jhyy.exe 路径（优先于自动探测）。 */
let toolchainOverride: string | undefined

/** 启动参数里带来的文件（`electron . xxx.jhyy`）。 */
let startupFilePath: string | null = null

/** 当前的 Claude Code 会话。 */
let claudeSession: ClaudeSession | null = null

/** 项目文件监听器 —— 用来发现「文件在 IDE 外面被改了」。 */
const projectWatcher = new ProjectWatcher((path) => {
  broadcast(IPC.fileChanged, path)
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14161c',
    title: 'JHYY IDE',
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
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '打开 JHYY 源文件',
          filters: [{ name: 'JHYY 源文件', extensions: ['jhyy'] }],
          properties: ['openFile'],
        })
      : await dialog.showOpenDialog({
          title: '打开 JHYY 源文件',
          filters: [{ name: 'JHYY 源文件', extensions: ['jhyy'] }],
          properties: ['openFile'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const content = await readFile(path, 'utf8')
    return { path, content }
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
    await writeFile(path, content, 'utf8')
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
    return compileFile({
      exePath: toolchain.exePath,
      file: req.file,
      noLink: req.noLink,
      extraArgs: req.extraArgs,
    })
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
    return runFile({
      exePath: toolchain.exePath,
      file: req.file,
      timeoutMs: req.timeoutMs,
    })
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
}

/** 给所有窗口广播一个事件。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * 追加给 Claude Code 的 system prompt —— 一份 JHYY 速查。
 *
 * ⚠️ 用的是 `--append-system-prompt`（**追加**）而不是 `--system-prompt`
 * （**替换**）—— 替换会把 Claude Code 内置的工具用法说明一起顶掉，
 * 它用工具的能力会明显变差。
 */
function jhyyCheatSheet(): string {
  return [
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
    '',
    '写完代码后，用 jhyy_check 工具编译检查，用 jhyy_run 工具实际跑一遍，',
    '根据真实报错修改 —— 别靠猜。',
  ].join('\n')
}

void app.whenReady().then(() => {
  registerIpc()
  startupFilePath = filePathFromArgv(process.argv)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopRunning()
  if (process.platform !== 'darwin') app.quit()
})
