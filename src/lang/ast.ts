/**
 * JHYY 语法树。
 *
 * 节点种类与编译器 `compiler/src0/ast.jhyy` 的 57 个 NodeKind **一一对应**
 * （名字用小写下划线形式，与 `compiler/tests/golden/*.ast.txt` 的 dump 格式一致，
 * 方便做结构比对）。
 *
 * 与编译器 AST 的关键差异：
 * - 编译器在 sema 之后才有类型信息（`type_ptr` / `*Sym`）；IDE 侧是**纯句法**的，
 *   标识符只存名字字符串，不做符号解析。
 * - 编译器只记行列；IDE 侧每个节点都带 `start`/`end` **偏移**（UTF-16 code unit），
 *   这是"文本 ↔ 块"区间映射的前提 —— 编译器给不了。
 */

export type NodeKind =
  // 字面量
  | 'int'
  | 'float'
  | 'string'
  | 'char'
  | 'bool'
  | 'null'
  // 名字与表达式
  | 'ident'
  | 'unary'
  | 'binary'
  | 'call'
  | 'qualified_call'
  | 'field'
  | 'index'
  | 'cast'
  | 'addr_of'
  | 'deref'
  | 'sizeof'
  | 'alignof'
  // 类型
  | 'array_type'
  | 'slice_type'
  | 'ref_type'
  | 'volatile_type'
  | 'struct_def'
  | 'enum_def'
  // 容器字面量
  | 'array_lit'
  | 'slice_lit'
  | 'slice_range'
  | 'struct_lit'
  | 'enum_variant'
  // 语句
  | 'block'
  | 'if'
  | 'while'
  | 'for'
  | 'let'
  | 'assign'
  | 'return'
  | 'break'
  | 'continue'
  | 'expr_stmt'
  | 'defer'
  | 'asm_block'
  | 'builtin_fence'
  | 'closure_literal'
  // match
  | 'match'
  | 'match_arm'
  | 'pattern_lit'
  | 'pattern_ident'
  | 'pattern_enum'
  | 'pattern_range'
  | 'pattern_or'
  | 'pattern_wild'
  // 声明
  | 'func_decl'
  | 'type_decl'
  | 'extern_decl'
  | 'import_decl'
  | 'const_decl'
  | 'module'

/** 所有节点共有的字段。 */
export interface BaseNode {
  kind: NodeKind
  /** 起始偏移（UTF-16 code unit，含） */
  start: number
  /** 结束偏移（UTF-16 code unit，不含） */
  end: number
  /** 1-based 行号 */
  line: number
  /** 1-based 列号 */
  col: number
}

// ── 字面量 ────────────────────────────────────────────────────────

export interface IntNode extends BaseNode {
  kind: 'int'
  /** 字面值 */
  value: bigint
  /** 原始文本（含进制前缀与类型后缀） */
  raw: string
}

export interface FloatNode extends BaseNode {
  kind: 'float'
  value: number
  raw: string
}

export interface StringNode extends BaseNode {
  kind: 'string'
  /** 解码后的内容（不含两端引号，已处理转义） */
  value: string
  /** 原始文本（含两端引号） */
  raw: string
}

export interface CharNode extends BaseNode {
  kind: 'char'
  /** Unicode 码点 */
  value: number
  raw: string
}

export interface BoolNode extends BaseNode {
  kind: 'bool'
  value: boolean
}

export interface NullNode extends BaseNode {
  kind: 'null'
}

// ── 表达式 ────────────────────────────────────────────────────────

export interface IdentNode extends BaseNode {
  kind: 'ident'
  name: string
  /** 泛型实参（`Vec<i32>` 里的 `<i32>`） */
  typeArgs?: TypeExpr[]
}

export interface UnaryNode extends BaseNode {
  kind: 'unary'
  /** 运算符文本：`-` `!` `~` `&` `*` */
  op: string
  /**
   * 操作数。
   *
   * ⚠️ 类型位置的 `*T`（指针类型）编译器也用 NODE_UNARY 表示（`ast_new_unary` +
   * TOKEN_STAR），跟表达式位置的 `*p`（NODE_DEREF）区分开。所以这里的操作数
   * 可能是表达式，也可能是类型。
   */
  expr: Expr | TypeExpr
}

export interface BinaryNode extends BaseNode {
  kind: 'binary'
  /** 运算符文本 */
  op: string
  left: Expr
  right: Expr
}

export interface CallNode extends BaseNode {
  kind: 'call'
  callee: Expr
  args: Expr[]
  /** turbofish 的类型实参（`f::<i32>()`） */
  typeArgs?: TypeExpr[]
}

export interface QualifiedCallNode extends BaseNode {
  kind: 'qualified_call'
  /** 模块名 */
  module: string
  /** 函数名 */
  function: string
  args: Expr[]
}

export interface FieldNode extends BaseNode {
  kind: 'field'
  expr: Expr
  /** 字段名 */
  field: string
}

export interface IndexNode extends BaseNode {
  kind: 'index'
  expr: Expr
  index: Expr
}

export interface CastNode extends BaseNode {
  kind: 'cast'
  expr: Expr
  targetType: TypeExpr
}

export interface AddrOfNode extends BaseNode {
  kind: 'addr_of'
  expr: Expr
  /** `&mut x` 而不是 `&x` */
  isMutable: boolean
}

export interface DerefNode extends BaseNode {
  kind: 'deref'
  expr: Expr
}

export interface SizeofNode extends BaseNode {
  kind: 'sizeof'
  target: TypeExpr
}

export interface AlignofNode extends BaseNode {
  kind: 'alignof'
  target: TypeExpr
}

export interface ArrayLitNode extends BaseNode {
  kind: 'array_lit'
  elements: Expr[]
}

export interface SliceLitNode extends BaseNode {
  kind: 'slice_lit'
  /** 内部包着数组字面量 */
  array: Expr
}

export interface SliceRangeNode extends BaseNode {
  kind: 'slice_range'
  base: Expr
  /** 下界（`a[1..3]` 的 1） */
  rangeStart: Expr
  /** 上界（`a[1..3]` 的 3）；开区间时为 null */
  rangeEnd: Expr | null
}

export interface StructLitNode extends BaseNode {
  kind: 'struct_lit'
  typeName: string
  /** 泛型实参（`Pair<i32> { ... }` 里的 `<i32>`） */
  typeArgs?: TypeExpr[]
  fields: FieldInit[]
}

export interface FieldInit {
  name: string
  value: Expr
  start: number
  end: number
}

export interface EnumVariantNode extends BaseNode {
  kind: 'enum_variant'
  typeName: string
  /** 泛型实参（`Option<i32>::Some(x)` 里的 `<i32>`） */
  typeArgs?: TypeExpr[]
  variantName: string
  payload: Expr | null
}

export interface ClosureLiteralNode extends BaseNode {
  kind: 'closure_literal'
  params: FuncParam[]
  body: Expr
}

// ── 类型 ──────────────────────────────────────────────────────────

export interface ArrayTypeNode extends BaseNode {
  kind: 'array_type'
  elemType: TypeExpr
  /** 数组长度表达式；`[T; N]` 的 N */
  count: Expr | null
}

export interface SliceTypeNode extends BaseNode {
  kind: 'slice_type'
  elemType: TypeExpr
}

export interface RefTypeNode extends BaseNode {
  kind: 'ref_type'
  inner: TypeExpr
  isMutable: boolean
}

export interface VolatileTypeNode extends BaseNode {
  kind: 'volatile_type'
  inner: TypeExpr
}

export interface StructDefNode extends BaseNode {
  kind: 'struct_def'
  fields: StructField[]
}

export interface StructField {
  name: string
  typeAnnotation: TypeExpr
  start: number
  end: number
}

export interface EnumDefNode extends BaseNode {
  kind: 'enum_def'
  variants: EnumVariantDecl[]
}

export interface EnumVariantDecl {
  name: string
  /** 载荷类型；nullary 变体为 null */
  payloadType: TypeExpr | null
  start: number
  end: number
}

// ── 语句 ──────────────────────────────────────────────────────────

export interface BlockNode extends BaseNode {
  kind: 'block'
  statements: Stmt[]
}

export interface IfNode extends BaseNode {
  kind: 'if'
  cond: Expr
  /**
   * then 分支。
   *
   * 编译器对 if 的**语句形式**和**表达式形式**用同一个节点类型
   * （`ast_new_if(cond, then_body, else_body)`，两个分支都是 NodeBlock），
   * 区别只在块里装的是语句还是表达式语句。所以这里也统一用 BlockNode。
   */
  thenBody: BlockNode
  /**
   * else 分支。
   * - `null` —— 没有 else
   * - `BlockNode` —— `else { ... }`
   * - `IfNode` —— `else if ...`（else-if 链）
   */
  elseBody: BlockNode | IfNode | null
}

export interface WhileNode extends BaseNode {
  kind: 'while'
  cond: Expr
  body: BlockNode
}

export interface ForNode extends BaseNode {
  kind: 'for'
  /** 循环变量名 */
  varName: string
  /** 区间起点（`for i in a..b` 的 a） */
  rangeStart: Expr
  /** 区间终点（`for i in a..b` 的 b）；`for x in slice` 时为 null */
  rangeEnd: Expr | null
  /** `for x in slice` 时为 true */
  isSlice: boolean
  body: BlockNode
}

export interface LetNode extends BaseNode {
  kind: 'let'
  isMutable: boolean
  name: string
  typeAnnotation: TypeExpr | null
  init: Expr | null
}

export interface AssignNode extends BaseNode {
  kind: 'assign'
  target: Expr
  value: Expr
}

export interface ReturnNode extends BaseNode {
  kind: 'return'
  expr: Expr | null
}

export interface BreakNode extends BaseNode {
  kind: 'break'
}

export interface ContinueNode extends BaseNode {
  kind: 'continue'
}

export interface ExprStmtNode extends BaseNode {
  kind: 'expr_stmt'
  expr: Expr
}

export interface DeferNode extends BaseNode {
  kind: 'defer'
  expr: Expr
}

export interface AsmBlockNode extends BaseNode {
  kind: 'asm_block'
  /** 汇编文本（已去引号） */
  text: string
}

export interface BuiltinFenceNode extends BaseNode {
  kind: 'builtin_fence'
  /** `fence_seq_cst` / `fence_acquire` / `fence_release` */
  fence: string
}

// ── match ─────────────────────────────────────────────────────────

export interface MatchNode extends BaseNode {
  kind: 'match'
  subject: Expr
  arms: MatchArm[]
}

export interface MatchArm {
  pattern: Pattern
  body: Expr
  start: number
  end: number
}

export type Pattern =
  | PatternLitNode
  | PatternIdentNode
  | PatternEnumNode
  | PatternRangeNode
  | PatternOrNode
  | PatternWildNode

export interface PatternLitNode extends BaseNode {
  kind: 'pattern_lit'
  /** 字面值 */
  value: bigint | number | boolean
  /** 字面量的种类 */
  litKind: 'int' | 'float' | 'char' | 'bool'
  raw: string
}

export interface PatternIdentNode extends BaseNode {
  kind: 'pattern_ident'
  name: string
}

export interface PatternEnumNode extends BaseNode {
  kind: 'pattern_enum'
  typeName: string | null
  variantName: string
  /** 变体绑定的变量 */
  inner: Pattern | null
}

export interface PatternRangeNode extends BaseNode {
  kind: 'pattern_range'
  lo: Pattern
  hi: Pattern
}

export interface PatternOrNode extends BaseNode {
  kind: 'pattern_or'
  left: Pattern
  right: Pattern
}

export interface PatternWildNode extends BaseNode {
  kind: 'pattern_wild'
}

// ── 声明 ──────────────────────────────────────────────────────────

export interface FuncDeclNode extends BaseNode {
  kind: 'func_decl'
  name: string
  params: FuncParam[]
  returnType: TypeExpr | null
  body: BlockNode | null
  isExtern: boolean
  isInline: boolean
  isNaked: boolean
  linkSection: string | null
  /** 泛型参数名（`fn max<T>(...)`） */
  typeParams: string[]
}

export interface FuncParam {
  name: string
  typeAnnotation: TypeExpr
  start: number
  end: number
}

export interface TypeDeclNode extends BaseNode {
  kind: 'type_decl'
  name: string
  /** struct_def / enum_def / 其它类型表达式（别名） */
  body: TypeExpr
  typeParams: string[]
}

export interface ExternDeclNode extends BaseNode {
  kind: 'extern_decl'
  name: string
  params: FuncParam[]
  returnType: TypeExpr | null
}

export interface ImportDeclNode extends BaseNode {
  kind: 'import_decl'
  /** 模块名（裸标识符，不带 `std::`） */
  name: string
}

export interface ConstDeclNode extends BaseNode {
  kind: 'const_decl'
  name: string
  typeAnnotation: TypeExpr | null
  init: Expr
}

export interface ModuleNode extends BaseNode {
  kind: 'module'
  declarations: Decl[]
  /** `#[no_std]` */
  isNoStd: boolean
}

// ── 联合类型 ──────────────────────────────────────────────────────

export type Expr =
  | IntNode
  | FloatNode
  | StringNode
  | CharNode
  | BoolNode
  | NullNode
  | IdentNode
  | UnaryNode
  | BinaryNode
  | AssignNode
  | CallNode
  | QualifiedCallNode
  | FieldNode
  | IndexNode
  | CastNode
  | AddrOfNode
  | DerefNode
  | SizeofNode
  | AlignofNode
  | ArrayLitNode
  | SliceLitNode
  | SliceRangeNode
  | StructLitNode
  | EnumVariantNode
  | ClosureLiteralNode
  | BuiltinFenceNode
  | AsmBlockNode
  // if / match 两种形式（语句位与表达式位）编译器用**同一个**节点类型
  | IfNode
  | MatchNode

export type Stmt =
  | BlockNode
  | IfNode
  | WhileNode
  | ForNode
  | LetNode
  | AssignNode
  | ReturnNode
  | BreakNode
  | ContinueNode
  | ExprStmtNode
  | DeferNode
  | AsmBlockNode
  | BuiltinFenceNode
  | MatchNode

export type TypeExpr =
  | IdentNode
  // 类型位置的 `*T`（指针）编译器也用 NODE_UNARY 表示
  | UnaryNode
  | ArrayTypeNode
  | SliceTypeNode
  | RefTypeNode
  | VolatileTypeNode
  | StructDefNode
  | EnumDefNode

export type Decl =
  | FuncDeclNode
  | TypeDeclNode
  | ExternDeclNode
  | ImportDeclNode
  | ConstDeclNode
  | LetNode
  // 顶层也可能是表达式语句（编译器 parse_decl 兜底走 parse_stmt）
  | ExprStmtNode

export type Node =
  | Expr
  | Stmt
  | TypeExpr
  | Decl
  | ModuleNode
  | MatchArm
  | Pattern

/** 源码里的一段文字（逃生舱块用）。 */
export interface SourceSlice {
  start: number
  end: number
  text: string
}
