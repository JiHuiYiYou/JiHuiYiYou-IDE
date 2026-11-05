import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import type { TerminalShell } from '@shared/terminal'
import { buildSubprocessEnv } from './compiler/env'
import { OutputBatcher, type PtySession, type PtySpawnOptions } from './pty'
import { shellCommandArgs, withShellIntegration } from './shellIntegration'
import { loadLoginShellEnvSync, mergeShellEnv } from './shellEnv'

/**
 * **管道版**的终端后端 —— `child_process.spawn` + 管道 stdio。
 *
 * ## 它什么时候被用
 *
 * **兜底** —— `node-pty`（真控制台版，`ptyNode.ts`）是**可选依赖**：
 * 它是原生模块，要按 **Electron 的 ABI** 重编 ⇒ 需要 **MSVC Build Tools**。
 * 没装 MSVC 的机器（CI、别人的开发机）编不出来 ⇒ `ptyFactory.ts` 就用这一版。
 *
 * 代价：
 * - `vim` / `top` 这类全屏 TUI 程序跑不了（没有 TTY）
 * - 子进程收不到窗口尺寸（我们在 env 里塞 `COLUMNS` / `LINES` 糊弄一下）
 * - **stdout 是管道 ⇒ C 运行时全缓冲** ⇒ 交互式程序的提示要等程序退出才显示
 *   （这一条在**语言仓库**那边修了：`compiler/runtime/runtime.c` 的
 *   `setvbuf(stdout, NULL, _IONBF, 0)`）
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
export function normalizeNewlines(s: string): string {
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
  cdCommand: (dir: string, eol: '\r' | '\n') => string
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
 * ⚠️ **默认是 PowerShell**（跟 VS Code 一样）——
 *
 * 用户明说「VS Code 那个就不是那种感觉」⇒ 指的是**提示符不一样**：
 * VS Code 里那个漂亮的 `(base) PS C:\...` 是**用户自己的 profile** 画的
 * （starship / oh-my-posh）⇒ 我们也**加载用户的 profile** ⇒
 * 提示符就一模一样了 ✓
 *
 * ⚠️ **以前是 MSYS2 的 bash**，理由是「bash 的 readline 在**管道**下有真正的
 *    行编辑」⇒ 但那是**管道版**的问题 ⇒ 现在真控制台（ConPTY）跑起来了 ⇒
 *    **PSReadLine 在真控制台里是完整的** ⇒ 老理由不成立 ✓
 *    （管道兜底时 PowerShell 的退格仍有问题 —— 那是没有 node-pty 的少数机器）
 */
export function defaultShell(): TerminalShell {
  return 'powershell'
}

function shellSpec(shell: TerminalShell, shellCommand?: string, noProfile = false): ShellSpec {
  switch (shell) {
    case 'cmd':
      return {
        exe: 'cmd.exe',
        // /Q 去掉命令回显（只留 `C:\...>` 提示符），免得终端里每条命令显示两遍
        // ⚠️ **有命令 ⇒ `/C`（跑完就退出）** ⇒ 不用交互模式 ✓
        args: shellCommand ? ['/Q', '/C', shellCommand] : ['/Q'],
        // cmd 的输出走 OEM 代码页 —— 中文系统上是 GBK
        stdoutEncoding: detectOemEncoding(),
        stderrEncoding: detectOemEncoding(),
        cdCommand: (dir, eol) => `cd /d "${dir.replace(/"/g, '""')}"${eol}`,
      }
    case 'bash':
      return {
        exe: bashPath() ?? 'bash.exe',
        // ⚠️ `--init-file` 注入 shell 集成（OSC 633）—— 详见 `shellIntegration.ts`
        // ⚠️ **有命令 ⇒ `-c`（跑完就退出）** ⇒ 不要 `-i`、也不要 init-file
        //    （`-c` 模式下 bash 根本不读 init-file ⇒ 装了也没用）
        args: shellCommand
          ? shellCommandArgs('bash', shellCommand)
          : withShellIntegration('bash', ['-i']),
        stdoutEncoding: 'utf-8',
        stderrEncoding: 'utf-8',
        cdCommand: (dir, eol) => `cd "${dir.replace(/"/g, '\\"')}"${eol}`,
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
         *
         * ⚠️ `withShellIntegration` 会在 `-Command` 后面接一句 dot-source ——
         *    那是 shell 集成脚本（OSC 633）⇒ IDE 才知道 shell 的当前目录、
         *    是不是空闲、上一条命令的退出码 ✓。
         */
        args: shellCommand
          ? shellCommandArgs('powershell', shellCommand, {
              // ⚠️ **profile 的 env 已经注入到进程 env 里了** ⇒ 不用再加载 profile ✓
              noProfile,
            })
          : withShellIntegration('powershell', [
              '-NoLogo',
              // ⚠️ **不要 -NoProfile** —— 用户的 profile 里通常有 starship 之类 ⇒
              //    提示符才跟 VS Code 里一模一样（用户明说要「跟 VS Code 那个感觉」）✓
              '-NoExit',
              '-Command',
              '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
                '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
            ]),
        stdoutEncoding: 'utf-8',
        stderrEncoding: 'utf-8',
        // PowerShell 的单引号字面量里，单引号要写成两个
        cdCommand: (dir, eol) => `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'${eol}`,
      }
  }
}

/**
 * 换目录要往 shell 里发的那条命令（管道没法改 cwd ⇒ 只能发命令）。
 *
 * ⚠️⚠️ **行尾只能是** `\r` **或** `\n` **一个** —— **`\r\n` 是两个回车**
 *    ⇒ shell 会打**两个**提示符、中间还夹一个空行 ⇒
 *    终端里就是「一堆空提示符」（用户报过）✓
 *    （实测：管道版和真控制台版，`\r\n` ⇒ 2 个提示符；`\n` / `\r` ⇒ 1 个 ✓）
 *
 * @param eol 行尾 —— 管道用 `\n`、真控制台用 `\r`（见 `PtySession.lineEnding`）
 */
export function shellCdCommand(shell: TerminalShell, dir: string, eol: '\r' | '\n' = '\n'): string {
  return shellSpec(shell).cdCommand(dir, eol)
}

/**
 * 管道版后端。
 *
 * ⇒ 「终端面板」和「运行按钮」**共用**它（运行按钮传 `command` ⇒ 起的是
 * 编译出来的程序，不是 shell）。
 */
export class PipePtySession implements PtySession {
  private child: ChildProcess | null = null
  private exited = false
  private readonly batcher: OutputBatcher
  private readonly dataListeners: ((data: string) => void)[] = []
  private readonly exitListeners: ((code: number | null) => void)[] = []
  /** 退出**通知过了**吗？（'error' 之后可能还会来 'exit' ⇒ 别通知两次） */
  private exitNotified = false
  /** 当前窗口尺寸（管道版改不了已经在跑的进程 ⇒ 只给下一个用） */
  private cols: number
  private rows: number

  constructor(private readonly opts: PtySpawnOptions) {
    this.cols = opts.cols ?? 120
    this.rows = opts.rows ?? 30
    this.batcher = new OutputBatcher((text) => {
      for (const cb of this.dataListeners) cb(text)
    })
    this.spawn()
  }

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  /** 管道版**不会**回显 ⇒ IDE 得自己回显（见 `PtySession.echoesInput`）。 */
  readonly echoesInput = false

  /** 这是管道版（不是真控制台）。 */
  readonly backend = 'pipe' as const

  /** 管道里 shell 按 `\n` 切行 ⇒ 行尾用 `\n`（**不能 `\r\n`**，那是两个回车）。 */
  readonly lineEnding = '\n' as const

  /** 订阅输出（构造之后补订阅也能收到 —— 队列里已经攒着的会在下一批发出）。 */
  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb)
  }

  /** 订阅退出。 */
  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb)
  }

  /**
   * **通知「这个会话结束了」**（只通知一次）。
   *
   * ⚠️ spawn 失败时 Node **只发 'error'、不发 'exit'** ⇒ 只在 'exit' 里通知
   *    的话 ⇒ 上层（终端登记表）永远不知道 ⇒ **死终端留在列表里变僵尸** ✗
   */
  private notifyExit(code: number | null): void {
    if (this.exitNotified) return
    this.exitNotified = true
    for (const cb of this.exitListeners) cb(code)
  }

  /**
   * 改窗口尺寸。
   *
   * ⚠️ **管道版做不到实时改** —— 没有 TIOCSWINSZ，已经在跑的 shell 收不到
   * （它的 `stty size` 不会变 ⇒ `vim` 分屏会错位）。
   * ⇒ 这里只**记下来**，给**下一个**起的进程用（`COLUMNS`/`LINES`）。
   */
  resize(cols: number, rows: number): void {
    if (cols > 0) this.cols = cols
    if (rows > 0) this.rows = rows
  }

  /** 往 stdin 写。 */
  write(data: string): void {
    if (!this.child?.stdin || this.exited) return
    try {
      this.child.stdin.write(this.encodeForShell(data))
    } catch {
      // 管道已经断了 —— 忽略，退出事件会跟上
    }
  }

  /** 杀掉进程树。 */
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
    // 攒着的输出别再发了（进程都没了）
    this.batcher.dispose()
    this.exited = true
  }

  /** 真正把进程拉起来。 */
  private spawn(): void {
    const spec = shellSpec(this.opts.shell, this.opts.shellCommand, this.opts.noProfile)
    /*
     * ⚠️ **环境变量来自「登录 shell」**，不是 IDE 自己那份。
     *
     * IDE 不是从登录 shell 起来的 ⇒ 用户 `.bashrc` 里的东西（**nvm、rbenv、
     * pyenv、conda init、自建工具的 PATH**）一个都没有 ⇒ 表现就是「终端里
     * node 找不到」「go 不在了」。
     *
     * ⇒ 起一个登录 shell 把 env 导出来再叠上去（`shellEnv.ts`，带缓存；
     * IDE 启动时预热 ⇒ 开终端时早就有）。
     */
    const loginEnv = loadLoginShellEnvSync(this.opts.shell)
    const env = {
      ...buildSubprocessEnv(
        mergeShellEnv(process.env, loginEnv?.vars ?? null) as Record<string, string>,
      ),
      ...(this.opts.env ?? {}),
      // 管道没有 TTY，但程序有时会读这两个变量 —— 给个合理的值
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
      TERM: 'xterm-256color',
    }

    // 「运行」按钮 ⇒ 起的是编译出来的程序（不经 shell）
    const exe = this.opts.command?.exe ?? spec.exe
    const args = this.opts.command?.args ?? spec.args

    const child = spawn(exe, args, {
      cwd: this.opts.cwd,
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
      this.batcher.push(normalizeNewlines(outDecoder.decode(chunk, { stream: true })))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.batcher.push(normalizeNewlines(errDecoder.decode(chunk, { stream: true })))
    })
    child.on('error', (err) => {
      this.batcher.push(normalizeNewlines(`\r\n[无法启动 shell：${err.message}]\r\n`))
      this.batcher.flushNow()
      this.exited = true
      /*
        ⚠️⚠️ **必须通知退出回调** ——
        spawn 失败（ENOENT 之类）时 Node **只发 'error'，不发 'exit'**
        ⇒ 以前这里不通知 ⇒ 上层（终端登记表）**不知道这个终端死了**
        ⇒ 它就**留在列表里**（僵尸标签）⇒ 还是「当前那个」
        ⇒ 下次「运行」看到 `running === false` ⇒ **在旁边再开一个**
        ⇒ 终端标签越点越多 ✗
      */
      this.notifyExit(null)
    })
    child.on('exit', (code) => {
      // 进程没了 ⇒ 把攒着的最后一段发出去，别丢
      this.batcher.flushNow()
      this.exited = true
      this.notifyExit(code)
    })
    child.stdin?.setDefaultEncoding('utf8')
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
    if (this.opts.shell !== 'powershell') return data
    return data.replace(/\x7f/g, '\x08')
  }
}
