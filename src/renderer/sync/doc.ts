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
