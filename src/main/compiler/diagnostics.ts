import type { Diagnostic } from '@shared/jhyy'

/**
 * 解析 jhyy.exe 的 stderr，抽出诊断。
 *
 * ⚠️ 正则必须**盘符感知**。MCP server 里那份 `^([^:]+):(\d+):(\d+):\s*(.+)$`
 * （mcp-jhyy/jhyy_runner.py:266）用 `[^:]+` 匹配文件名，而 `[^:]` 跨不过 Windows
 * 盘符的冒号 —— 对 `C:\path\x.jhyy:12:8: error: ...` 会整条匹配失败，
 * file/line/col 被静默丢成空。所以这里用**贪婪**的 `(.*)`。
 */
const DIAG_RE = /^(.*):(\d+):(\d+):\s*(error|warning)\s*:\s*(.*)$/

/**
 * 编译成功时 stderr 上也有进度噪声。这些不是诊断，得滤掉，
 * 否则会灌进问题面板。
 */
const PROGRESS_RE = /^\[\d+[a-z]?\]\s/

/**
 * IDE 自己传 `--no-link` 时，编译器会回执一行：
 *
 * ```
 * compile: --no-link set, skipping gcc link (.s kept at C:\...\jhyy-ide-work\x.s)
 * ```
 *
 * ⚠️ 这是**编译器有意打的**（不是它坏了），但对 IDE 的用户来说是纯噪声：
 * - `--no-link` 是 **IDE 自己**传的 —— 用户没要求，状态栏也已经写着「仅检查」；
 * - `.s kept at` 指的那个目录是 **IDE 自己的临时目录**（`%TEMP%\jhyy-ide-work`），
 *   用户拿它没用。
 *
 * 所以在 IDE 这一侧滤掉。完整 stderr 仍然保留在 `CompileResult.stderr` 里
 * （一致性门匹配 EXPECT-ERROR 关键词靠的就是它），不会丢信息。
 */
const NO_LINK_NOTICE_RE = /^compile:\s*--no-link set\b/

const SUMMARY_LINES = new Set(['parse errors', 'semantic errors', 'import resolution failed'])

export interface ParsedDiagnostics {
  diagnostics: Diagnostic[]
  /** 没被识别成诊断的行 */
  raw: string[]
}

/** 把 stderr 拆成诊断与非诊断行。 */
export function parseDiagnostics(stderr: string): ParsedDiagnostics {
  const diagnostics: Diagnostic[] = []
  const raw: string[] = []

  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 进度噪声与结尾摘要
    if (PROGRESS_RE.test(trimmed)) continue
    if (NO_LINK_NOTICE_RE.test(trimmed)) continue
    if (SUMMARY_LINES.has(trimmed)) continue

    const m = DIAG_RE.exec(trimmed)
    if (m) {
      diagnostics.push({
        file: m[1].trim(),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4] === 'warning' ? 'warning' : 'error',
        message: m[5],
      })
      continue
    }

    raw.push(line)
  }

  return { diagnostics, raw }
}
