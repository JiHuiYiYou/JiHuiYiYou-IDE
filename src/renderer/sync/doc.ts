import { compileModule } from '@lang/blocks/compile'
import { decompileModule } from '@lang/blocks/decompile'
import type { BlockTree } from '@lang/blocks/tree'
import { parse } from '@lang/parser'
import { print } from '@lang/printer'

/**
 * 块视图 ↔ 文本视图的同步层。
 *
 * 两条路径都走**同一个 AST**：
 * - 块 → 文本：块树 → AST → 打印
 * - 文本 → 块：源码 → 解析 → AST → 反编译
 *
 * 所以两边永远不会对同一份代码产生不同的输出。
 */

/** 块树 → 源码。 */
export function blocksToSource(trees: BlockTree[]): string {
  return print(compileModule(trees))
}

export interface SourceToBlocksResult {
  trees: BlockTree[]
  /** IDE 自己的解析错误（源码语法有问题时，块视图没法重建） */
  parseErrors: { line: number; col: number; message: string }[]
}

/** 源码 → 块树。 */
export function sourceToBlocks(source: string): SourceToBlocksResult {
  const parsed = parse(source)
  if (!parsed.module) {
    return { trees: [], parseErrors: parsed.errors }
  }
  return { trees: decompileModule(parsed.module, source), parseErrors: parsed.errors }
}

/**
 * **块视图能不能「无损」表达这份源码？**
 *
 * ⚠️ **为什么要问这个** ——
 *   块视图**会回写用户的源文件**（`App.tsx` 的 `onBlockChange`：
 *   `blocksToSource(tree)` ⇒ 直接替换编辑器里的内容）⇒
 *   ⇒ **块树表达不了的东西 ⇒ 回写时就没了** ⇒ **用户的代码被悄悄改掉** ✗✗
 *
 *   块树是**有损**的：泛型参数、turbofish 实参、`#[inline]` 属性、
 *   某些语句形态…… 每加一种块能力之前，它就多丢一样东西。
 *   ⇒ 光靠「把块树补全」是**追不上的**（语言一直在长）⇒
 *   ⇒ **必须有一道兜底的闸**：表达不了就**不许回写** ✓
 *
 * ## 判据
 *
 *   print(parse(src))  ===  print(compileModule(decompileModule(parse(src))))
 *              ↑ 文本视图              ↑ 块视图
 *
 * 两边**一字不差** ⇒ 块视图能无损表达这份源码 ⇒ 回写安全 ✓
 *
 * ⚠️ **源码本身有语法错误 ⇒ 直接算「表达不了」** ——
 *    块视图是从**残缺的解析**建出来的（解析器没有错误恢复，第一个错就 bail）⇒
 *    那种块树回写出去是**一堆碎片**（实测：一个函数被拆成 `fn f() {}` + `i32;` + …）✗
 */
export function isLosslessForBlocks(source: string): boolean {
  const parsed = parse(source)
  if (!parsed.module || parsed.errors.length > 0) return false
  const trees = decompileModule(parsed.module, source)
  return print(compileModule(trees)) === print(parsed.module)
}
