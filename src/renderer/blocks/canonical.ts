import type { BlockTree } from '@lang/blocks/tree'

/**
 * 块树的**规范化**字符串 —— 拿来判断「两棵块树是不是同一棵」。
 *
 * ⚠️ **不能直接 `JSON.stringify`**：
 * - **字段顺序**不一样 —— 反编译器按自己的顺序写字段，从工作区读回来时按
 *   `BLOCK_FIELDS` 的顺序；
 * - **空的 inputs / statements** 不一样 —— 读回来时每个输入名都有一项
 *   （没有的是 `null`），反编译出来的树里压根没那些键。
 *
 * 直接比字符串 ⇒ 明明是同一棵树却被判成「变了」⇒ 白白重建工作区
 * ⇒ **视角被重置**，而且重建过程中的假事件会让 Blockly 崩
 * （"The block associated with the block move event could not be found"）。
 */
export function canonicalTree(tree: BlockTree | BlockTree[]): string {
  return JSON.stringify(Array.isArray(tree) ? tree.map(normalize) : normalize(tree))
}

function normalize(tree: BlockTree): unknown {
  const fields = tree.fields ?? {}
  const inputs = tree.inputs ?? {}
  const statements = tree.statements ?? {}

  return {
    type: tree.type,
    // 字段：按名字排序
    fields: Object.keys(fields)
      .sort()
      .map((name) => [name, fields[name]]),
    // 输入：只留有值的，按名字排序
    inputs: Object.keys(inputs)
      .filter((name) => inputs[name] != null)
      .sort()
      .map((name) => [name, normalize(inputs[name] as BlockTree)]),
    // 容器：只留非空的，按名字排序
    statements: Object.keys(statements)
      .filter((name) => (statements[name] ?? []).length > 0)
      .sort()
      .map((name) => [name, (statements[name] ?? []).map(normalize)]),
  }
}
