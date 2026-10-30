import { describe, expect, it } from 'vitest'
import { parseDiagnostics } from '../../src/main/compiler/diagnostics'

describe('parseDiagnostics', () => {
  it('解析带 Windows 盘符的绝对路径', () => {
    // ⚠️ 这是 MCP server 那份正则踩过的坑：`^([^:]+):` 跨不过盘符冒号，
    // 会把 file/line/col 静默丢成空。这里必须解析对。
    const stderr =
      'C:\\Users\\liuzhen\\Desktop\\coding\\JiHuiYiYou\\compiler\\tests\\examples\\agg_eq_type_mismatch.jhyy:12:8: error: type mismatch in binary\n'

    const { diagnostics } = parseDiagnostics(stderr)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].file).toBe(
      'C:\\Users\\liuzhen\\Desktop\\coding\\JiHuiYiYou\\compiler\\tests\\examples\\agg_eq_type_mismatch.jhyy',
    )
    expect(diagnostics[0].line).toBe(12)
    expect(diagnostics[0].col).toBe(8)
    expect(diagnostics[0].message).toBe('type mismatch in binary')
    expect(diagnostics[0].severity).toBe('error')
  })

  it('解析相对路径', () => {
    const { diagnostics } = parseDiagnostics('compiler/src0/sema.jhyy:1777:3: error: E0050: bad\n')
    expect(diagnostics[0].file).toBe('compiler/src0/sema.jhyy')
    expect(diagnostics[0].line).toBe(1777)
    expect(diagnostics[0].col).toBe(3)
  })

  it('过滤编译进度噪声', () => {
    const stderr = [
      '[1] imports start',
      '[2] imports done',
      '[3] sema start',
      '[4] post-sema',
      '[4a] ir_init done',
      '[4b] cg_module done',
      '[4] codegen done',
      'parse errors',
      'semantic errors',
      'import resolution failed',
    ].join('\n')

    const { diagnostics, raw } = parseDiagnostics(stderr)
    expect(diagnostics).toHaveLength(0)
    expect(raw).toHaveLength(0)
  })

  it('把无法识别的行归到 raw', () => {
    const { diagnostics, raw } = parseDiagnostics(
      ['[3] sema start', 'gcc: fatal error', 'x.jhyy:1:1: error: boom'].join('\n'),
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toBe('boom')
    expect(raw).toEqual(['gcc: fatal error'])
  })

  it('识别 warning 级别', () => {
    const { diagnostics } = parseDiagnostics('x.jhyy:3:9: warning: something odd\n')
    expect(diagnostics[0].severity).toBe('warning')
  })

  it('空输入不炸', () => {
    expect(parseDiagnostics('')).toEqual({ diagnostics: [], raw: [] })
    expect(parseDiagnostics('\r\n\r\n')).toEqual({ diagnostics: [], raw: [] })
  })

  it('--no-link 的提示行不会被误判成诊断，也会被当噪声滤掉', () => {
    // 这行的路径里可能带冒号，但没有 :数字:数字: 结构 ⇒ 不是诊断。
    // 而且它是 IDE 自己传 --no-link 的回执，对用户是纯噪声 ⇒ 连 raw 都不该进。
    const { diagnostics, raw } = parseDiagnostics(
      'compile: --no-link set, skipping gcc link (.s kept at C:\\tmp\\out.s)\n',
    )
    expect(diagnostics).toHaveLength(0)
    expect(raw).toHaveLength(0)
  })

  it('真的用法错误（compile: no input file）不会被当成噪声滤掉', () => {
    // 跟 --no-link 的回执不同 —— 这是真的错了，用户得看见
    const { raw } = parseDiagnostics('compile: no input file\n')
    expect(raw).toHaveLength(1)
  })
})
