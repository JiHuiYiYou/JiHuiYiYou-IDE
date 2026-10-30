/**
 * 编译器 / 运行器相关的共享类型。
 * 主进程与渲染进程共用（渲染进程只读，不直接碰 Node API）。
 */

/** 一条诊断。位置是 1-based（与编译器 stderr 输出一致）。 */
export interface Diagnostic {
  /** 诊断指向的文件（可能是绝对路径） */
  file: string
  /** 行号，1-based */
  line: number
  /** 列号，1-based */
  col: number
  /** 错误正文（已去掉 "error: " 前缀） */
  message: string
  severity: 'error' | 'warning'
}

/** 一次编译的结果。 */
export interface CompileResult {
  /** 编译是否成功（无 error 级诊断且退出码为 0） */
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** 解析出来的诊断 */
  diagnostics: Diagnostic[]
  /** 没被识别成诊断的 stderr 行（编译进度噪声等），用于"原始输出"面板 */
  raw: string[]
  durationMs: number
  /** 本次是否跳过了链接（--no-link，只做诊断） */
  noLink: boolean
  /**
   * 输出太多被**截断**了 —— 程序（或编译器）在疯狂打印，IDE 已经把它杀了。
   *
   * ⚠️ 没有上限的话，`while true { printf(...) }` 那种程序会把内存吃光，
   * 整台机器卡死（用户报过）。
   */
  truncated?: boolean
}

/** 一次「编译 + 运行」的结果。 */
export interface RunResult extends CompileResult {
  /** 是否真的执行了产物（编译失败时为 false） */
  ran: boolean
  /** 产物退出码；未运行则继承编译退出码 */
  exitCode: number | null
  /** 退出码是否落在 NTSTATUS 崩溃区间 */
  crashed: boolean
  /** NTSTATUS 名称（如 ACCESS_VIOLATION） */
  crashName?: string
  /** 产物 stdout */
  programStdout: string
  /** 产物 stderr */
  programStderr: string
}

/** 工具链定位结果。 */
export interface ToolchainInfo {
  /** jhyy.exe 的绝对路径 */
  exePath: string
  /** 从哪找到的 */
  source: 'setting' | 'env' | 'dev-build' | 'installed' | 'path'
  /** 探测是否成功（跑 `jhyy --help` 退出码为 0） */
  available: boolean
  /** 探测失败时的原因 */
  error?: string
  /** 编译器自报的版本（仅作展示，编译器自身两处版本号不同步，别依赖它做判断） */
  versionText?: string
}
