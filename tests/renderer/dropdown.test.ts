// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

/**
 * Blockly 的 `FieldDropdown` 遇到「不在选项里」的值会怎样？
 *
 * ⚠️ 这决定了「类型」字段能不能做成**纯下拉** ——
 * 类型的取值空间不止基础类型（还有 `*u8` / `[i32; 4]` / `Cap<T>` …），
 * 而反编译出来的就是这些值。如果下拉遇到不认识的值会**保留旧值**，
 * 用户的代码就会被悄悄改掉 ⇒ 只能做成「选项里永远带上当前值」。
 *
 * 实测（Blockly 13）：`setFieldValue('*u8')` 之后字段的值**还是 `i32`**，
 * 而且只打一条 console warning —— 静默改用户代码，最难查的一类 bug。
 */
describe('Blockly FieldDropdown', () => {
  it('不认识的值会被拒绝（所以类型下拉必须动态带值）', async () => {
    const Blockly = await import('blockly/core')
    Blockly.defineBlocksWithJsonArray([
      {
        type: 'probe_dd',
        message0: '%1',
        args0: [{ type: 'field_dropdown', name: 'T', options: [['i32', 'i32'], ['i64', 'i64']] }],
      },
    ])
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('probe_dd')
    block.setFieldValue('*u8', 'T')
    // 值**没变** —— 这就是为什么类型下拉不能是固定选项
    expect(block.getFieldValue('T')).toBe('i32')
  })

  it('我们的「类型」下拉能装下任意类型', async () => {
    const Blockly = await import('blockly/core')
    const { defineJhyyBlocks } = await import('../../src/renderer/blocks/definitions')
    defineJhyyBlocks()
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_let')
    // 一个「不是基础类型」的类型
    block.setFieldValue('*u8', 'TYPE')
    expect(block.getFieldValue('TYPE')).toBe('*u8')
    // 另一个
    block.setFieldValue('[i32; 4]', 'TYPE')
    expect(block.getFieldValue('TYPE')).toBe('[i32; 4]')
  })
})
