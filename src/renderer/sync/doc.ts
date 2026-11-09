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
 * **这次块视图的回写会不会把用户的代码改坏？**
 *
 * ⚠️ **为什么要问这个** ——
 *   块视图**会回写用户的源文件**（`App.tsx` 的 `onBlockChange`：
 *   `blocksToSource(tree)` ⇒ 直接替换编辑器里的内容）⇒
 *   ⇒ **块树表达不了的东西 ⇒ 回写时就没了** ⇒ **用户的代码被悄悄改掉** ✗✗
 *
 *   块树是**有损**的：泛型参数、turbofish 实参、`#[inline]` 属性、
 *   某些语句形态…… 每加一种块能力之前，它就多丢一样东西。
 *   ⇒ 光靠「把块树补全」是**追不上的**（语言一直在长）⇒
 *   ⇒ **必须有一道兜底的闸**：改坏了就**不许回写** ✓
 *
 * ## 判据
 *
 *   generated  ===  print(parse(src))
 *      ↑ 新块树       ↑ 当前源码
 *
 * 两边**一字不差** ⇒ 回写是**空操作** ⇒ 用户的代码一个字都不会变 ⇒ 安全 ✓
 * 不一样 ⇒ 这次回写会**改坏**用户的代码 ⇒ **不许回写** ✓
 *
 * ⚠️ **比的是「打印器」的输出，不是原始文本** ——
 *    原始文本的缩进/空格跟打印器不一定一样 ⇒ 拿原始文本比会误判
 *    （用户只是改了个缩进就被判成「表达不了」）✗
 *
 * ⚠️ **源码本身有语法错误 ⇒ 直接算「不安全」** ——
 *    解析器没有错误恢复，第一个错就 bail ⇒ 那种块树回写出去是**一堆碎片**
 *    （实测：一个函数被拆成 `fn f() {}` + `i32;` + …）✗
 *
 * ⚠️ **比旧的判据便宜一半** —— 以前判「源码能不能被块表达」要跑
 *    **两遍**全量往返（源码→AST→块树→AST→源码），现在只要**一遍**
 *    （源码→AST→打印）✓
 */
export function isLosslessRewrite(source: string, generated: string): boolean {
  const parsed = parse(source)
  if (!parsed.module || parsed.errors.length > 0) return false
  return generated === print(parsed.module)
}
