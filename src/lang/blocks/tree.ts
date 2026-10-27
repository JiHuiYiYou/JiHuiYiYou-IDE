/**
 * 块树 —— 块视图的中间表示。
 *
 * 为什么要有这一层：
 * - `src/lang` 保持**零 Blockly 依赖**（纯 TS），所以解析器/打印器/块转换器
 *   都能在 Node 里跑单测（不需要 DOM）。
 * - 块视图与文本视图**共用同一个打印器**（AST → 源码），所以两边永远不会
 *   对同一份代码产生不同的输出。
 *
 * 数据流：
 *
 *   源码 ──parse──▶ AST ──decompile──▶ 块树 ──▶ Blockly 工作区
 *                                        ▲            │
 *                                        └── 块树 ◀──┘
 *
 *   块树 ──compile──▶ AST ──print──▶ 源码
 */

/** 一个块节点。 */
export interface BlockTree {
  /** 块类型（见下面的块目录） */
  type: string
  /** 字段值（文本） */
  fields?: Record<string, string>
  /** 值型输入 */
  inputs?: Record<string, BlockTree | null>
  /** 语句容器型输入（里面装一串块） */
  statements?: Record<string, BlockTree[]>
  /** 链式下一个块 */
  next?: BlockTree | null
}

/** 块类型目录 —— 定义器、反编译器、编译器三方共用的唯一真相。 */
export const BLOCK = {
  let: 'jhyy_let',
  set: 'jhyy_set',
  value: 'jhyy_value',
  variable: 'jhyy_var',
  binop: 'jhyy_binop',
  unop: 'jhyy_unop',
  call: 'jhyy_call',
  qualifiedCall: 'jhyy_qcall',
  field: 'jhyy_field',
  index: 'jhyy_index',
  cast: 'jhyy_cast',
  array: 'jhyy_array',
  if: 'jhyy_if',
  while: 'jhyy_while',
  for: 'jhyy_for',
  return: 'jhyy_return',
  break: 'jhyy_break',
  continue: 'jhyy_continue',
  print: 'jhyy_print',
  func: 'jhyy_func',
  param: 'jhyy_param',
  structDef: 'jhyy_struct_def',
  fieldDecl: 'jhyy_field_decl',
  enumDef: 'jhyy_enum_def',
  variantDecl: 'jhyy_variant_decl',
  structLit: 'jhyy_struct_lit',
  fieldInit: 'jhyy_field_init',
  match: 'jhyy_match',
  matchArm: 'jhyy_match_arm',
  enumVariant: 'jhyy_enum_variant',
  typedef: 'jhyy_typedef',
  import: 'jhyy_import',
  opaque: 'jhyy_opaque',
  /** 容器里的值槽位（调用实参 / 数组元素） */
  arg: 'jhyy_arg',
  // 「语句形态」和「值形态」是**两种不同的块** —— Blockly 里一个块不能既是
  // 值块（有输出连接）又是语句块（有前后连接）。JHYY 里调用 / 赋值 / if /
  // match 两种位置都能出现，所以各给一个变体。
  callStmt: 'jhyy_call_stmt',
  qualifiedCallStmt: 'jhyy_qcall_stmt',
  setValue: 'jhyy_set_val',
  ifValue: 'jhyy_if_val',
  matchValue: 'jhyy_match_val',
  /** 表达式语句（求值但丢弃结果）—— 值块没法直接放在语句位置，用它包一层 */
  exprStmt: 'jhyy_expr_stmt',
} as const

export type BlockType = (typeof BLOCK)[keyof typeof BLOCK]

/**
 * 块 → 字段名 / 输入名 / 容器名。
 *
 * Blockly 的公开 API 只有 `getField(name)` / `getInput(name)`，没有"列出全部
 * 字段"的方法（`block.fields` 是内部成员）。所以这里显式列出每个块的契约 ——
 * 反编译器读回块树、块视图写块时都按这份表走。
 */
export const BLOCK_FIELDS: Record<string, string[]> = {
  [BLOCK.let]: ['NAME', 'MUT', 'TYPE'],
  [BLOCK.set]: [],
  [BLOCK.value]: ['KIND', 'VALUE'],
  [BLOCK.variable]: ['NAME'],
  [BLOCK.binop]: ['OP'],
  [BLOCK.unop]: ['OP'],
  [BLOCK.call]: ['NAME'],
  [BLOCK.qualifiedCall]: ['MODULE', 'NAME'],
  [BLOCK.field]: ['NAME'],
  [BLOCK.index]: [],
  [BLOCK.cast]: ['TYPE'],
  [BLOCK.array]: [],
  [BLOCK.if]: [],
  [BLOCK.while]: [],
  [BLOCK.for]: ['NAME'],
  [BLOCK.return]: [],
  [BLOCK.break]: [],
  [BLOCK.continue]: [],
  [BLOCK.print]: ['FMT'],
  [BLOCK.func]: ['NAME', 'RET'],
  [BLOCK.param]: ['NAME', 'TYPE'],
  [BLOCK.structDef]: ['NAME'],
  [BLOCK.fieldDecl]: ['NAME', 'TYPE'],
  [BLOCK.enumDef]: ['NAME'],
  [BLOCK.variantDecl]: ['NAME', 'TYPE'],
  [BLOCK.structLit]: ['TYPE'],
  [BLOCK.fieldInit]: ['NAME'],
  [BLOCK.match]: [],
  [BLOCK.matchArm]: ['PATTERN'],
  [BLOCK.enumVariant]: ['TYPE', 'VARIANT'],
  [BLOCK.typedef]: ['NAME', 'TYPE'],
  [BLOCK.import]: ['MODULE'],
  [BLOCK.opaque]: ['CODE'],
  [BLOCK.arg]: [],
  [BLOCK.callStmt]: ['NAME'],
  [BLOCK.qualifiedCallStmt]: ['MODULE', 'NAME'],
  [BLOCK.setValue]: [],
  [BLOCK.ifValue]: [],
  [BLOCK.matchValue]: [],
  [BLOCK.exprStmt]: [],
}

/** 值型输入（可以接值块）。 */
export const BLOCK_INPUTS: Record<string, string[]> = {
  [BLOCK.let]: ['VALUE'],
  [BLOCK.set]: ['TARGET', 'VALUE'],
  [BLOCK.binop]: ['LEFT', 'RIGHT'],
  [BLOCK.unop]: ['VALUE'],
  [BLOCK.call]: [],
  [BLOCK.qualifiedCall]: [],
  [BLOCK.field]: ['OBJ'],
  [BLOCK.index]: ['ARR', 'INDEX'],
  [BLOCK.cast]: ['VALUE'],
  [BLOCK.if]: ['COND'],
  [BLOCK.while]: ['COND'],
  [BLOCK.for]: ['START', 'END'],
  [BLOCK.return]: ['VALUE'],
  [BLOCK.print]: ['VALUE'],
  [BLOCK.structLit]: [],
  [BLOCK.fieldInit]: ['VALUE'],
  [BLOCK.match]: ['SUBJECT'],
  [BLOCK.matchArm]: ['BODY'],
  [BLOCK.enumVariant]: ['PAYLOAD'],
  [BLOCK.arg]: ['ARG'],
  [BLOCK.callStmt]: [],
  [BLOCK.qualifiedCallStmt]: [],
  [BLOCK.setValue]: ['TARGET', 'VALUE'],
  [BLOCK.ifValue]: ['COND'],
  [BLOCK.matchValue]: ['SUBJECT'],
  [BLOCK.exprStmt]: ['VALUE'],
}

/** 语句容器（装一串块）。 */
export const BLOCK_STATEMENTS: Record<string, string[]> = {
  [BLOCK.call]: ['ARGS'],
  [BLOCK.qualifiedCall]: ['ARGS'],
  [BLOCK.array]: ['ELEMS'],
  [BLOCK.if]: ['THEN', 'ELSE'],
  [BLOCK.while]: ['BODY'],
  [BLOCK.for]: ['BODY'],
  [BLOCK.func]: ['PARAMS', 'BODY'],
  [BLOCK.structDef]: ['FIELDS'],
  [BLOCK.enumDef]: ['VARIANTS'],
  [BLOCK.structLit]: ['FIELDS'],
  [BLOCK.match]: ['ARMS'],
  [BLOCK.callStmt]: ['ARGS'],
  [BLOCK.qualifiedCallStmt]: ['ARGS'],
  [BLOCK.ifValue]: ['THEN', 'ELSE'],
  [BLOCK.matchValue]: ['ARMS'],
}

/** 二元运算符（块的下拉选项）。 */
export const BIN_OPS = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
  '&',
  '|',
  '^',
  '<<',
  '>>',
] as const

/** 一元运算符。 */
export const UN_OPS = ['-', '!', '~'] as const

/** 字面量种类。 */
export const VALUE_KINDS = ['number', 'string', 'bool', 'char'] as const

/** 类型下拉的可选项。 */
export const TYPE_CHOICES = [
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
  'f32',
  'f64',
  'bool',
] as const

/** 构造一个块树节点。 */
export function block(
  type: string,
  opts: {
    fields?: Record<string, string>
    inputs?: Record<string, BlockTree | null>
    statements?: Record<string, BlockTree[]>
    next?: BlockTree | null
  } = {},
): BlockTree {
  return { type, ...opts }
}

/**
 * 把一段源码编码成**单行**文本（Blockly 的 FieldTextInput 是单行的）。
 *
 * 换行写成 `\n`，反斜杠写成 `\\`。这个转义是**无损**的：任意源码都能
 * 编码回去还原成原样。
 */
export function encodeOpaque(code: string): string {
  return code.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
}

/** 单行文本 → 源码（`encodeOpaque` 的逆操作）。 */
export function decodeOpaque(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === 'n') {
        out += '\n'
        i++
        continue
      }
      if (next === '\\') {
        out += '\\'
        i++
        continue
      }
    }
    out += text[i]
  }
  return out
}

/** 遍历块树（深度优先，含所有容器）。 */
export function walkBlocks(
  tree: BlockTree | null | undefined,
  visit: (node: BlockTree) => void,
): void {
  if (!tree) return
  visit(tree)
  if (tree.inputs) {
    for (const input of Object.values(tree.inputs)) walkBlocks(input, visit)
  }
  if (tree.statements) {
    for (const list of Object.values(tree.statements)) {
      for (const child of list) walkBlocks(child, visit)
    }
  }
  walkBlocks(tree.next, visit)
}
