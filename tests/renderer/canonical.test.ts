import { describe, expect, it } from 'vitest'
import { canonicalTree } from '../../src/renderer/blocks/canonical'
import type { BlockTree } from '../../src/lang/blocks/tree'

/**
 * 块树的规范化比较。
 *
 * ⚠️ 这东西是**修 bug 用的**：之前用 `JSON.stringify` 比两棵块树，
 * 而「反编译出来的树」和「从工作区读回来的树」在两处不一样：
 * - **字段顺序**不同（一个是反编译器的顺序，一个是 `BLOCK_FIELDS` 的顺序）
 * - **空的 inputs** 不同（读回来时每个输入名都有一项、没有的是 null，
 *   反编译出来的树里压根没那些键）
 *
 * 结果：明明是同一棵树却被判成「变了」⇒ 白白重建工作区 ⇒ **视角被重置**，
 * 而且重建过程冒出来的假事件会把 Blockly 搞崩
 * （"The block associated with the block move event could not be found"）。
 */
function block(type: string, extra: Partial<BlockTree> = {}): BlockTree {
  return { type, fields: {}, inputs: {}, statements: {}, ...extra }
}

describe('canonicalTree', () => {
  it('字段顺序不同也算同一棵', () => {
    const a = block('jhyy_binop', { fields: { OP: '+', KIND: 'x' } })
    const b = block('jhyy_binop', { fields: { KIND: 'x', OP: '+' } })
    expect(canonicalTree(a)).toBe(canonicalTree(b))
  })

  it('空的 inputs 键算没有', () => {
    const a = block('jhyy_binop', {
      fields: { OP: '+' },
      inputs: { LEFT: block('jhyy_var', { fields: { NAME: 'x' } }), RIGHT: null },
    })
    const b = block('jhyy_binop', {
      fields: { OP: '+' },
      inputs: { LEFT: block('jhyy_var', { fields: { NAME: 'x' } }) },
    })
    expect(canonicalTree(a)).toBe(canonicalTree(b))
  })

  it('空的语句容器算没有', () => {
    const a = block('jhyy_func', {
      fields: { NAME: 'f' },
      statements: { PARAMS: [], BODY: [block('jhyy_expr_stmt')] },
    })
    const b = block('jhyy_func', {
      fields: { NAME: 'f' },
      statements: { BODY: [block('jhyy_expr_stmt')] },
    })
    expect(canonicalTree(a)).toBe(canonicalTree(b))
  })

  it('真的有差异时不能判成同一棵', () => {
    const a = block('jhyy_binop', { fields: { OP: '+' } })
    const b = block('jhyy_binop', { fields: { OP: '-' } })
    expect(canonicalTree(a)).not.toBe(canonicalTree(b))
  })

  it('嵌套的输入也要比', () => {
    const a = block('jhyy_binop', {
      fields: { OP: '+' },
      inputs: { LEFT: block('jhyy_var', { fields: { NAME: 'x' } }) },
    })
    const b = block('jhyy_binop', {
      fields: { OP: '+' },
      inputs: { LEFT: block('jhyy_var', { fields: { NAME: 'y' } }) },
    })
    expect(canonicalTree(a)).not.toBe(canonicalTree(b))
  })

  it('顶层是数组时也能比', () => {
    const list = [block('jhyy_var', { fields: { NAME: 'x' } })]
    expect(canonicalTree(list)).toBe(canonicalTree([block('jhyy_var', { fields: { NAME: 'x' } })]))
    expect(canonicalTree(list)).not.toBe(canonicalTree([block('jhyy_var', { fields: { NAME: 'y' } })]))
  })
})
