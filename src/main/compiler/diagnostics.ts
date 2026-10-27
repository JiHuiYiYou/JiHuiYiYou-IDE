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
