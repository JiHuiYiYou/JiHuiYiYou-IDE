import type {
  BlockNode,
  Decl,
  IfNode,
  EnumDefNode,
  EnumVariantDecl,
  Expr,
  FieldInit,
  FuncParam,
  MatchArm,
  ModuleNode,
  Pattern,
  Stmt,
  StructDefNode,
  StructField,
  TypeExpr,
} from '../ast'
import { parse } from '../parser'
import { BLOCK, decodeOpaque, type BlockTree } from './tree'

/**
 * 块树 → AST（编译器）。
 *
 * 产出的是**和文本视图完全一样的 AST** —— 所以两边共用同一个打印器
 * （`printer.ts`），永远不会对同一份代码产生不同输出。
 *
 * 不透明块（`jhyy_opaque`）里装的是原始源码，这里**重新解析**它，
 * 把解析出来的节点接回去 —— 这样手写代码往返无损。
 */

const NO_POS = { start: 0, end: 0, line: 1, col: 1 }

/** 语句列表 → 块节点。 */
function makeBlock(statements: Stmt[]): BlockNode {
  return { kind: 'block', ...NO_POS, statements }
}

/** 解析一段不透明代码（**当成模块**解析 ⇒ 拿到的是声明）。 */
function parseSnippet(code: string): { decls: Decl[]; stmts: Stmt[] } {
  const result = parse(code)
  const decls = result.module?.declarations ?? []
  const stmts: Stmt[] = []
  for (const decl of decls) {
    if (decl.kind === 'expr_stmt' || decl.kind === 'let') stmts.push(decl)
  }
  return { decls, stmts }
}

/**
 * 解析一段**语句**（不透明块在语句位置用）。
 *
 * ⚠️ **必须当成「函数体」解析** —— 当成模块解析的话，语句的种类会漏：
 *    `defer` / `asm!` / `fence_*()` 这些**只在函数体里**才是语句
 *    （在模块层面它们是「不认识的东西」）⇒ 会被漏掉 ⇒
 *    **一条 `defer` 语句在块视图里就凭空消失了**（实测：`defer cleanup();`
 *    往返之后变成了 `let ;`）✗
 */
function parseStmts(code: string): Stmt[] {
  const result = parse(`fn __jhyy_snip() -> i32 {\n${code}\n}`)
  const decl = result.module?.declarations[0]
  if (!decl || decl.kind !== 'func_decl' || !decl.body) return []
  return decl.body.statements
}

/** 不透明块在声明位置 → 解析出来的声明。 */
function opaqueDecls(tree: BlockTree): Decl[] {
  const code = decodeOpaque(tree.fields?.CODE ?? '')
  if (!code.trim()) return []
  return parseSnippet(code).decls
}

/** 不透明块在语句位置 → 解析出来的语句。 */
function opaqueStmts(tree: BlockTree): Stmt[] {
  const code = decodeOpaque(tree.fields?.CODE ?? '')
  if (!code.trim()) return []
  return parseStmts(code)
}

/** match 的分支列表。 */
function compileArms(tree: BlockTree): MatchArm[] {
  return (tree.statements?.ARMS ?? [])
    .map((a) => {
      const body = compileExpr(a.inputs?.BODY)
      if (!body) return null
      const pattern = parsePatternText(a.fields?.PATTERN ?? '_')
      if (!pattern) return null
      return { pattern, body, start: 0, end: 0 }
    })
    .filter((a): a is MatchArm => a !== null)
}

/** 容器里的值槽位 → 表达式列表。 */
function compileSlots(slots: BlockTree[]): Expr[] {
  return slots
    .map((slot) => compileExpr(slot.inputs?.ARG))
    .filter((e): e is Expr => e !== null)
}

// ── 类型 ──────────────────────────────────────────────────────────

/** 类型文本 → 类型节点。 */
function parseTypeText(text: string): TypeExpr | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 借用一个最小语法来解析类型文本
  const result = parse(`fn __t(x: ${trimmed}) -> i32 { 0 }`)
  const decl = result.module?.declarations[0]
  if (!decl || decl.kind !== 'func_decl') return null
  const param = decl.params[0]
  return param ? param.typeAnnotation : null
}

// ── 表达式 ────────────────────────────────────────────────────────

export function compileExpr(tree: BlockTree | null | undefined): Expr | null {
  if (!tree) return null

  switch (tree.type) {
    case BLOCK.value: {
      const kind = tree.fields?.KIND ?? 'number'
      const content = tree.fields?.VALUE ?? ''
      /*
        ⚠️ **字面量的文本要按 `KIND` 生成** —— 以前是把 `VALUE` 原样塞进 `raw`
        ⇒ **`KIND` 那个下拉完全没用**：选「字符串」+ 填 `hi` 生成的还是 `hi`
        （一个标识符！）⇒ 用户的代码被改成了别的东西 ✗
        ⇒ 现在：`KIND` 决定引号/字面量形态，`VALUE` 只是**内容** ✓
      */
      const raw =
        kind === 'string'
          ? `"${content}"`
          : kind === 'char'
            ? `'${content}'`
            : kind === 'bool'
              ? content.trim() === 'true'
                ? 'true'
                : 'false'
              : content.trim()
      // ⚠️ **用真的解析器解析这个字面量** ⇒ 进制前缀 / 类型后缀 / 浮点全都对
      //    （`2.5f32`、`18446744073709551615u64`、`0u16`、`0xFF`…）
      //    —— 自己手写 `BigInt()` 会把这些**当成 0**（值被悄悄改掉）✗
      return (
        parseLiteral(raw) ?? { kind: 'int' as const, ...NO_POS, value: 0n, raw: '0' }
      )
    }

    case BLOCK.variable:
      return {
        kind: 'ident',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        // ⚠️ **泛型实参不能丢** —— `Cap<i32>` 少了 `<i32>` 编译器会拒绝
        typeArgs: parseTypeArgs(tree.fields?.TYPEARGS),
      }

    case BLOCK.binop: {
      const left = compileExpr(tree.inputs?.LEFT)
      const right = compileExpr(tree.inputs?.RIGHT)
      if (!left || !right) return null
      return { kind: 'binary', ...NO_POS, op: tree.fields?.OP ?? '+', left, right }
    }

    case BLOCK.unop: {
      const value = compileExpr(tree.inputs?.VALUE)
      if (!value) return null
      return { kind: 'unary', ...NO_POS, op: tree.fields?.OP ?? '-', expr: value }
    }

    case BLOCK.set: {
      const target = compileExpr(tree.inputs?.TARGET)
      const value = compileExpr(tree.inputs?.VALUE)
      if (!target || !value) return null
      return { kind: 'assign', ...NO_POS, target, value }
    }

    case BLOCK.call: {
      const callee: Expr = { kind: 'ident', ...NO_POS, name: tree.fields?.NAME ?? '' }
      const args = compileSlots(tree.statements?.ARGS ?? [])
      return {
        kind: 'call',
        ...NO_POS,
        callee,
        args,
        // ⚠️ **turbofish 不能丢** —— `max::<i32>(7, 2)` 少了它编译器会拒绝
        typeArgs: parseTypeArgs(tree.fields?.TYPEARGS),
      }
    }

    // 值形态的赋值 / if / match
    case BLOCK.setValue: {
      const target = compileExpr(tree.inputs?.TARGET)
      const value = compileExpr(tree.inputs?.VALUE)
      if (!target || !value) return null
      return { kind: 'assign', ...NO_POS, target, value }
    }

    case BLOCK.ifValue: {
      const cond = compileExpr(tree.inputs?.COND)
      if (!cond) return null
      const thenBody = makeBlock(compileStmtList(tree.statements?.THEN ?? []))
      const elseList = tree.statements?.ELSE ?? []
      let elseBody: BlockNode | IfNode | null = null
      // 值形态的 else-if 链：语句容器里放的是「表达式语句」块包着的 if
      //
      // ⚠️ **必须看里面装的是不是 if** —— 只看「是不是 exprStmt」不够：
      // 普通的 `else { 3 }` 也是 exprStmt 包着一个值表达式，
      // 要是把它当成 else-if 链，**整个 else 分支就被丢了**。
      if (
        elseList.length === 1 &&
        elseList[0].type === BLOCK.exprStmt &&
        elseList[0].inputs?.VALUE?.type === BLOCK.ifValue
      ) {
        const nested = compileExpr(elseList[0].inputs?.VALUE)
        elseBody = nested && nested.kind === 'if' ? nested : null
      } else if (elseList.length > 0) {
        elseBody = makeBlock(compileStmtList(elseList))
      }
      return { kind: 'if', ...NO_POS, cond, thenBody, elseBody }
    }

    case BLOCK.matchValue: {
      const subject = compileExpr(tree.inputs?.SUBJECT)
      if (!subject) return null
      return { kind: 'match', ...NO_POS, subject, arms: compileArms(tree) }
    }

    // 表达式语句块出现在值位置 —— 取里面的表达式
    case BLOCK.exprStmt:
      return compileExpr(tree.inputs?.VALUE)

    case BLOCK.qualifiedCall: {
      const args = compileSlots(tree.statements?.ARGS ?? [])
      return {
        kind: 'qualified_call',
        ...NO_POS,
        module: tree.fields?.MODULE ?? '',
        function: tree.fields?.NAME ?? '',
        args,
      }
    }

    case BLOCK.field: {
      const obj = compileExpr(tree.inputs?.OBJ)
      if (!obj) return null
      return { kind: 'field', ...NO_POS, expr: obj, field: tree.fields?.NAME ?? '' }
    }

    case BLOCK.index: {
      const arr = compileExpr(tree.inputs?.ARR)
      const index = compileExpr(tree.inputs?.INDEX)
      if (!arr || !index) return null
      return { kind: 'index', ...NO_POS, expr: arr, index }
    }

    case BLOCK.cast: {
      const value = compileExpr(tree.inputs?.VALUE)
      const targetType = parseTypeText(tree.fields?.TYPE ?? '')
      if (!value || !targetType) return null
      return { kind: 'cast', ...NO_POS, expr: value, targetType }
    }

    case BLOCK.array: {
      const elements = compileSlots(tree.statements?.ELEMS ?? [])
      return { kind: 'array_lit', ...NO_POS, elements }
    }

    case BLOCK.structLit: {
      const fields: FieldInit[] = (tree.statements?.FIELDS ?? [])
        .map((f) => {
          const value = compileExpr(f.inputs?.VALUE)
          if (!value) return null
          return { name: f.fields?.NAME ?? '', value, start: 0, end: 0 }
        })
        .filter((f): f is FieldInit => f !== null)
      return {
        kind: 'struct_lit',
        ...NO_POS,
        typeName: tree.fields?.TYPE ?? '',
        typeArgs: parseTypeArgs(tree.fields?.TYPEARGS),
        fields,
      }
    }

    case BLOCK.enumVariant: {
      const payload = compileExpr(tree.inputs?.PAYLOAD)
      return {
        kind: 'enum_variant',
        ...NO_POS,
        typeName: tree.fields?.TYPE ?? '',
        variantName: tree.fields?.VARIANT ?? '',
        typeArgs: parseTypeArgs(tree.fields?.TYPEARGS),
        payload,
      }
    }

    case BLOCK.print: {
      const fmt = tree.fields?.FMT ?? '%d\\n'
      // ⚠️ **值可以留空** —— `printf` 的签名是固定的（`fmt: *u8, val: i32`），
      //   所以格式串里**没有**占位符时，那个值就是个摆设。
      //   用户以前每次都得拖一个「实参 + number 0」（用户报过「很复杂」），
      //   现在留空 ⇒ 自动补 0 ✓。
      const value = compileExpr(tree.inputs?.VALUE) ?? {
        kind: 'int' as const,
        ...NO_POS,
        value: 0n,
        raw: '0',
      }
      return {
        kind: 'call',
        ...NO_POS,
        callee: { kind: 'ident', ...NO_POS, name: 'printf' },
        args: [
          {
            kind: 'string',
            ...NO_POS,
            value: fmt,
            // ⚠️ **不能**用 JSON.stringify —— 它会把 `\n` 里的反斜杠也转义成
            //   `\\n`，打印出来就多了个反斜杠。格式串里的 `\n` 要**原样**保留 ✓。
            raw: `"${fmt}"`,
          },
          value,
        ],
      }
    }

    /*
      读入一个整数 —— `scanf("%d", &x)`。

      ⚠️ **取地址由块自己加** —— 「取地址」在块子集里没有对应的块
      （以前只能靠「原始代码」逃生舱），新手根本用不了 ✓。
    */
    case BLOCK.input: {
      const value = compileExpr(tree.inputs?.VALUE)
      if (!value) return null
      return {
        kind: 'call',
        ...NO_POS,
        callee: { kind: 'ident', ...NO_POS, name: 'scanf' },
        args: [
          { kind: 'string', ...NO_POS, value: '%d', raw: '"%d"' },
          { kind: 'addr_of', ...NO_POS, expr: value, isMutable: false },
        ],
      }
    }

    case BLOCK.if: {
      const cond = compileExpr(tree.inputs?.COND)
      if (!cond) return null
      const thenBody = makeBlock(compileStmtList(tree.statements?.THEN ?? []))
      const elseList = tree.statements?.ELSE ?? []
      let elseBody: BlockNode | IfNode | null = null
      if (elseList.length === 1 && elseList[0].type === BLOCK.if) {
        // else-if 链
        const nested = compileExpr(elseList[0])
        elseBody = nested && nested.kind === 'if' ? nested : null
      } else if (elseList.length > 0) {
        elseBody = makeBlock(compileStmtList(elseList))
      }
      return { kind: 'if', ...NO_POS, cond, thenBody, elseBody }
    }

    case BLOCK.match: {
      const subject = compileExpr(tree.inputs?.SUBJECT)
      if (!subject) return null
      return { kind: 'match', ...NO_POS, subject, arms: compileArms(tree) }
    }

    case BLOCK.opaque:
    case BLOCK.opaqueValue: {
      // 不透明块 → 重新解析里面的源码
      const { decls, stmts } = parseSnippet(decodeOpaque(tree.fields?.CODE ?? ''))
      const first = decls[0]
      if (first && first.kind !== 'expr_stmt' && first.kind !== 'let') {
        // 声明形态的代码在表达式位置没法用
        return null
      }
      const stmt = stmts[0]
      return stmt && stmt.kind === 'expr_stmt' ? stmt.expr : null
    }

    default:
      return null
  }
}

/**
 * 解析一个字面量文本 → AST 节点。
 *
 * ⚠️ **必须用真的词法/语法** —— 手写 `BigInt()` / `Number()` 会把
 *    `2.5f32`、`18446744073709551615u64`、`0u16`、`0xFF` 这些**当成 0**
 *    （值被悄悄改掉，而编译器**不报错**）✗
 *    ⇒ 借一小段语法把字面量交给**同一个解析器** ✓
 *
 * ⚠️ 只接受**真的字面量** —— 用户在字段里填了 `abc` 的话，那是个标识符，
 *    不能当字面量编出去（否则 `KIND=string` + `abc` 会生成一个变量引用）✗
 */
function parseLiteral(raw: string): Expr | null {
  if (!raw) return null
  const result = parse(`fn __lit() -> i32 { let __v = ${raw}; }`)
  const decl = result.module?.declarations[0]
  if (!decl || decl.kind !== 'func_decl' || !decl.body) return null
  const stmt = decl.body.statements[0]
  if (!stmt || stmt.kind !== 'let' || !stmt.init) return null
  const init = stmt.init
  switch (init.kind) {
    case 'int':
    case 'float':
    case 'string':
    case 'char':
    case 'bool':
      // 位置是**片段里**的 ⇒ 换成 NO_POS（块路径的节点都不带真实位置）
      return { ...init, start: 0, end: 0, line: 1, col: 1 }
    default:
      return null
  }
}

/**
 * 泛型参数列表文本（`T, U`）→ 参数名数组。
 *
 * ⚠️ 以前块树里**没有**这个信息 ⇒ 泛型声明往返之后**泛型参数全丢了**
 *    （`fn max<T>(a: T, b: T) -> T` → `fn max(a: T, b: T) -> T`）
 *    ⇒ **编译器会拒绝**（用了没声明的泛型参数）✗✗
 */
function parseTypeParams(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 泛型实参文本（`i32, i64`）→ 类型列表。
 *
 * ⚠️ 以前**整段丢了** —— `Cap<i32> { ... }` 变成 `Cap { ... }`、
 *    `max::<i32>(7, 2)` 变成 `max(7, 2)` ⇒ 泛型代码**编译不过** ✗
 */
function parseTypeArgs(text: string | undefined): TypeExpr[] | undefined {
  if (!text || !text.trim()) return undefined
  const out: TypeExpr[] = []
  for (const part of text.split(',')) {
    const t = part.trim()
    if (!t) continue
    const type = parseTypeText(t)
    if (!type) return undefined
    out.push(type)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 属性文本（`inline` / `naked` / `link_section(".text")`，逗号分隔）→ 属性。
 *
 * ⚠️ 以前块树里**没有**这个信息 ⇒ `#[inline]` / `#[naked]` / `#[link_section]`
 *    往返之后**全丢了**（`#[inline] fn dbl(...)` → `fn dbl(...)`）✗
 */
function parseAttrs(text: string | undefined): {
  isInline: boolean
  isNaked: boolean
  linkSection: string | null
} {
  let isInline = false
  let isNaked = false
  let linkSection: string | null = null
  for (const part of (text ?? '').split(',')) {
    const t = part.trim()
    if (t === 'inline') isInline = true
    else if (t === 'naked') isNaked = true
    else {
      const m = /link_section\(\s*"([^"]*)"\s*\)/.exec(t)
      if (m) linkSection = m[1]
    }
  }
  return { isInline, isNaked, linkSection }
}

// ── 模式 ──────────────────────────────────────────────────────────

/** 模式文本 → 模式节点。 */
export function parsePatternText(text: string): Pattern | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  /*
    用一个 match 的 arm 来借用模式解析器。

    ⚠️ `assumeEnumPatterns: true` —— 这段片段里**没有 enum 声明**
    ⇒ 符号表是空的 ⇒ 短名变体 `Some(v)` 会被当成绑定 `Some`
    ⇒ **括号里的绑定被静默丢掉**（`Some(v) => v` 变成 `Some => v`，
    而 body 还在引用 `v` ⇒ 读一个未定义的变量）✗
    ⇒ 这条路用「`标识符(` 一定是带载荷的变体」兜底 ✓
  */
  const result = parse(`fn __m(x: i32) -> i32 { match x { ${trimmed} => 0, } }`, {
    assumeEnumPatterns: true,
  })
  const decl = result.module?.declarations[0]
  if (!decl || decl.kind !== 'func_decl' || !decl.body) return null
  const stmt = decl.body.statements[0]
  if (!stmt || stmt.kind !== 'match') return null
  const arm = stmt.arms[0]
  return arm ? arm.pattern : null
}

// ── 语句 ──────────────────────────────────────────────────────────

export function compileStmtList(trees: BlockTree[]): Stmt[] {
  const out: Stmt[] = []
  for (const tree of trees) {
    const stmt = compileStmt(tree)
    if (stmt) out.push(stmt)
  }
  return out
}

export function compileStmt(tree: BlockTree): Stmt | null {
  switch (tree.type) {
    case BLOCK.let: {
      /*
        ⚠️ **没有初始值 ⇒ 补 0**（不是不写）——
        真实编译器的 `parse_let` **强制要求 `=`**（`let x;` 是语法错误）
        ⇒ 以前这里 `init` 为 null 时打印器会吐出 `let x;`
        ⇒ **块视图能生成连 IDE 自己都解析不了的代码** ✗
        ⇒ 补 0（跟「打印块没有占位符时实参自动补 0」一个路子）✓
      */
      const init = compileExpr(tree.inputs?.VALUE) ?? {
        kind: 'int' as const,
        ...NO_POS,
        value: 0n,
        raw: '0',
      }
      const typeAnnotation = parseTypeText(tree.fields?.TYPE ?? '')
      return {
        kind: 'let',
        ...NO_POS,
        isMutable: tree.fields?.MUT === 'TRUE',
        name: tree.fields?.NAME ?? '',
        typeAnnotation,
        init,
      }
    }

    case BLOCK.set: {
      const target = compileExpr(tree.inputs?.TARGET)
      const value = compileExpr(tree.inputs?.VALUE)
      if (!target || !value) return null
      // 赋值在 JHYY 里是表达式；作为语句用时包一层 expr_stmt
      return { kind: 'expr_stmt', ...NO_POS, expr: { kind: 'assign', ...NO_POS, target, value } }
    }

    case BLOCK.if: {
      const cond = compileExpr(tree.inputs?.COND)
      if (!cond) return null
      const thenBody = makeBlock(compileStmtList(tree.statements?.THEN ?? []))
      const elseList = tree.statements?.ELSE ?? []
      let elseBody: BlockNode | IfNode | null = null
      if (elseList.length === 1 && elseList[0].type === BLOCK.if) {
        const nested = compileStmt(elseList[0])
        elseBody = nested && nested.kind === 'if' ? nested : null
      } else if (elseList.length > 0) {
        elseBody = makeBlock(compileStmtList(elseList))
      }
      return { kind: 'if', ...NO_POS, cond, thenBody, elseBody }
    }

    case BLOCK.while: {
      const cond = compileExpr(tree.inputs?.COND)
      if (!cond) return null
      return {
        kind: 'while',
        ...NO_POS,
        cond,
        body: { kind: 'block', ...NO_POS, statements: compileStmtList(tree.statements?.BODY ?? []) },
      }
    }

    case BLOCK.for: {
      const start = compileExpr(tree.inputs?.START)
      const end = compileExpr(tree.inputs?.END)
      if (!start) return null
      /*
        ⚠️ **`isSlice` 不能写死成 false** —— `for x in slice`（迭代切片）和
        `for i in a..b`（迭代区间）是**两种循环**：
        - 区间是**半开**的 ⇒ `a..b` 迭代 b-a 次
        - 切片是**遍历元素** ⇒ `for x in s`
        以前写死 false ⇒ 切片循环被改成 `for x in s..0` ⇒ **循环体一次都不跑**
        （而且编译器**不报错** —— 它只是迭代了一个空区间）✗✗
        ⇒ 块树上用 `FORM` 字段区分（`'SLICE'` / `'RANGE'`）✓
      */
      const isSlice = tree.fields?.FORM === 'SLICE'
      return {
        kind: 'for',
        ...NO_POS,
        varName: tree.fields?.NAME ?? '',
        rangeStart: start,
        rangeEnd: isSlice ? null : end,
        isSlice,
        body: { kind: 'block', ...NO_POS, statements: compileStmtList(tree.statements?.BODY ?? []) },
      }
    }

    case BLOCK.return: {
      const value = compileExpr(tree.inputs?.VALUE)
      return { kind: 'return', ...NO_POS, expr: value }
    }

    case BLOCK.break:
      return { kind: 'break', ...NO_POS }

    case BLOCK.continue:
      return { kind: 'continue', ...NO_POS }

    case BLOCK.match: {
      const subject = compileExpr(tree.inputs?.SUBJECT)
      if (!subject) return null
      return { kind: 'match', ...NO_POS, subject, arms: compileArms(tree) }
    }

    // 语句形态的调用 / 限定调用
    case BLOCK.callStmt: {
      const callee: Expr = { kind: 'ident', ...NO_POS, name: tree.fields?.NAME ?? '' }
      const args = compileSlots(tree.statements?.ARGS ?? [])
      return {
        kind: 'expr_stmt',
        ...NO_POS,
        expr: {
          kind: 'call',
          ...NO_POS,
          callee,
          args,
          typeArgs: parseTypeArgs(tree.fields?.TYPEARGS),
        },
      }
    }

    case BLOCK.qualifiedCallStmt: {
      const args = compileSlots(tree.statements?.ARGS ?? [])
      return {
        kind: 'expr_stmt',
        ...NO_POS,
        expr: {
          kind: 'qualified_call',
          ...NO_POS,
          module: tree.fields?.MODULE ?? '',
          function: tree.fields?.NAME ?? '',
          args,
        },
      }
    }

    // 表达式语句：求值但丢弃结果
    case BLOCK.exprStmt: {
      const expr = compileExpr(tree.inputs?.VALUE)
      if (!expr) return null
      return { kind: 'expr_stmt', ...NO_POS, expr }
    }

    case BLOCK.opaque:
      return opaqueStmts(tree)[0] ?? null

    default: {
      // 表达式块出现在语句位置 → 包成表达式语句
      const expr = compileExpr(tree)
      if (!expr) return null
      return { kind: 'expr_stmt', ...NO_POS, expr }
    }
  }
}

// ── 声明 ──────────────────────────────────────────────────────────

export function compileDeclList(trees: BlockTree[]): Decl[] {
  const out: Decl[] = []
  for (const tree of trees) {
    const decl = compileDecl(tree)
    if (decl) out.push(decl)
  }
  return out
}

export function compileDecl(tree: BlockTree): Decl | null {
  switch (tree.type) {
    case BLOCK.func: {
      const params: FuncParam[] = (tree.statements?.PARAMS ?? [])
        .map((p) => {
          const type = parseTypeText(p.fields?.TYPE ?? '')
          if (!type) return null
          return { name: p.fields?.NAME ?? '', typeAnnotation: type, start: 0, end: 0 }
        })
        .filter((p): p is FuncParam => p !== null)
      const returnType = parseTypeText(tree.fields?.RET ?? '')
      const attrs = parseAttrs(tree.fields?.ATTRS)
      return {
        kind: 'func_decl',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        params,
        returnType,
        body: { kind: 'block', ...NO_POS, statements: compileStmtList(tree.statements?.BODY ?? []) },
        isExtern: false,
        isInline: attrs.isInline,
        isNaked: attrs.isNaked,
        linkSection: attrs.linkSection,
        // ⚠️ **泛型参数不能丢** —— 丢了编译器会拒绝（用了没声明的参数）✗
        typeParams: parseTypeParams(tree.fields?.TYPEPARAMS),
      }
    }

    case BLOCK.structDef: {
      const fields: StructField[] = (tree.statements?.FIELDS ?? [])
        .map((f) => {
          const type = parseTypeText(f.fields?.TYPE ?? '')
          if (!type) return null
          return { name: f.fields?.NAME ?? '', typeAnnotation: type, start: 0, end: 0 }
        })
        .filter((f): f is StructField => f !== null)
      const def: StructDefNode = { kind: 'struct_def', ...NO_POS, fields }
      return {
        kind: 'type_decl',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        body: def,
        typeParams: parseTypeParams(tree.fields?.TYPEPARAMS),
      }
    }

    case BLOCK.enumDef: {
      const variants: EnumVariantDecl[] = (tree.statements?.VARIANTS ?? [])
        .map((v) => {
          const payloadType = parseTypeText(v.fields?.TYPE ?? '')
          return {
            name: v.fields?.NAME ?? '',
            payloadType,
            start: 0,
            end: 0,
          }
        })
        .filter((v) => v.name !== '')
      const def: EnumDefNode = { kind: 'enum_def', ...NO_POS, variants }
      return {
        kind: 'type_decl',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        body: def,
        typeParams: parseTypeParams(tree.fields?.TYPEPARAMS),
      }
    }

    case BLOCK.typedef: {
      const body = parseTypeText(tree.fields?.TYPE ?? '')
      if (!body) return null
      return {
        kind: 'type_decl',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        body,
        typeParams: parseTypeParams(tree.fields?.TYPEPARAMS),
      }
    }

    case BLOCK.import:
      return { kind: 'import_decl', ...NO_POS, name: tree.fields?.MODULE ?? '' }

    case BLOCK.externFn: {
      const name = (tree.fields?.NAME ?? '').trim()
      if (!name) return null
      const params = (tree.fields?.PARAMS ?? '').trim()
      const ret = (tree.fields?.RET ?? '').trim()
      // 借用一个**最小语法**来解析参数表 ——
      // `fn __p(fmt: *u8, val: i32) -> i32 { 0 }` 的参数表就是要的东西。
      const parsed = parse(`fn __p(${params}) -> ${ret || 'i32'} { 0 }`)
      if (parsed.errors.length > 0) return null
      const fn = parsed.module?.declarations[0]
      if (!fn || fn.kind !== 'func_decl') return null
      return {
        kind: 'extern_decl',
        ...NO_POS,
        name,
        params: fn.params,
        // 返回类型留空 ⇒ `extern fn free(p: *u8);`（没有返回值）
        returnType: ret ? fn.returnType : null,
      }
    }

    case BLOCK.let: {
      const stmt = compileStmt(tree)
      return stmt && stmt.kind === 'let' ? stmt : null
    }

    case BLOCK.opaque:
      return opaqueDecls(tree)[0] ?? null

    default:
      return null
  }
}

/** 块列表 → 模块。 */
export function compileModule(trees: BlockTree[]): ModuleNode {
  /*
    ⚠️ **模块级属性（`#[no_std]`）不是声明** —— 它挂在**模块**上
      （`ModuleNode.isNoStd`）⇒ 以前这里写死 `false` ⇒ **`#[no_std]` 丢了**
      ⇒ 程序会**多链一个运行时**（行为完全变了！）✗✗
    ⇒ 反编译器把它放在**第一个**「原始代码」块里 ⇒ 这里单独拎出来 ✓
  */
  let isNoStd = false
  const declTrees: BlockTree[] = []
  for (const tree of trees) {
    if (!isNoStd && tree.type === BLOCK.opaque) {
      const code = decodeOpaque(tree.fields?.CODE ?? '').trim()
      if (code.startsWith('#[')) {
        const parsed = parse(code)
        const mod = parsed.module
        if (mod?.isNoStd && mod.declarations.length === 0) {
          isNoStd = true
          continue
        }
      }
    }
    declTrees.push(tree)
  }

  const declarations = compileDeclList(declTrees)

  // 用了打印块但文件里没有 printf 的 extern 声明 → 补一个
  const usesPrintf = JSON.stringify(trees).includes('"jhyy_print"')
  const hasPrintfExtern = declarations.some(
    (d) => d.kind === 'extern_decl' && d.name === 'printf',
  )
  if (usesPrintf && !hasPrintfExtern) {
    declarations.push({
      kind: 'extern_decl',
      ...NO_POS,
      name: 'printf',
      params: [
        {
          name: 'fmt',
          typeAnnotation: { kind: 'ident', ...NO_POS, name: '*u8' },
          start: 0,
          end: 0,
        },
        {
          name: 'val',
          typeAnnotation: { kind: 'ident', ...NO_POS, name: 'i32' },
          start: 0,
          end: 0,
        },
      ],
      returnType: { kind: 'ident', ...NO_POS, name: 'i32' },
    })
  }

  return { kind: 'module', ...NO_POS, declarations, isNoStd }
}
