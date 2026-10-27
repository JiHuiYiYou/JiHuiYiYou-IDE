import * as Blockly from 'blockly/core'
import {
  BLOCK_FIELDS,
  BLOCK_INPUTS,
  BLOCK_STATEMENTS,
  type BlockTree,
} from '@lang/blocks/tree'

/**
 * 块树 ↔ Blockly 工作区。
 *
 * 这一层很薄 —— 它只负责把块树变成 Blockly 的 XML、再用
 * `Blockly.Xml.domToWorkspace` 灌进工作区（反方向用 `workspaceToDom` 读回）。
 * 语义都在 `src/lang/blocks/` 里（纯 TS，可单测）。
 *
 * 为什么走 XML 而不是手工 `newBlock` + `connect`：
 * 手工建块要自己处理 Blockly 13 的一堆互斥规则（一个块不能既是值块又是
 * 语句块、连接类型要匹配、SVG 挂载要手动触发……），而 XML 路径是 Blockly
 * 官方支持的加载方式 —— SVG 挂载、尺寸测量、渲染排队全都由它自己管。
 */

/** 块树 → Blockly XML 文档。 */
function treeToDom(trees: BlockTree[]): Element {
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

/** 把块树铺到工作区里。 */
export function treeToWorkspace(workspace: Blockly.WorkspaceSvg, trees: BlockTree[]): void {
  workspace.clear()
  const dom = treeToDom(trees)
  Blockly.Xml.domToWorkspace(dom, workspace)
  workspace.render()
  // Blockly 13 的 render() 只是把渲染**排队**（走 requestAnimationFrame）。
  // 窗口没焦点时 rAF 会被节流，块就一直画不出来 —— 这里排完队立刻同步触发一次。
  Blockly.renderManagement.triggerQueuedRenders(workspace)
}

/** Blockly XML 文档 → 块树。 */
function domToTree(blockEl: Element): BlockTree {
  const type = blockEl.getAttribute('type') ?? ''

  const fields: Record<string, string> = {}
  for (const name of BLOCK_FIELDS[type] ?? []) {
    const fieldEl = blockEl.querySelector(`field[name="${name}"]`)
    if (fieldEl) fields[name] = fieldEl.textContent ?? ''
  }

  const inputs: Record<string, BlockTree | null> = {}
  for (const name of BLOCK_INPUTS[type] ?? []) {
    const valueEl = blockEl.querySelector(`value[name="${name}"] > block`)
    inputs[name] = valueEl ? domToTree(valueEl) : null
  }

  const statements: Record<string, BlockTree[]> = {}
  for (const name of BLOCK_STATEMENTS[type] ?? []) {
    const list: BlockTree[] = []
    let current = blockEl.querySelector(`statement[name="${name}"] > block`)
    while (current) {
      list.push(domToTree(current))
      current = current.querySelector(':scope > next > block')
    }
    statements[name] = list
  }

  return { type, fields, inputs, statements }
}

/** 工作区 → 块树列表。 */
export function workspaceToTree(workspace: Blockly.WorkspaceSvg): BlockTree[] {
  const dom = Blockly.Xml.workspaceToDom(workspace)
  const out: BlockTree[] = []
  for (const child of Array.from(dom.children)) {
    if (child.tagName.toLowerCase() !== 'block') continue
    out.push(domToTree(child))
  }
  return out
}
