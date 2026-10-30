/**
 * 终端相关的共享类型。
 *
 * ⚠️ **终端没有 PTY** —— 这台开发机没有 MSVC，`node-pty` 装不上（详见 CLAUDE.md）。
 * 所以走 `child_process.spawn` 的管道 stdio，代价是没有真 TTY：
 * - `vim` / `top` 这类全屏 TUI 程序跑不了
 * - 子进程收不到窗口尺寸（我们在 spawn env 里塞 `COLUMNS` / `LINES` 糊弄一下）
 * - ANSI 转义序列照常工作（xterm 自己解析）
 */

/** 终端用哪种 shell。 */
export type TerminalShell = 'powershell' | 'cmd' | 'bash'

export interface TerminalStartRequest {
  shell?: TerminalShell
  /** 起始目录 —— 一般是当前打开的 .jhyy 所在目录 */
  cwd?: string
}

export interface TerminalStartResult {
  ok: boolean
  shell: TerminalShell
  cwd: string
  error?: string
}

/** main → renderer：已经做过 CRLF 归一的输出。 */
export interface TerminalDataEvent {
  data: string
}

/** main → renderer：shell 进程退出了。 */
export interface TerminalExitEvent {
  code: number | null
}

/** main → renderer：IDE 执行了一条命令（终端里已经显示出来了）。 */
export interface TerminalCommandEvent {
  /** 给人看的命令行 */
  command: string
  /**
   * 要不要把底部面板切到「终端」页签？
   *
   * - 运行 ⇒ `true` —— 程序的输出就在终端里，切过去跟 VS Code 一样
   * - 检查 ⇒ `false` —— 用户是来看诊断的，别把面板抢走
   */
  focus: boolean
}
