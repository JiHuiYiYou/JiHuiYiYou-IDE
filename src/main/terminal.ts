import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { TerminalDataEvent, TerminalExitEvent, TerminalShell } from '@shared/terminal'
import { buildSubprocessEnv } from './compiler/env'

/**
 * 终端会话 —— **没有 PTY**。
 *
 * ⚠️ 为什么不用 `node-pty`：这台开发机没有 MSVC，`node-pty` 只有 Node ABI 的预编译产物，
 * Electron 必须 `@electron/rebuild` 从源码编 → 装不上 → 本地 `npm install` 直接失败。
 * 所以走 `child_process.spawn` 的管道 stdio。代价（写进文档了）：
 * - `vim` / `top` 这类全屏 TUI 程序跑不了
 * - 子进程收不到窗口尺寸（我们在 env 里塞 `COLUMNS` / `LINES` 糊弄一下）
 * - ANSI 转义序列照常工作（xterm 自己解析）
 *
 * 管道带来的两个必做对的细节：
 * 1. **CRLF 归一** —— Windows 控制台默认 ONLCR（把 LF 转成 CRLF），但管道没有终端，
 *    没人替我们做。实测 PowerShell 的**回显里是裸 `\n`** —— VT 终端里裸 LF 只下移一行
 *    不回列 0，「ello」会落在下一行第 14 列，看起来是花的。
 * 2. **按 shell 选编码** —— 中文 Windows 上 cmd 的输出是 **OEM 代码页（GBK）**，
 *    按 UTF-8 解会满屏乱码。
 */

/** 归一换行：所有 `\r\n` / `\n` / `\r` 都变成 `\r\n`。 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n|\r|\n/g, '\r\n')
}

/**
 * Windows OEM 代码页 → Node `TextDecoder` 的编码名。
 *
 * 只列常见的；查不到就退回 utf-8（英文系统上 OEM 就是 ASCII，没差别）。
 */
const OEM_ENCODINGS: Record<number, string> = {
  437: 'ibm437',
  708: 'iso-8859-6',
  720: 'windows-720',
  737: 'ibm737',
  775: 'windows-775',
  850: 'ibm850',
  852: 'ibm852',
  855: 'ibm855',
  857: 'ibm857',
  860: 'ibm860',
  861: 'ibm861',
  862: 'ibm862',
  863: 'ibm863',
  865: 'ibm865',
  866: 'ibm866',
  869: 'ibm869',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
}

let oemEncodingCache: string | null = null

/**
 * 探测当前 OEM 代码页。
 *
 * `chcp` 的输出里带本地化的文字，用 latin1 解（不会抛，数字还是数字），
 * 只取**最后一行**结尾的那个数字 —— 前面的横幅里也有版本号，不能取错。
 */
function detectOemEncoding(): string {
  if (oemEncodingCache) return oemEncodingCache
  oemEncodingCache = 'utf-8'
  try {
    const out = execFileSync('cmd.exe', ['/c', 'chcp'], { encoding: 'latin1' })
    const lines = out.trim().split(/\r?\n/)
    const last = lines[lines.length - 1] ?? ''
    const m = last.match(/(\d{3,5})\s*$/)
    if (m) {
      const enc = OEM_ENCODINGS[Number(m[1])]
      if (enc) oemEncodingCache = enc
    }
  } catch {
    // 探测不到就用 utf-8
  }
  return oemEncodingCache
}

/** 各 shell 的可执行文件、参数和编码。 */
interface ShellSpec {
  exe: string
  args: string[]
  /** stdout 的解码编码 */
  stdoutEncoding: string
  /** stderr 的解码编码 */
  stderrEncoding: string
  /** 换目录要往 shell 里发的那条命令（管道没法改 cwd） */
  cdCommand: (dir: string) => string
}

function bashPath(): string | null {
  // 注意：C:\msys64\ucrt64\bin\bash.exe **不存在**，只有 usr\bin 那个。
  const candidates = [
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\ucrt64\\bin\\bash.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * 默认用哪个 shell。
 *
 * ⚠️ **优先 MSYS2 的 bash** —— 不是因为它"更像 Unix"，而是因为：
 * - **bash 的 readline 在管道下有真正的行编辑** —— 退格会真的擦掉、
 *   方向键能移动、历史能翻，**而且会增量回显**（你看得见自己打的字）。
 * - **PowerShell 在管道下没有**：它的行编辑器（PSReadLine）在重定向输入时
 *   会把 BS 字节原样吐回、**甚至把整个 shell 卡死**（实测：行首一个退格
 *   就让 shell 不再响应）。
 *
 * MSYS2 是本项目的硬依赖（gcc 链接要它），所以基本都在。
 * 没有 MSYS2 就退回 PowerShell。
 */
export function defaultShell(): TerminalShell {
  return bashPath() ? 'bash' : 'powershell'
}

function shellSpec(shell: TerminalShell): ShellSpec {
  switch (shell) {
    case 'cmd':
      return {
        exe: 'cmd.exe',
        // /Q 去掉命令回显（只留 `C:\...>` 提示符），免得终端里每条命令显示两遍
        args: ['/Q'],
        // cmd 的输出走 OEM 代码页 —— 中文系统上是 GBK
        stdoutEncoding: detectOemEncoding(),
        stderrEncoding: detectOemEncoding(),
        cdCommand: (dir) => `cd /d "${dir.replace(/"/g, '""')}"\r\n`,
      }
    case 'bash':
      return {
        exe: bashPath() ?? 'bash.exe',
        args: ['-i'],
        stdoutEncoding: 'utf-8',
        stderrEncoding: 'utf-8',
        cdCommand: (dir) => `cd "${dir.replace(/"/g, '\\"')}"\r\n`,
      }
    case 'powershell':
    default:
      return {
        exe: 'powershell.exe',
        /**
         * ⚠️ **必须显式把编码设成 UTF-8**（输出 + 输入）。
         *
         * 实测（这台中文 Windows）：
         * - stdout 默认就是 UTF-8 ✓
         * - **stderr 是 OEM 代码页（GBK）** ✗ —— 中文报错全是乱码
         * - stdin 默认也是 UTF-8 ✓
         *
         * 只设 `[Console]::OutputEncoding` 会**顺带把输入也改掉**（回显变乱码），
         * 所以两个都得设。
         *
         * `-NoExit` 让 shell 执行完这条命令后**不退出**、进入交互模式
         * （这样才有真提示符 + 回显 + 逐行执行）。
         * `-Command` 跑的命令**不会被回显**（不像往 stdin 塞第一行那样吵）。
         */
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NoExit',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
            '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        ],
        stdoutEncoding: 'utf-8',
        stderrEncoding: 'utf-8',
        // PowerShell 的单引号字面量里，单引号要写成两个
        cdCommand: (dir) => `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'\r\n`,
      }
  }
}

export interface TerminalSessionOptions {
  shell: TerminalShell
  cwd: string
  /** 主进程 → 渲染进程的推送 */
  onData: (event: TerminalDataEvent) => void
  onExit: (event: TerminalExitEvent) => void
}

export class TerminalSession {
  private child: ChildProcess | null = null
  private shell: TerminalShell
  private cwd: string
  private exited = false
  /**
   * 用户当前这一行**有没有输入**。
   *
   * ⚠️ 用来防一件坏事：IDE 在终端里跑完程序后要**让 shell 重打一遍提示符**，
   * 而重打提示符的办法是往 stdin 发一个空行（回车）—— 如果这时候用户正
   * 敲着半截命令，那一杆子回车会把**半截命令执行掉**。
   * 所以有输入的时候就不发。
   */
  private pendingInput = false

  constructor(private readonly opts: TerminalSessionOptions) {
    this.shell = opts.shell
    this.cwd = opts.cwd
  }

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  get currentShell(): TerminalShell {
    return this.shell
  }

  get currentCwd(): string {
    return this.cwd
  }

  start(): void {
    if (this.child) return
    const spec = shellSpec(this.shell)
    const env = {
      ...buildSubprocessEnv(),
      // 管道没有 TTY，但程序有时会读这两个变量 —— 给个合理的值
      COLUMNS: '120',
      LINES: '30',
      TERM: 'xterm-256color',
    }
    const child = spawn(spec.exe, spec.args, {
      cwd: this.cwd,
      env,
      // 不加这个的话每次 spawn 旁边都会闪一个黑色控制台窗口
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.exited = false

    // ⚠️ **不能用 `setEncoding('utf8')`** —— cmd 的输出是 OEM 代码页（GBK），
    // 按 UTF-8 解会满屏乱码。用 `TextDecoder` 按 shell 选编码，
    // 而且 `stream: true` 让跨 chunk 的半个多字节字符也能正确拼回来。
    const outDecoder = new TextDecoder(spec.stdoutEncoding)
    const errDecoder = new TextDecoder(spec.stderrEncoding)

    child.stdout?.on('data', (chunk: Buffer) => {
      this.opts.onData({ data: normalizeNewlines(outDecoder.decode(chunk, { stream: true })) })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.opts.onData({ data: normalizeNewlines(errDecoder.decode(chunk, { stream: true })) })
    })
    child.on('error', (err) => {
      this.opts.onData({ data: normalizeNewlines(`\r\n[无法启动 shell：${err.message}]\r\n`) })
      this.exited = true
    })
    child.on('exit', (code) => {
      this.exited = true
      this.opts.onExit({ code })
    })
    child.stdin?.setDefaultEncoding('utf8')
  }

  /** 往 stdin 写（这是**给 shell 的输入**）。 */
  write(data: string): void {
    if (!this.child?.stdin || this.exited) return
    this.trackInput(data)
    try {
      this.child.stdin.write(this.encodeForShell(data))
    } catch {
      // 管道已经断了 —— 忽略，退出事件会跟上
    }
  }

  /**
   * 记住「用户当前这一行有没有输入」。
   *
   * 只有**可打印字符**才算输入；控制字符（方向键、退格…）不算 ——
   * 方向键不会产生内容，退格只会把内容删短。
   */
  private trackInput(data: string): void {
    // 回车 / 换行 = 这行提交了 ⇒ shell 又回到空行
    if (data.includes('\r') || data.includes('\n')) {
      this.pendingInput = false
      return
    }
    const printable = data.replace(/[\x00-\x1f\x7f]/g, '')
    if (printable.length > 0) this.pendingInput = true
  }

  /**
   * 让 shell **重打一遍提示符**。
   *
   * ⚠️ 为什么要发一个空行（回车）而不是自己画提示符：
   * 各家 shell 的提示符格式、颜色、转义序列都不一样（bash 会发 OSC 标题
   * 序列 + 彩色 `user@host`，PowerShell 又是一套）。自己画必然对不上。
   * 而 shell 执行完一个**空行**之后，**自己**会把提示符打出来 —— 那是真的。
   *
   * 用户报过：「每次终端执行完程序都不会显示 `user@host ~/dir` 那一行」。
   */
  prompt(): void {
    // 用户正在敲命令 —— 别把人家半截命令执行了
    if (this.pendingInput) return
    this.write('\r')
  }

  /**
   * 按 shell 的口味调整按键字节。
   *
   * ⚠️ **退格**：xterm.js 按 Unix 传统发 DEL(0x7f)。
   * - bash 的 readline 认 DEL ✓（也认 BS）
   * - **PowerShell 在管道下只认 BS(0x08)** —— 发 DEL 退格**完全没反应**
   *
   * 真 Windows 控制台发的也是 BS，所以给 PowerShell 转成 BS 是对的。
   */
  private encodeForShell(data: string): string {
    if (this.shell !== 'powershell') return data
    return data.replace(/\x7f/g, '\x08')
  }

  /**
   * 只写**显示层**，不进 shell 的 stdin。
   *
   * ⚠️ 程序的输出必须走这里 —— 走 `write()` 会被 shell 当成**输入的命令**执行掉
   * （终端里跑出来的程序输出会被 PowerShell 当命令跑一遍）。
   */
  display(text: string): void {
    this.opts.onData({ data: text })
  }

  /**
   * 把一条**已经执行过的命令**显示在终端里（不发给 shell）。
   *
   * 跟 VS Code 的任务终端一个样：IDE 的按钮触发了什么命令，终端里就看得见什么。
   * 只写到显示层，不进 stdin —— 所以 shell 不会把它当输入执行一遍。
   */
  echo(command: string): void {
    this.display(`\x1b[90m> ${command}\x1b[0m\r\n`)
  }

  /** 换目录。管道改不了 cwd，只能往 shell 里发一条 cd 命令。 */
  cd(dir: string): void {
    this.cwd = dir
    this.write(shellSpec(this.shell).cdCommand(dir))
  }

  /**
   * 杀掉 shell **进程树**。
   *
   * `child.kill()` 在 Windows 上只杀自己，子孙进程（比如你敲 `notepad`）会留下来。
   * 复用 Claude 会话那边的 `taskkill /T /F` 做法。
   */
  async kill(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    if (child.pid && !this.exited) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve())
      })
    } else {
      child.kill()
    }
    this.exited = true
  }
}
