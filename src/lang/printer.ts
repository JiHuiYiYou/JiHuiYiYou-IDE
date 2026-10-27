import type {
  BlockNode,
  Decl,
  EnumDefNode,
  Expr,
  FuncDeclNode,
  ModuleNode,
  Node,
  Pattern,
  Stmt,
  StructDefNode,
  TypeExpr,
} from './ast'

/**
 * AST → JHYY 源码。
 *
 * 打印出来的代码必须能被**真实编译器**接受 —— 这是 IDE 与编译器之间的契约。
 * 几个必须遵守的语言规则：
 *
 * - `type X = struct { ... }` / `= enum { ... }` 结尾**不能**带 `;`
 *   （带了就报 `unexpected token ';' in expression`）
 * - `import mod;` —— 模块名是裸标识符，`import std::vec;` 是解析错误
 * - `if` / `while` / `for` / `match` 作为**语句**时后面**不能**跟 `;`
 *   （编译器这几个语句解析器不消费分号，多一个 `;` 会被当成空表达式语句报错）
 * - `let` / `return` / `break` / `continue` / `defer` / 表达式语句要带 `;`
 * - 函数的**末表达式**即返回值；带不带 `;` 都编译成同一个 AST，所以统一带 `;`
 */

const INDENT = '    '

/** 把整个模块打印成源码。 */
export function print(module: ModuleNode): string {
  const out: string[] = []
  if (module.isNoStd) out.push('#[no_std]')

  for (const decl of module.declarations) {
    const text = printDecl(decl, 0)
    if (text !== '') out.push(text)
  }

  return out.join('\n') + (out.length > 0 ? '\n' : '')
}

// ── 声明 ──────────────────────────────────────────────────────────

function printDecl(decl: Decl, depth: number): string {
  const pad = INDENT.repeat(depth)
  switch (decl.kind) {
    case 'func_decl':
      return printFunc(decl, depth)
    case 'type_decl': {
      // ⚠️ 结尾不带 `;`
      const generics = decl.typeParams.length > 0 ? `<${decl.typeParams.join(', ')}>` : ''
      return `${pad}type ${decl.name}${generics} = ${printType(decl.body)}`
    }
    case 'extern_decl': {
      const ret = decl.returnType ? ` -> ${printType(decl.returnType)}` : ''
      return `${pad}extern fn ${decl.name}(${printParams(decl.params)})${ret};`
    }
    case 'import_decl':
      return `${pad}import ${decl.name};`
    case 'const_decl': {
      const annot = decl.typeAnnotation ? `: ${printType(decl.typeAnnotation)}` : ''
      return `${pad}const ${decl.name}${annot} = ${printExpr(decl.init)};`
    }
    case 'let':
      return printStmt(decl, depth)
    default:
      return printStmt(decl as unknown as Stmt, depth)
  }
}

function printFunc(fn: FuncDeclNode, depth: number): string {
  const pad = INDENT.repeat(depth)
  const attrs: string[] = []
  if (fn.isInline) attrs.push('#[inline]')
  if (fn.isNaked) attrs.push('#[naked]')
  if (fn.linkSection) attrs.push(`#[link_section("${fn.linkSection}")]`)

  const generics = fn.typeParams.length > 0 ? `<${fn.typeParams.join(', ')}>` : ''
  const ret = fn.returnType ? ` -> ${printType(fn.returnType)}` : ''
  const head = `${pad}fn ${fn.name}${generics}(${printParams(fn.params)})${ret}`

  const body = fn.body ? ` ${printBlock(fn.body, depth)}` : ';'
  const attrText = attrs.length > 0 ? attrs.map((a) => `${pad}${a}\n`).join('') : ''
  return `${attrText}${head}${body}`
}

function printParams(params: { name: string; typeAnnotation: TypeExpr }[]): string {
  return params.map((p) => `${p.name}: ${printType(p.typeAnnotation)}`).join(', ')
}


/**
 * 打印泛型实参列表。
 *
 * ⚠️ 嵌套泛型必须留空格：`Cap<PhantomData<i32>>` 里的 `>>` 在词法上是**一个**
 * 右移 token，编译器会拒。所以最后一个实参以 `>` 结尾时，闭合的 `>` 前面补空格
 * → `Cap<PhantomData<i32> >`（语言仓库的 cap_table_advanced.jhyy 就是这么写的）。
 */
function printTypeArgs(args: TypeExpr[]): string {
  if (args.length === 0) return ''
  const inner = args.map(printType).join(', ')
  const close = inner.endsWith('>') ? ' >' : '>'
  return `<${inner}${close}`
}

// ── 类型 ──────────────────────────────────────────────────────────

function printType(type: TypeExpr): string {
  switch (type.kind) {
    case 'ident': {
      const args = type.typeArgs ? printTypeArgs(type.typeArgs) : ''
      return `${type.name}${args}`
    }
    case 'array_type':
      return `[${printType(type.elemType)}; ${type.count ? printExpr(type.count) : '0'}]`
    case 'slice_type':
      return `[*]${printType(type.elemType)}`
    case 'ref_type':
      return `&${type.isMutable ? 'mut ' : ''}${printType(type.inner)}`
    case 'volatile_type':
      return `volatile ${printType(type.inner)}`
    case 'struct_def':
      return printStructDef(type)
    case 'enum_def':
      return printEnumDef(type)
    case 'unary':
      // 类型位置的 `*T`（指针）
      return `*${printType(type.expr as TypeExpr)}`

    default:
      return 'i32'
  }
}

function printStructDef(def: StructDefNode): string {
  const fields = def.fields.map((f) => `${f.name}: ${printType(f.typeAnnotation)}`)
  return `struct { ${fields.join(', ')} }`
}

function printEnumDef(def: EnumDefNode): string {
  const variants = def.variants.map((v) =>
    v.payloadType ? `${v.name}(${printType(v.payloadType)})` : v.name,
  )
  return `enum { ${variants.join(', ')} }`
}

// ── 语句 ──────────────────────────────────────────────────────────

function printStmt(stmt: Stmt, depth: number): string {
  const pad = INDENT.repeat(depth)
  switch (stmt.kind) {
    case 'let': {
      const annot = stmt.typeAnnotation ? `: ${printType(stmt.typeAnnotation)}` : ''
      const init = stmt.init ? ` = ${printExpr(stmt.init)}` : ''
      return `${pad}let ${stmt.isMutable ? 'mut ' : ''}${stmt.name}${annot}${init};`
    }
    case 'if':
      return printIf(stmt, depth)
    case 'while':
      return `${pad}while ${printExpr(stmt.cond)} ${printBlock(stmt.body, depth)}`
    case 'for': {
      const range = stmt.isSlice
        ? printExpr(stmt.rangeStart)
        : `${printExpr(stmt.rangeStart)}..${stmt.rangeEnd ? printExpr(stmt.rangeEnd) : '0'}`
      return `${pad}for ${stmt.varName} in ${range} ${printBlock(stmt.body, depth)}`
    }
    case 'match':
      return printMatch(stmt, depth)
    case 'return':
      return `${pad}return${stmt.expr ? ` ${printExpr(stmt.expr)}` : ''};`
    case 'break':
      return `${pad}break;`
    case 'continue':
      return `${pad}continue;`
    case 'expr_stmt':
      return `${pad}${printExpr(stmt.expr)};`
    case 'defer':
      return `${pad}defer ${printExpr(stmt.expr)};`
    case 'asm_block':
      return `${pad}asm!("${stmt.text}");`
    case 'builtin_fence':
      return `${pad}${stmt.fence}();`
    case 'block':
      return printBlock(stmt, depth)
    default:
      return `${pad}${printExpr(stmt as unknown as Expr)};`
  }
}

function printBlock(block: BlockNode, depth: number): string {
  const pad = INDENT.repeat(depth)
  // printStmt 已经带了自己的缩进，这里不要再加一层
  const lines = block.statements.map((s) => printStmt(s, depth + 1))
  if (lines.length === 0) return '{}'
  return `{\n${lines.join('\n')}\n${pad}}`
}

function printIf(node: Extract<Stmt, { kind: 'if' }>, depth: number): string {
  const pad = INDENT.repeat(depth)
  let out = `${pad}if ${printExpr(node.cond)} ${printBlock(node.thenBody, depth)}`
  if (node.elseBody) {
    if (node.elseBody.kind === 'if') {
      // else-if 链
      const nested = printIf(node.elseBody, depth)
      out += ` else ${nested.trimStart()}`
    } else {
      out += ` else ${printBlock(node.elseBody, depth)}`
    }
  }
  return out
}

function printMatch(node: Extract<Stmt, { kind: 'match' }>, depth: number): string {
  const pad = INDENT.repeat(depth)
  const inner = INDENT.repeat(depth + 1)
  const arms = node.arms.map((a) => `${inner}${printPattern(a.pattern)} => ${printExpr(a.body)}`)
  if (arms.length === 0) return `${pad}match ${printExpr(node.subject)} {}`
  return `${pad}match ${printExpr(node.subject)} {\n${arms.join(',\n')}\n${pad}}`
}

// ── 模式 ──────────────────────────────────────────────────────────

function printPattern(pattern: Pattern): string {
  switch (pattern.kind) {
    case 'pattern_wild':
      return '_'
    case 'pattern_ident':
      return pattern.name
    case 'pattern_lit':
      return pattern.raw
    case 'pattern_range':
      return `${printPattern(pattern.lo)}..${printPattern(pattern.hi)}`
    case 'pattern_or':
      return `${printPattern(pattern.left)} | ${printPattern(pattern.right)}`
    case 'pattern_enum': {
      const base = pattern.typeName
        ? `${pattern.typeName}::${pattern.variantName}`
        : pattern.variantName
      return pattern.inner ? `${base}(${printPattern(pattern.inner)})` : base
    }
    default:
      return '_'
  }
}

// ── 表达式 ────────────────────────────────────────────────────────

// ── 优先级 ────────────────────────────────────────────────────────
//
// AST 里**不记录括号**（括号只是分组，没有语义节点）。所以打印时必须按优先级
// 把括号补回去 —— 否则 `(a + b) as i32` 会被打成 `a + b as i32`，而后者按
// 优先级解析成 `a + (b as i32)`，**语义变了**。
//
// 数值与 parser.ts 的 PREC_* 表一一对应。

const P_ASSIGN = 1
const P_OR = 2
const P_AND = 3
const P_COMPARE = 4
const P_BIT_OR = 5
const P_BIT_XOR = 6
const P_BIT_AND = 7
const P_SHIFT = 8
const P_TERM = 9
const P_FACTOR = 10
const P_UNARY = 11
const P_PRIMARY = 12

/** 二元运算符的优先级。 */
function binaryPrecedence(op: string): number {
  switch (op) {
    case '||':
      return P_OR
    case '&&':
      return P_AND
    case '==':
    case '!=':
    case '<':
    case '>':
    case '<=':
    case '>=':
      return P_COMPARE
    case '|':
      return P_BIT_OR
    case '^':
      return P_BIT_XOR
    case '&':
      return P_BIT_AND
    case '<<':
    case '>>':
      return P_SHIFT
    case '+':
    case '-':
      return P_TERM
    case '*':
    case '/':
    case '%':
      return P_FACTOR
    default:
      return P_TERM
  }
}

/**
 * 一个表达式的"结合力"（越大绑得越紧）。
 *
 * 数值与 parser.ts 的 PREC_* 表一一对应。
 */
function precedenceOf(expr: Expr): number {
  switch (expr.kind) {
    case 'assign':
      return P_ASSIGN
    case 'binary':
      return binaryPrecedence(expr.op)
    case 'cast':
      return P_FACTOR
    case 'unary':
    case 'addr_of':
    case 'deref':
      return P_UNARY
    default:
      // 字面量 / 名字 / 调用 / 字段 / 下标 / 数组 / 结构体字面量 / if / match …
      return P_PRIMARY
  }
}

/**
 * 打印一个"操作数" —— 结合力不够时就用括号包起来。
 *
 * `minPrec` 是"这个位置至少要多紧"：操作数的结合力低于它就必须加括号。
 */
function printOperand(expr: Expr, minPrec: number): string {
  const text = printExpr(expr)
  return precedenceOf(expr) < minPrec ? `(${text})` : text
}

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'int':
      return expr.raw !== '' ? expr.raw : expr.value.toString()
    case 'float':
      return expr.raw !== '' ? expr.raw : String(expr.value)
    case 'string':
      return expr.raw !== '' ? expr.raw : JSON.stringify(expr.value)
    case 'char':
      return expr.raw !== '' ? expr.raw : `'${String.fromCodePoint(expr.value)}'`
    case 'bool':
      return expr.value ? 'true' : 'false'
    case 'null':
      return 'null'
    case 'ident': {
      const args = expr.typeArgs ? printTypeArgs(expr.typeArgs) : ''
      return `${expr.name}${args}`
    }
    case 'unary':
      return `${expr.op}${printOperand(expr.expr as Expr, P_UNARY)}`
    case 'binary': {
      const prec = binaryPrecedence(expr.op)
      // 左操作数：结合力低于本运算符才要括号（相等时左结合，语义一样）
      const left = printOperand(expr.left, prec)
      // 右操作数：结合力**小于等于**本运算符都要括号。
      //
      // 原因：编译器解析二元运算的右操作数时用的是 `parse_expr(prec + 1)`，
      // 也就是右操作数必须比本运算符**绑得更紧**才能被当成一个整体。
      // 所以 `a * b as i64` 里的 `as i64` 会被解析成 `a * (b as i64)` ——
      // 跟原树不同，必须补括号。
      const right = printOperand(expr.right, prec + 1)
      return `${left} ${expr.op} ${right}`
    }
    case 'assign':
      return `${printExpr(expr.target)} = ${printExpr(expr.value)}`
    case 'call': {
      const callee = printOperand(expr.callee, P_PRIMARY)
      const typeArgs = expr.typeArgs ? `::${printTypeArgs(expr.typeArgs)}` : ''
      const args = expr.args.map(printExpr).join(', ')
      return `${callee}${typeArgs}(${args})`
    }
    case 'qualified_call':
      return `${expr.module}::${expr.function}(${expr.args.map(printExpr).join(', ')})`
    case 'field':
      return `${printOperand(expr.expr, P_PRIMARY)}.${expr.field}`
    case 'index':
      return `${printOperand(expr.expr, P_PRIMARY)}[${printExpr(expr.index)}]`
    case 'cast':
      return `${printOperand(expr.expr, P_FACTOR)} as ${printType(expr.targetType)}`
    case 'addr_of':
      return `&${expr.isMutable ? 'mut ' : ''}${printOperand(expr.expr, P_UNARY)}`
    case 'deref':
      return `*${printOperand(expr.expr, P_UNARY)}`
    case 'sizeof':
      return `sizeof(${printType(expr.target)})`
    case 'alignof':
      return `alignof(${printType(expr.target)})`
    case 'array_lit':
      return `[${expr.elements.map(printExpr).join(', ')}]`
    case 'slice_lit':
      return `&${printExpr(expr.array)}`
    case 'slice_range':
      return `${printOperand(expr.base, P_PRIMARY)}[${printExpr(expr.rangeStart)}..${expr.rangeEnd ? printExpr(expr.rangeEnd) : ''}]`
    case 'struct_lit': {
      const args = expr.typeArgs ? printTypeArgs(expr.typeArgs) : ''
      return `${expr.typeName}${args} { ${expr.fields.map((f) => `${f.name}: ${printExpr(f.value)}`).join(', ')} }`
    }
    case 'enum_variant': {
      const args = expr.typeArgs ? printTypeArgs(expr.typeArgs) : ''
      return expr.payload
        ? `${expr.typeName}${args}::${expr.variantName}(${printExpr(expr.payload)})`
        : `${expr.typeName}${args}::${expr.variantName}`
    }
    case 'closure_literal': {
      const params = expr.params.map((p) => `${p.name}: ${printType(p.typeAnnotation)}`).join(', ')
      return `|${params}| { ${printExpr(expr.body)} }`
    }
    case 'builtin_fence':
      return `${expr.fence}()`
    case 'asm_block':
      return `asm!("${expr.text}")`
    case 'if':
      return printIfInline(expr)
    case 'match': {
      const arms = expr.arms.map((a) => `${printPattern(a.pattern)} => ${printExpr(a.body)}`)
      return `match ${printExpr(expr.subject)} { ${arms.join(', ')} }`
    }
    default: {
      // 兜底：漏掉的节点种类必须**炸出来**，不能静默打印成空串
      // （静默空串会生成语法错误的源码，症状出现在很远的地方）
      const unknown = expr as { kind: string }
      throw new Error(`printer: 还没实现的节点种类 ${unknown.kind}`)
    }
  }
}

/** if 作为表达式时的单行形式。 */
function printIfInline(node: Extract<Expr, { kind: 'if' }>): string {
  const thenText = printBlockInline(node.thenBody)
  let out = `if ${printExpr(node.cond)} ${thenText}`
  if (node.elseBody) {
    if (node.elseBody.kind === 'if') {
      out += ` else ${printIfInline(node.elseBody)}`
    } else {
      out += ` else ${printBlockInline(node.elseBody)}`
    }
  }
  return out
}

function printBlockInline(block: BlockNode): string {
  return `{ ${block.statements.map((s) => printStmt(s, 0)).join(' ')} }`
}

/** 打印任意节点（按 kind 分派）—— 供"逃生舱"以外的地方使用。 */
export function printNode(node: Node): string {
  if ('statements' in node) return printBlock(node as BlockNode, 0)
  if ('arms' in node) return printMatch(node as Extract<Stmt, { kind: 'match' }>, 0)
  return printExpr(node as Expr)
}
