import { stripAnsi } from '@shared/ansi'
import { createPtySession } from './ptyFactory'
import type { PtySession } from './pty'

/**
 * 在 **pty（真控制台）** 里跑一个编译出来的程序。
 *
 * ## 为什么不用管道
 *
 * 管道的 stdout **不是控制台** ⇒ C 运行时**全缓冲** ⇒ 交互式程序的
 * 「请输入一个数字：」要等程序退出才显示（用户报过：「输出在输入之前，
 * 却只会在输入之后打印」）。
 *
 * ⇒ 走 pty ⇒ 程序拿到**控制台设备** ⇒ `isatty(1)` 为 TRUE ⇒
 * C 运行时**不缓冲** ⇒ 提示立刻可见 ✓，交互式程序也能跑 ✓。
 *
 * ⚠️ 语言仓库那边也加了 `setvbuf(stdout, NULL, _IONBF, 0)`（`runtime.c`）⇒
 * 那是**兜底**（用户把输出重定向到文件时照样生效）⇒ 两边都要 ✓。
 *
 * ## 输出分两路
 *
 * - **终端**要**原样**（xterm 解析转义序列 ⇒ 颜色/光标都对 ✓）
 * - **输出面板**要**纯文本** ⇒ 剥一遍转义序列 ✓
 */

export interface PtyRunOptions {
  /** 编译产物的 exe（完整路径） */
  exe: string
  /** 工作目录 */
  cwd: string
  /** 超时（毫秒）—— 默认 60 秒（等输入得给用户时间打字） */
  timeoutMs?: number
  /** 输出上限（字符数）—— 超了立刻杀掉程序（`while true` 那种） */
  maxCapture?: number
  /** 输出（**已剥转义**）—— 给「输出面板」 */
  onOutput: (stream: 'stdout' | 'stderr', text: string) => void
  /** 输出（**原样**）—— 给终端 */
  onRaw?: (text: string) => void
  /** 程序起来了 ⇒ 把「往 stdin 写」的能力交出去 */
  onStart?: (write: (text: string) => void, echoesInput: boolean) => void
  /**
   * 程序起来了 ⇒ 把**会话**交出去（「停止」按钮要能杀掉它）。
   *
   * ⚠️ 以前程序跑在管道上时，停止靠 `stopRunning()`（管道版的 runner 自己记着
   *    child）⇒ 换成 pty 之后那条路断了 ⇒ 「停止」按钮会**什么也不干** ✗
   *    ⇒ 所以这里把会话交出去，由主进程记着 ✓。
   */
  onSession?: (session: PtySession) => void
}

export interface PtyRunResult {
  /** 退出码（被信号杀掉时是 null） */
  exitCode: number | null
  /** 输出超上限被杀了 */
  truncated: boolean
  /** 超时被杀了 */
  timedOut: boolean
  durationMs: number
}

/**
 * 默认超时（毫秒）—— **0 = 不超时**。
 *
 * ⚠️⚠️ **以前是 60 秒 ⇒ 用户报过「长时间不理它会程序中断，我不希望它中断」** ——
 *
 * 那**不是程序自己中断的**，是 **IDE 超时把它杀了**：
 * - 超时 ⇒ `pty.kill()` ⇒ 杀掉整个 ConPTY ⇒ 前台程序收到 `CTRL_CLOSE_EVENT`
 *   ⇒ 退出码 `0xC000013A`（`CONTROL_C_EXIT`）
 * - 而**超时这件事根本没往上传** ⇒ 状态栏只能按退出码判 ⇒
 *   ⇒ 显示成「**程序已中断**」⇒ 看着像程序自己断的 ✗
 *
 * ⇒ 现在**默认不超时**（VS Code 的任务终端就是这样：跑到自己结束，
 *   或者你按「停止」）✓
 * ⇒ 真要超时，`RunRequest.timeoutMs` 传进来就行 ⇒ 而且**超时会单独报**
 *   （「程序超时，已终止」），不跟「中断」混 ✓
 */
const DEFAULT_TIMEOUT_MS = 0
/**
 * 默认输出上限（字符数）。
 *
 * ⚠️ **以前是 512 KB** —— 那太小了：一个正常打印个表格的程序就可能被杀掉 ✗
 * ⇒ 现在 8 MB ⇒
 * ⚠️ **为什么还需要这个上限** —— 程序无限打印（比如 `while true`）会把内存吃光
 *    ⇒ 机器换页 ⇒ **整个 IDE 卡死**（用户报过）✓
 *    ⇒ 有**背压**（ack，见 `terminal.ts`）之后，IPC 队列是有界的 ✓
 *    ⇒ 这个上限守的是「捕获下来的那份文本」的内存 ✓
 */
const DEFAULT_MAX_CAPTURE = 8 * 1024 * 1024

/**
 * 在 pty 里跑一个程序，等它结束。
 *
 * ⚠️ **不会吞掉 stdin** —— 程序要读输入时，调用方通过 `onStart` 拿到写入器
 * （把终端里敲的字喂进去 ✓）。
 */
export async function runProgramInPty(opts: PtyRunOptions): Promise<PtyRunResult> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxCapture = opts.maxCapture ?? DEFAULT_MAX_CAPTURE

  let truncated = false
  let timedOut = false
  let captured = 0

  const pty = createPtySession({
    // shell 用哪个无所谓 —— `command` 覆盖了它（起的是编译产物）
    shell: 'bash',
    cwd: opts.cwd,
    command: { exe: opts.exe, args: [] },
  })

  // 会话交出去（「停止」按钮要能杀掉它）
  opts.onSession?.(pty)

  const finished = new Promise<number | null>((resolve) => {
    pty.onData((text) => {
      captured += text.length
      if (captured > maxCapture) {
        // 程序在疯狂打印 ⇒ 立刻杀掉（不然机器开始换页）
        truncated = true
        void pty.kill()
        return
      }
      opts.onRaw?.(text)
      opts.onOutput('stdout', stripAnsi(text))
    })
    pty.onExit((code) => resolve(code))
  })

  // 程序**刚起来**就把写 stdin 的能力交出去 ——
  // ⚠️ 等 promise resolve 就太晚了（那时程序已经跑完，scanf 早就 EOF 了）。
  opts.onStart?.((text: string) => pty.write(text), pty.echoesInput)

  // ⚠️ **默认不超时**（`timeoutMs === 0`）⇒ 程序要跑多久就多久 ✓
  //    （用户报过「长时间不理它会程序中断，我不希望它中断」⇒ 那是 IDE 超时杀的 ✗）
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          void pty.kill()
        }, timeoutMs)
      : null

  const exitCode = await finished
  if (timer) clearTimeout(timer)

  return { exitCode, truncated, timedOut, durationMs: Date.now() - started }
}
