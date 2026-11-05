// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

/**
 * 块上的**参数字段**（「类型」「printf 格式串」）。
 *
 * ## 手感
 *
 * - **单击 ⇒ 下拉**（跟最初那版一模一样）⇒ 常用值点一下就选中 ✓
 * - **双击 ⇒ 自己填** ⇒ 格式串/类型这种「取值空间很大」的字段
 *   ⇒ 「**预填的下拉框覆盖不了所有情况**」（用户原话）⇒ 得能手填 ✓
 *
 * ## 为什么不能用普通的 `FieldDropdown`
 *
 * 它的 `setValue` 遇到**不在选项里**的值会**直接拒绝**（只打一条 console
 * warning，值保留成旧值）⇒ 反编译出来的 `*u8` 会被**悄悄变成 i32**
 * ⇒ 用户的代码被改掉 ✗ ⇒ 所以要 `DynamicDropdown`（把见过的值都留在选项里）。
 */

/** 装一个真的块定义。 */
async function defineBlocks(): Promise<void> {
  const { defineJhyyBlocks } = await import('../../src/renderer/blocks/definitions')
  defineJhyyBlocks()
}

describe('Blockly FieldDropdown（为什么不能直接用）', () => {
  it('不认识的值会被拒绝（所以我们得让下拉「收得住」任何值）', async () => {
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
    // 值**没变** —— 这就是为什么固定选项的下拉不行
    expect(block.getFieldValue('T')).toBe('i32')
  })
})

describe('块上的参数字段', () => {
  it('单击是**原来那个下拉**（选项还是那一批预设）', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_print')
    const field = block.getField('FMT')
    // ⚠️ **必须是 `FieldDropdown`** —— 单击的手感跟最初那版一模一样 ✓
    expect(field).toBeInstanceOf(Blockly.FieldDropdown)
    const options = (field as unknown as { getOptions(): [string, string][] }).getOptions()
    expect(options.map((o) => o[1])).toContain('%d')
  })

  it('「类型」能装下任意类型（*u8 / [i32; 4] / Cap<T> …）', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_let')
    // 一个「不是基础类型」的类型
    block.setFieldValue('*u8', 'TYPE')
    expect(block.getFieldValue('TYPE')).toBe('*u8')
    // 另一个
    block.setFieldValue('[i32; 4]', 'TYPE')
    expect(block.getFieldValue('TYPE')).toBe('[i32; 4]')
  })

  it('「printf 格式串」能装下任意格式串', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_print')
    block.setFieldValue('值 = %d 件\\n', 'FMT')
    expect(block.getFieldValue('FMT')).toBe('值 = %d 件\\n')
  })

  it('选项里的 `\\n` 是**字面的两个字符**（不然生成的源码里会有真的换行 ⇒ 编译不过）', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_print')
    const field = block.getField('FMT') as unknown as { getOptions(): [string, string][] }
    const values = field.getOptions().map((o) => o[1])
    // ⚠️ 默认值就是 `%d` + 反斜杠 + n（**不是真的换行**）——
    // 格式串在源码里是 `"%d\n"` ⇒ 选项必须一模一样 ⇒
    // 否则用户一点选项 ⇒ `compile.ts` 原样插进引号 ⇒ 字符串被真换行截断 ✗
    expect(block.getFieldValue('FMT')).toBe('%d\\n')
    expect(values.some((v) => v.includes('\n'))).toBe(false)
    expect(values).toContain('%d\\n')
  })

  it('字段是**可序列化的**（不然块树里就存不到这个值）', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const ws = new Blockly.Workspace()
    const block = ws.newBlock('jhyy_print')
    block.setFieldValue('%s', 'FMT')
    // ⚠️ **没有名字的字段不会被序列化** ⇒ 字段必须**有名字** ✓
    expect(block.getField('FMT')?.isSerializable()).toBe(true)
  })

  it('**手填的值**能穿过 Blockly 的 XML 往返（不然用户填的格式串会丢）', async () => {
    await defineBlocks()
    const Blockly = await import('blockly/core')
    const { treeToDom, domToTree } = await import('../../src/renderer/blocks/xml')
    // 一个**不在选项里**的格式串（用户双击自己填的）
    const tree = {
      type: 'jhyy_print',
      fields: { FMT: '值 = %d 件\\n' },
      inputs: { VALUE: null },
      statements: {},
    }
    const ws = new Blockly.Workspace()
    Blockly.Xml.domToWorkspace(treeToDom([tree]), ws)
    const print = ws.getAllBlocks(false).find((b) => b.type === 'jhyy_print')
    expect(print?.getFieldValue('FMT')).toBe('值 = %d 件\\n')
    // ⇒ 再读回块树，还是那个值 ✓
    const back = domToTree(Blockly.Xml.workspaceToDom(ws).children[0])
    expect((back.fields as Record<string, string>).FMT).toBe('值 = %d 件\\n')
  })
})
