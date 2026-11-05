import { describe, expect, it } from 'vitest'
import { accumulateOutput } from '../../src/renderer/sync/output'

/**
 * 程序输出的**分行**。
 *
 * ⚠️ 程序的 stdout 是**无缓冲**的（编译器仓库的 `compiler/runtime/runtime.c`
 * 里有 `setvbuf(stdout, NULL, _IONBF, 0)`）⇒ 一次 `printf` 可能被拆成
 * 好几个片段送过来。
 *
 * 实测（真跑一遍 JHYY 的 `input.jhyy`）：
 * ```
 * [+27045ms stdout] "请输入一"
 * [+27047ms stdout] "个数"
 * [+27047ms stdout] "字: "
 * ```
 * ⇒ 不自己攒的话，输出面板里那行提示会被拆成三行 ✗
 */
describe('程序输出的分行', () => {
  /** 把若干段喂进去，返回攒到的行和最后的尾巴。 */
  function feed(chunks: string[]): { lines: string[]; tail: string } {
    let tail = ''
    const lines: string[] = []
    for (const chunk of chunks) {
      const r = accumulateOutput(tail, chunk)
      lines.push(...r.lines)
      tail = r.tail
    }
    return { lines, tail }
  }

  it('一句提示（没有换行）⇒ 全进 tail，还没算一行', () => {
    const { lines, tail } = feed(['请输入一个数字: '])
    expect(lines).toEqual([])
    expect(tail).toBe('请输入一个数字: ')
  })

  it('被拆成好几段的提示 ⇒ 拼回同一段尾巴', () => {
    const { lines, tail } = feed(['请输入一', '个数', '字: '])
    expect(lines, '还没换行 ⇒ 不该有整行').toEqual([])
    expect(tail).toBe('请输入一个数字: ')
  })

  it('换行之后 ⇒ 之前的尾巴变成一整行', () => {
    const { lines, tail } = feed(['请输入一', '个数', '字: ', '\n你输入的是: 7\n'])
    expect(lines).toEqual(['请输入一个数字: ', '你输入的是: 7'])
    expect(tail).toBe('')
  })

  it('空行丢掉（终端里空行没有信息量）', () => {
    const { lines } = feed(['a\n\n\nb\n'])
    expect(lines).toEqual(['a', 'b'])
  })

  it('Windows 的 \\r\\n ⇒ 行尾那个 \\r 不带进行里', () => {
    const { lines } = feed(['第一行\r\n第二行\r\n'])
    expect(lines).toEqual(['第一行', '第二行'])
  })
})
