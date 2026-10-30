import {
  BLOCK_FIELDS,
  BLOCK_INPUTS,
  BLOCK_STATEMENTS,
  type BlockTree,
} from '@lang/blocks/tree'

/**
 * 块树 ↔ Blockly XML。
 *
 * 这一层是**纯 DOM**（不碰 Blockly），所以能单独测。
 * 为什么要拆出来：`adapter.ts` 里还有 `Blockly.Xml.domToWorkspace` 那一头，
 * 那个必须真浏览器；而「XML → 块树」这一头曾经出过**静默改代码**的 bug
 * （见 `domToTree` 里关于 `:scope` 的注释），得能单测盯着。
 */

/** 块树 → Blockly XML 文档。 */
export function treeToDom(trees: BlockTree[]): Element {
  const xml = document.createElement('xml')
  let y = 40
  for (const tree of trees) {
    const block = treeToBlockDom(tree)
    block.setAttribute('x', '40')
    block.setAttribute('y', String(y))
    y += 140
    xml.appendChild(block)
  }
  return xml
}

function treeToBlockDom(tree: BlockTree): Element {
  const el = document.createElement('block')
  el.setAttribute('type', tree.type)

  for (const [name, value] of Object.entries(tree.fields ?? {})) {
    const field = document.createElement('field')
    field.setAttribute('name', name)
    field.textContent = value
    el.appendChild(field)
  }

  for (const [name, child] of Object.entries(tree.inputs ?? {})) {
    if (!child) continue
    const value = document.createElement('value')
    value.setAttribute('name', name)
    value.appendChild(treeToBlockDom(child))
    el.appendChild(value)
  }

  for (const [name, list] of Object.entries(tree.statements ?? {})) {
    if (list.length === 0) continue
    const statement = document.createElement('statement')
    statement.setAttribute('name', name)
    statement.appendChild(chainBlocks(list))
    el.appendChild(statement)
  }

  return el
}

/**
 * 一串语句块 → Blockly 的 `<next>` 链。
 *
 * Blockly 的语句容器里放的是「一条链」：第一个块在 `<statement>` 里，
 * 后面的块靠各自的 `<next>` 串起来 —— 只放第一个的话，后面的语句会丢。
 */
function chainBlocks(list: BlockTree[]): Element {
  const first = treeToBlockDom(list[0])
  let current = first
  for (let i = 1; i < list.length; i++) {
    const next = document.createElement('next')
    next.appendChild(treeToBlockDom(list[i]))
    current.appendChild(next)
    current = next.firstElementChild!
  }
  return first
}

/** Blockly XML 文档 → 块树。 */
export function domToTree(blockEl: Element): BlockTree {
  const type = blockEl.getAttribute('type') ?? ''

  const fields: Record<string, string> = {}
  for (const name of BLOCK_FIELDS[type] ?? []) {
    // ⚠️ **必须用 `:scope >`** —— `querySelector` 会搜**所有后代**，
    // 而嵌套块里可能有一个**同名**的字段/输入/容器。
    // 没有 `:scope` 的话，`fib(n - 1) + fib(n - 2)` 这种嵌套会读串：
    // 外层 binop 的 RIGHT 会命中左半边 `fib(n-1)` 里那个同名的 `value[name=RIGHT]`，
    // 于是 `fib(n - 2)` 变成了 `1` —— **代码被悄悄改掉了**。
    const fieldEl = blockEl.querySelector(`:scope > field[name="${name}"]`)
    if (fieldEl) fields[name] = fieldEl.textContent ?? ''
  }

  const inputs: Record<string, BlockTree | null> = {}
  for (const name of BLOCK_INPUTS[type] ?? []) {
    const valueEl = blockEl.querySelector(`:scope > value[name="${name}"] > block`)
    inputs[name] = valueEl ? domToTree(valueEl) : null
  }

  const statements: Record<string, BlockTree[]> = {}
  for (const name of BLOCK_STATEMENTS[type] ?? []) {
    const list: BlockTree[] = []
    let current = blockEl.querySelector(`:scope > statement[name="${name}"] > block`)
    while (current) {
      list.push(domToTree(current))
      current = current.querySelector(':scope > next > block')
    }
    statements[name] = list
  }

  return { type, fields, inputs, statements }
}
