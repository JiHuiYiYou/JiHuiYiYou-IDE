import * as Blockly from 'blockly/core'
import type { BlockTree } from '@lang/blocks/tree'
import { domToTree, treeToDom } from './xml'

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
 *
 * XML ⇄ 块树那一头在 `xml.ts`（纯 DOM，可单测）。
 */

/** 把块树铺到工作区里。 */
export function treeToWorkspace(workspace: Blockly.WorkspaceSvg, trees: BlockTree[]): void {
  // ⚠️ **保住视角** —— `workspace.clear()` 会把滚动位置和缩放都清掉。
  // 重建（文本 → 块）不该把用户拖到一半的画布踢回原点。
  const scrollX = workspace.scrollX
  const scrollY = workspace.scrollY
  const scale = workspace.getScale()

  workspace.clear()
  const dom = treeToDom(trees)
  Blockly.Xml.domToWorkspace(dom, workspace)
  layoutTopBlocks(workspace)

  workspace.setScale(scale)
  workspace.scroll(scrollX, scrollY)

  workspace.render()
  // Blockly 13 的 render() 只是把渲染**排队**（走 requestAnimationFrame）。
  // 窗口没焦点时 rAF 会被节流，块就一直画不出来 —— 这里排完队立刻同步触发一次。
  Blockly.renderManagement.triggerQueuedRenders(workspace)
}

/**
 * 把顶层块竖着排开。
 *
 * XML 里的 `x`/`y` 是写死的，而顶层块的实际高度差别极大
 * （一个函数块能到几百像素）—— 固定间距会让它们**互相压住**，
 * 后面的块被前面的盖住，看着像「块丢了」。
 *
 * 所以按**实际高度**一个一个往下摆。
 */
function layoutTopBlocks(workspace: Blockly.WorkspaceSvg): void {
  let y = 40
  for (const block of workspace.getTopBlocks(true)) {
    const { height } = block.getHeightWidth()
    const pos = block.getRelativeToSurfaceXY()
    block.moveBy(40 - pos.x, y - pos.y)
    y += height + 40
  }
}

/** 工作区 → 块树列表。 */
export function workspaceToTree(workspace: Blockly.Workspace): BlockTree[] {
  const dom = Blockly.Xml.workspaceToDom(workspace)
  const out: BlockTree[] = []
  for (const child of Array.from(dom.children)) {
    if (child.tagName.toLowerCase() !== 'block') continue
    out.push(domToTree(child))
  }
  return out
}
