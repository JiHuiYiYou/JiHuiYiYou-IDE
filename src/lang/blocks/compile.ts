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

/** 解析一段不透明代码。 */
function parseSnippet(code: string): { decls: Decl[]; stmts: Stmt[] } {
  const result = parse(code)
  const decls = result.module?.declarations ?? []
  const stmts: Stmt[] = []
  for (const decl of decls) {
    if (decl.kind === 'expr_stmt' || decl.kind === 'let') stmts.push(decl)
  }
  return { decls, stmts }
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
  return parseSnippet(code).stmts
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
      const value = tree.fields?.VALUE ?? ''
      switch (kind) {
        case 'string':
          return { kind: 'string', ...NO_POS, value, raw: value }
        case 'char':
          return { kind: 'char', ...NO_POS, value: value.charCodeAt(0) || 0, raw: value }
        case 'bool':
          return { kind: 'bool', ...NO_POS, value: value === 'true' }
        default:
          return { kind: 'int', ...NO_POS, value: parseIntSafe(value), raw: value || '0' }
      }
    }

    case BLOCK.variable:
      return { kind: 'ident', ...NO_POS, name: tree.fields?.NAME ?? '' }

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
      return { kind: 'call', ...NO_POS, callee, args }
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
      if (elseList.length === 1 && elseList[0].type === BLOCK.ifValue) {
        const nested = compileExpr(elseList[0])
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
        payload,
      }
    }

    case BLOCK.print: {
      const value = compileExpr(tree.inputs?.VALUE)
      if (!value) return null
      const fmt = tree.fields?.FMT ?? '%d\\n'
      return {
        kind: 'call',
        ...NO_POS,
        callee: { kind: 'ident', ...NO_POS, name: 'printf' },
        args: [{ kind: 'string', ...NO_POS, value: fmt, raw: JSON.stringify(fmt) }, value],
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

    case BLOCK.opaque: {
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

function parseIntSafe(text: string): bigint {
  const t = text.trim()
  if (!t) return 0n
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) return BigInt(t)
    if (/^0[oO][0-7]+$/.test(t)) return BigInt(t)
    if (/^0[bB][01]+$/.test(t)) return BigInt(t)
    return BigInt(t)
  } catch {
    return 0n
  }
}

// ── 模式 ──────────────────────────────────────────────────────────

/** 模式文本 → 模式节点。 */
export function parsePatternText(text: string): Pattern | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 用一个 match 的 arm 来借用模式解析器
  const result = parse(`fn __m(x: i32) -> i32 { match x { ${trimmed} => 0, } }`)
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
      const init = compileExpr(tree.inputs?.VALUE)
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
      return {
        kind: 'for',
        ...NO_POS,
        varName: tree.fields?.NAME ?? '',
        rangeStart: start,
        rangeEnd: end,
        isSlice: false,
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
        expr: { kind: 'call', ...NO_POS, callee, args },
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
      return {
        kind: 'func_decl',
        ...NO_POS,
        name: tree.fields?.NAME ?? '',
        params,
        returnType,
        body: { kind: 'block', ...NO_POS, statements: compileStmtList(tree.statements?.BODY ?? []) },
        isExtern: false,
        isInline: false,
        isNaked: false,
        linkSection: null,
        typeParams: [],
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
        typeParams: [],
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
        typeParams: [],
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
        typeParams: [],
      }
    }

    case BLOCK.import:
      return { kind: 'import_decl', ...NO_POS, name: tree.fields?.MODULE ?? '' }

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
  const declarations = compileDeclList(trees)

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

  return { kind: 'module', ...NO_POS, declarations, isNoStd: false }
}
