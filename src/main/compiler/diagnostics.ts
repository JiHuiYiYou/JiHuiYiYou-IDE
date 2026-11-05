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

export interface ParsedDiagnostics {
  diagnostics: Diagnostic[]
  /** 没被识别成诊断的行 —— **包括编译器的进度噪声**（用户要看见全部输出）✓ */
  raw: string[]
}

/** 把 stderr 拆成诊断与非诊断行。 */
export function parseDiagnostics(stderr: string): ParsedDiagnostics {
  const diagnostics: Diagnostic[] = []
  const raw: string[] = []

  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

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

    // ⚠️ **噪声也留着** —— 用户要看见编译器的**全部**输出
    //    （用户明说：「你是不是过滤编译器输出了，其实不用的」）⇒
    //    进度噪声、`--no-link` 的回执、结尾摘要 ⇒ 原样进 `raw` ✓
    //    （它们只是**不会被当成诊断**灌进「问题」面板 ✓）
    raw.push(line)
  }

  return { diagnostics, raw }
}
