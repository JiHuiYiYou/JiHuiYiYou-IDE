// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceToBlocks } from '../../src/renderer/sync/doc'
import { treeToDom } from '../../src/renderer/blocks/xml'

/**
 * 块树 → Blockly 工作区：能不能**灌进去**。
 *
 * ⚠️ 这一步以前会崩：
 * 「语句形态」的块（`jhyy_set` / `jhyy_if` / `jhyy_match` / `jhyy_opaque`）
 * 被反编译器放进了**表达式位置**（值输入），而它们的 Blockly 定义只有
 * **前后连接**（语句形态）⇒ Blockly 把「语句连接」接到「值输入」上 ⇒
 * **"Attempt to connect incompatible types."** ⇒ 块视图整个崩掉。
 *
 * 反过来也一样：**一个块不能既输出又前后连接**。
 * Blockly 灌 XML 时给子块挑连接口的顺序是**先 output、再 previous**
 * （它分不清 `<statement>` 和 `<value>`）⇒ 既有输出又有前后连接的块，
 * 放进语句容器时同样会崩。
 *
 * 所以每种「两种位置都能出现」的语法都有**两个块**：
 * 语句形态（`jhyy_set`）和值形态（`jhyy_set_val`）。
 *
 * 这个测试把**所有样例**都灌一遍 —— 少一个类型定义就红。
 *
 * ⚠️ 用**无头工作区**（`Blockly.Workspace`）而不是 `Blockly.inject`：
 * SVG 工作区在 jsdom 里每次都要量文字、画 canvas，277 个例子要跑好几分钟。
 * 连接口的类型检查逻辑两者**完全一样**，所以无头版够用（也快得多）。
 */

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.jhyy')) out.push(full)
  }
  return out
}

/** 样例在哪儿 —— 本仓库的 samples + 语言仓库的 examples（后者不在就跳过）。 */
function sampleRoots(): string[] {
  // vitest 的 cwd 就是仓库根
  const root = process.cwd()
  const roots = [join(root, 'samples')]
  const sibling = join(root, '..', 'JiHuiYiYou', 'compiler', 'tests', 'examples')
  try {
    if (statSync(sibling).isDirectory()) roots.push(sibling)
  } catch {
    // 语言仓库不在 —— 只扫本仓库的
  }
  return roots
}

describe('块 XML 灌进 Blockly', () => {
  it('所有样例都能灌进去，不报「类型不兼容」', async () => {
    const Blockly = await import('blockly/core')
    const { defineJhyyBlocks } = await import('../../src/renderer/blocks/definitions')
    defineJhyyBlocks()

    const files = sampleRoots().flatMap((r) => walk(r))
    expect(files.length).toBeGreaterThan(0)

    // 一个工作区反复用 —— 每个文件都建一个太慢
    const workspace = new Blockly.Workspace()

    const failed: string[] = []
    let checked = 0
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const { trees, parseErrors } = sourceToBlocks(src)
      if (parseErrors.length) continue
      const dom = treeToDom(trees)
      workspace.clear()
      try {
        Blockly.Xml.domToWorkspace(dom, workspace)
        checked++
      } catch (e) {
        failed.push(`${file}: ${(e as Error).message}`)
      }
    }
    if (failed.length) console.log('崩了:\n' + failed.join('\n'))
    expect(failed).toEqual([])
    expect(checked).toBeGreaterThan(0)
  }, 600_000)

  /**
   * 反编译出来的树，和「灌进 Blockly 再读回来」的树，**必须一样**。
   *
   * ⚠️ 不一样 ⇒ `canonicalTree` 判定「变了」⇒ **每次都重建工作区** ⇒
   * 视角被重置，而且重建冒出来的假事件会把 Blockly 搞崩。
   *
   * 这条测试专门盯**块定义和块目录对不上**的情况 ——
   * 比如新加了一个字段却没登记进 `BLOCK_FIELDS`，
   * 或者给了一个**有名字**的字段（它会被写进 XML ⇒ 块树多出一个字段）。
   */
  it('反编译的树和从工作区读回来的树一致（否则会无限重建）', async () => {
    const Blockly = await import('blockly/core')
    const { defineJhyyBlocks } = await import('../../src/renderer/blocks/definitions')
    const { canonicalTree } = await import('../../src/renderer/blocks/canonical')
    const { workspaceToTree } = await import('../../src/renderer/blocks/adapter')
    defineJhyyBlocks()

    const workspace = new Blockly.Workspace()
    const drifted: string[] = []
    let checked = 0

    for (const file of sampleRoots().flatMap((r) => walk(r))) {
      const src = readFileSync(file, 'utf8')
      const { trees, parseErrors } = sourceToBlocks(src)
      if (parseErrors.length) continue
      workspace.clear()
      Blockly.Xml.domToWorkspace(treeToDom(trees), workspace)
      const back = workspaceToTree(workspace)
      if (canonicalTree(back) !== canonicalTree(trees)) {
        drifted.push(file)
        continue
      }
      checked++
    }
    if (drifted.length) console.log('对不上:\n' + drifted.join('\n'))
    expect(drifted).toEqual([])
    expect(checked).toBeGreaterThan(0)
  }, 600_000)
})
