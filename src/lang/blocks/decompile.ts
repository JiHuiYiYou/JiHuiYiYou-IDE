import type {
  BlockNode,
  Decl,
  Expr,
  IfNode,
  MatchArm,
  ModuleNode,
  Pattern,
  Stmt,
  TypeExpr,
} from '../ast'
import { BLOCK, block, encodeOpaque, type BlockTree } from './tree'

/**
 * AST → 块树（反编译器）。
 *
 * 块子集之外的语法 → **不透明块**（`jhyy_opaque`），内容是那一段源码原文。
 * 这样手写代码在块视图里依然可见、可保留，往返无损 —— 只有用户主动改动
 * 不透明块时，那部分才会变。
 */

/** 不透明块（**语句形态**）：装一段原始源码。 */
function opaque(node: { start: number; end: number }, source: string): BlockTree {
  return block(BLOCK.opaque, {
    fields: { CODE: encodeOpaque(source.slice(node.start, node.end)) },
  })
}

/**
 * 不透明块（**值形态**）：表达式位置的逃生舱。
 *
 * ⚠️ 必须跟语句形态**分开** —— 见 `tree.ts` 里 `BLOCK` 上那段说明：
 * Blockly 里一个块不能既有输出连接又有前后连接。
 */
function opaqueValue(node: { start: number; end: number }, source: string): BlockTree {
  return block(BLOCK.opaqueValue, {
    fields: { CODE: encodeOpaque(source.slice(node.start, node.end)) },
  })
}

/** 类型 → 文本（类型的"块"就是一段文本，块视图里用输入框表示）。 */
function typeText(type: TypeExpr, source: string): string {
  switch (type.kind) {
    case 'ident':
      return type.typeArgs && type.typeArgs.length > 0
        ? `${type.name}<${type.typeArgs.map((t) => typeText(t, source)).join(', ')}>`
        : type.name
    case 'array_type':
      return `[${typeText(type.elemType, source)}; ${type.count ? exprText(type.count, source) : '0'}]`
    case 'slice_type':
      return `[*]${typeText(type.elemType, source)}`
    case 'ref_type':
      return `&${type.isMutable ? 'mut ' : ''}${typeText(type.inner, source)}`
    case 'volatile_type':
      return `volatile ${typeText(type.inner, source)}`
    case 'unary':
      return `*${typeText(type.expr as TypeExpr, source)}`
    case 'struct_def':
      return `struct { ${type.fields.map((f) => `${f.name}: ${typeText(f.typeAnnotation, source)}`).join(', ')} }`
    case 'enum_def':
      return `enum { ${type.variants
        .map((v) => (v.payloadType ? `${v.name}(${typeText(v.payloadType, source)})` : v.name))
        .join(', ')} }`
    default: {
      const unknown = type as unknown as { start: number; end: number }
      return source.slice(unknown.start, unknown.end)
    }
  }
}

/** 表达式 → 文本（给"字段"用的场合）。 */
function exprText(expr: Expr, source: string): string {
  return source.slice(expr.start, expr.end)
}

/** 模式 → 文本（模式天然是文本形态的）。 */
function patternText(pattern: Pattern, source: string): string {
  switch (pattern.kind) {
    case 'pattern_wild':
      return '_'
    case 'pattern_ident':
      return pattern.name
    case 'pattern_lit':
      return pattern.raw
    case 'pattern_range':
      return `${patternText(pattern.lo, source)}..${patternText(pattern.hi, source)}`
    case 'pattern_or':
      return `${patternText(pattern.left, source)} | ${patternText(pattern.right, source)}`
    case 'pattern_enum': {
      const base = pattern.typeName
        ? `${pattern.typeName}::${pattern.variantName}`
        : pattern.variantName
      return pattern.inner ? `${base}(${patternText(pattern.inner, source)})` : base
    }
    default: {
      const unknown = pattern as unknown as { start: number; end: number }
      return source.slice(unknown.start, unknown.end)
    }
  }
}

/** 字面量 → 文本。 */
function literalText(expr: Expr, source: string): string {
  return source.slice(expr.start, expr.end)
}

// ── 表达式 ────────────────────────────────────────────────────────

export function decompileExpr(expr: Expr, source: string): BlockTree | null {
  switch (expr.kind) {
    case 'int':
    case 'float':
    case 'string':
    case 'char':
    case 'bool': {
      const kind =
        expr.kind === 'int'
          ? 'number'
          : expr.kind === 'float'
            ? 'number'
            : expr.kind === 'string'
              ? 'string'
              : expr.kind === 'char'
                ? 'char'
                : 'bool'
      return block(BLOCK.value, { fields: { KIND: kind, VALUE: literalText(expr, source) } })
    }

    case 'ident':
      return block(BLOCK.variable, { fields: { NAME: expr.name } })

    case 'binary':
      return block(BLOCK.binop, {
        fields: { OP: expr.op },
        inputs: {
          LEFT: decompileExpr(expr.left, source),
          RIGHT: decompileExpr(expr.right, source),
        },
      })

    case 'unary':
      return block(BLOCK.unop, {
        fields: { OP: expr.op },
        inputs: { VALUE: decompileExpr(expr.expr as Expr, source) },
      })

    case 'assign':
      // ⚠️ **值形态**的赋值（`jhyy_set_val`）——
      // 这里是**表达式**位置，语句形态的 `jhyy_set` 放这儿会崩
      // （见 `tree.ts` 里 `BLOCK` 上那段说明）。
      return block(BLOCK.setValue, {
        inputs: {
          TARGET: decompileExpr(expr.target, source),
          VALUE: decompileExpr(expr.value, source),
        },
      })

    case 'call':
      return block(BLOCK.call, {
        fields: { NAME: calleeName(expr.callee, source) },
        statements: {
          ARGS: expr.args
            .map((a) => argSlot(decompileExpr(a, source)))
            .filter((a): a is BlockTree => a !== null),
        },
      })

    case 'qualified_call':
      return block(BLOCK.qualifiedCall, {
        fields: { MODULE: expr.module, NAME: expr.function },
        statements: {
          ARGS: expr.args
            .map((a) => argSlot(decompileExpr(a, source)))
            .filter((a): a is BlockTree => a !== null),
        },
      })

    case 'field':
      return block(BLOCK.field, {
        fields: { NAME: expr.field },
        inputs: { OBJ: decompileExpr(expr.expr, source) },
      })

    case 'index':
      return block(BLOCK.index, {
        inputs: {
          ARR: decompileExpr(expr.expr, source),
          INDEX: decompileExpr(expr.index, source),
        },
      })

    case 'cast':
      return block(BLOCK.cast, {
        fields: { TYPE: typeText(expr.targetType, source) },
        inputs: { VALUE: decompileExpr(expr.expr, source) },
      })

    case 'array_lit':
      return block(BLOCK.array, {
        statements: {
          ELEMS: expr.elements
            .map((e) => argSlot(decompileExpr(e, source)))
            .filter((e): e is BlockTree => e !== null),
        },
      })

    case 'struct_lit':
      return block(BLOCK.structLit, {
        fields: { TYPE: expr.typeName },
        statements: {
          FIELDS: expr.fields
            .map((f) =>
              block(BLOCK.fieldInit, {
                fields: { NAME: f.name },
                inputs: { VALUE: decompileExpr(f.value, source) },
              }),
            )
            .filter((f): f is BlockTree => f !== null),
        },
      })

    case 'enum_variant':
      return block(BLOCK.enumVariant, {
        fields: { TYPE: expr.typeName, VARIANT: expr.variantName },
        inputs: { PAYLOAD: expr.payload ? decompileExpr(expr.payload, source) : null },
      })

    case 'if':
      // ⚠️ **值形态**的 if（`jhyy_if_val`）—— 这里是表达式位置。
      return block(BLOCK.ifValue, {
        inputs: { COND: decompileExpr(expr.cond, source) },
        statements: {
          THEN: decompileStmtList(expr.thenBody.statements, source),
          ELSE: expr.elseBody ? decompileElse(expr.elseBody, source, 'value') : [],
        },
      })

    case 'match':
      // ⚠️ **值形态**的 match（`jhyy_match_val`）。
      return block(BLOCK.matchValue, {
        inputs: { SUBJECT: decompileExpr(expr.subject, source) },
        statements: { ARMS: expr.arms.map((a) => decompileArm(a, source)) },
      })

    default:
      // 逃生舱：不在块子集里的语法 → 不透明块（**值形态**）
      return opaqueValue(expr, source)
  }
}

/**
 * 表达式语句 → 语句形态的块。
 *
 * 赋值 / 调用 / if / match 在语句位置要用「语句形态」的块（Blockly 里一个块
 * 不能既是值块又是语句块）；其余表达式用 `jhyy_expr_stmt` 包一层。
 */
function decompileExprStmt(expr: Expr, source: string): BlockTree | null {
  switch (expr.kind) {
    case 'assign':
      return block(BLOCK.set, {
        inputs: {
          TARGET: decompileExpr(expr.target, source),
          VALUE: decompileExpr(expr.value, source),
        },
      })
    case 'call': {
      // ⚠️ `printf(格式串, 值)` → **专用的打印块**（一个格式下拉 + 一个值孔）。
      //   否则会变成「调用函数 + 实参 + 实参」三层 —— 用户报过
      //   「printf 每次还得拖实参 number 0，很复杂」。
      const printed = printfBlock(expr, source)
      if (printed) return printed
      // ⚠️ `scanf("%d", &x)` → **专用的输入块**（省得新手手写取地址）。
      const scanned = scanfBlock(expr, source)
      if (scanned) return scanned
      return block(BLOCK.callStmt, {
        fields: { NAME: calleeName(expr.callee, source) },
        statements: {
          ARGS: expr.args
            .map((a) => argSlot(decompileExpr(a, source)))
            .filter((a): a is BlockTree => a !== null),
        },
      })
    }
    case 'qualified_call':
      return block(BLOCK.qualifiedCallStmt, {
        fields: { MODULE: expr.module, NAME: expr.function },
        statements: {
          ARGS: expr.args
            .map((a) => argSlot(decompileExpr(a, source)))
            .filter((a): a is BlockTree => a !== null),
        },
      })
    case 'if':
      return block(BLOCK.if, {
        inputs: { COND: decompileExpr(expr.cond, source) },
        statements: {
          THEN: decompileStmtList(expr.thenBody.statements, source),
          ELSE: expr.elseBody ? decompileElse(expr.elseBody, source, 'stmt') : [],
        },
      })
    case 'match':
      return block(BLOCK.match, {
        inputs: { SUBJECT: decompileExpr(expr.subject, source) },
        statements: { ARMS: expr.arms.map((a) => decompileArm(a, source)) },
      })
    default: {
      const inner = decompileExpr(expr, source)
      if (!inner) return null
      return block(BLOCK.exprStmt, { inputs: { VALUE: inner } })
    }
  }
}

/** 容器里的值槽位。 */
function argSlot(expr: BlockTree | null): BlockTree | null {
  if (!expr) return null
  return block(BLOCK.arg, { inputs: { ARG: expr } })
}

/**
 * `printf(格式串, 值)` → 打印块（格式下拉 + 一个值孔）。
 *
 * ⚠️ 不是 printf 就返回 null（走普通的「调用函数」块）。
 * 格式串要是**字面量**才行 —— 否则不知道该选哪个格式。
 */
function printfBlock(expr: Expr, source: string): BlockTree | null {
  if (expr.kind !== 'call') return null
  if (expr.callee.kind !== 'ident' || expr.callee.name !== 'printf') return null
  if (expr.args.length !== 2) return null
  const fmt = expr.args[0]
  if (fmt.kind !== 'string') return null
  // 格式串的内容（**去掉引号**，保留 `\n` 这种转义的原文）
  const raw = fmt.raw ?? ''
  const content = raw.length >= 2 ? raw.slice(1, -1) : raw
  const value = decompileExpr(expr.args[1], source)
  if (!value) return null
  return block(BLOCK.print, {
    fields: { FMT: content },
    // ⚠️ 格式串里**没有占位符**时，第二个参数就是个摆设（`printf` 的签名是
    //   固定的）⇒ 别把它拖成一个「实参 + number 0」（用户报过「很复杂」），
    //   留空即可（编出来会自动补 0 ✓）。
    inputs: { VALUE: hasPlaceholder(content) ? value : null },
  })
}

/** 格式串里有没有 `%` 占位符。 */
function hasPlaceholder(fmt: string): boolean {
  return /%[-+ #0]*[0-9*]*(?:\.[0-9*]+)?[hlL]?[diouxXeEfFgGaAcspn]/.test(fmt)
}

/**
 * `scanf("%d", &x)` → 输入块（一个格式下拉 + 一个变量孔）。
 *
 * ⚠️ 只有「格式是 `%d`、第二个参数是取地址」时才认 —— 别的 scanf 用法
 * 走普通的「调用函数」块（不丢代码 ✓）。
 */
function scanfBlock(expr: Expr, source: string): BlockTree | null {
  if (expr.kind !== 'call') return null
  if (expr.callee.kind !== 'ident' || expr.callee.name !== 'scanf') return null
  if (expr.args.length !== 2) return null
  const fmt = expr.args[0]
  if (fmt.kind !== 'string') return null
  const raw = fmt.raw ?? ''
  const content = raw.length >= 2 ? raw.slice(1, -1) : raw
  if (content !== '%d') return null
  const target = expr.args[1]
  if (target.kind !== 'addr_of' || target.isMutable) return null
  const value = decompileExpr(target.expr, source)
  if (!value) return null
  return block(BLOCK.input, {
    fields: { KIND: '整数' },
    inputs: { VALUE: value },
  })
}

/** 调用块里的被调函数名（只支持简单名字）。 */
function calleeName(callee: Expr, source: string): string {
  if (callee.kind === 'ident') return callee.name
  return source.slice(callee.start, callee.end)
}

/**
 * else 分支。
 *
 * ⚠️ `form` 决定 else-if 链用哪种形态：
 * - `'stmt'` —— 语句形态的 `jhyy_if`（有前后连接），直接放进语句容器。
 * - `'value'` —— 值形态的 `jhyy_if_val`（只有输出连接）。**语句容器放不下
 *   值块**（Blockly 会拿它的输出连接去接语句口 ⇒ 类型不兼容）⇒
 *   用「表达式语句」块包一层。
 */
function decompileElse(
  elseBody: BlockNode | IfNode,
  source: string,
  form: 'stmt' | 'value',
): BlockTree[] {
  if (elseBody.kind === 'if') {
    if (form === 'stmt') {
      const inner = decompileIfStmt(elseBody, source)
      return inner ? [inner] : []
    }
    const inner = decompileIfValue(elseBody, source)
    return inner ? [block(BLOCK.exprStmt, { inputs: { VALUE: inner } })] : []
  }
  return decompileStmtList(elseBody.statements, source)
}

/** 语句形态的 if。 */
function decompileIfStmt(node: IfNode, source: string): BlockTree {
  return block(BLOCK.if, {
    inputs: { COND: decompileExpr(node.cond, source) },
    statements: {
      THEN: decompileStmtList(node.thenBody.statements, source),
      ELSE: node.elseBody ? decompileElse(node.elseBody, source, 'stmt') : [],
    },
  })
}

/** 值形态的 if。 */
function decompileIfValue(node: IfNode, source: string): BlockTree {
  return block(BLOCK.ifValue, {
    inputs: { COND: decompileExpr(node.cond, source) },
    statements: {
      THEN: decompileStmtList(node.thenBody.statements, source),
      ELSE: node.elseBody ? decompileElse(node.elseBody, source, 'value') : [],
    },
  })
}

function decompileArm(arm: MatchArm, source: string): BlockTree {
  return block(BLOCK.matchArm, {
    fields: { PATTERN: patternText(arm.pattern, source) },
    inputs: { BODY: decompileExpr(arm.body, source) },
  })
}

// ── 语句 ──────────────────────────────────────────────────────────

export function decompileStmtList(stmts: Stmt[], source: string): BlockTree[] {
  const out: BlockTree[] = []
  for (const stmt of stmts) {
    const b = decompileStmt(stmt, source)
    if (b) out.push(b)
  }
  return out
}

export function decompileStmt(stmt: Stmt, source: string): BlockTree | null {
  switch (stmt.kind) {
    case 'let':
      return block(BLOCK.let, {
        fields: {
          NAME: stmt.name,
          MUT: stmt.isMutable ? 'TRUE' : 'FALSE',
          TYPE: stmt.typeAnnotation ? typeText(stmt.typeAnnotation, source) : '',
        },
        inputs: { VALUE: stmt.init ? decompileExpr(stmt.init, source) : null },
      })

    case 'expr_stmt':
      return decompileExprStmt(stmt.expr, source)

    case 'if':
      return decompileIfStmt(stmt, source)

    case 'while':
      return block(BLOCK.while, {
        inputs: { COND: decompileExpr(stmt.cond, source) },
        statements: { BODY: decompileStmtList(stmt.body.statements, source) },
      })

    case 'for':
      return block(BLOCK.for, {
        fields: { NAME: stmt.varName },
        inputs: {
          START: decompileExpr(stmt.rangeStart, source),
          END: stmt.rangeEnd ? decompileExpr(stmt.rangeEnd, source) : null,
        },
        statements: { BODY: decompileStmtList(stmt.body.statements, source) },
      })

    case 'return':
      return block(BLOCK.return, {
        inputs: { VALUE: stmt.expr ? decompileExpr(stmt.expr, source) : null },
      })

    case 'break':
      return block(BLOCK.break)

    case 'continue':
      return block(BLOCK.continue)

    case 'match':
      return block(BLOCK.match, {
        inputs: { SUBJECT: decompileExpr(stmt.subject, source) },
        statements: { ARMS: stmt.arms.map((a) => decompileArm(a, source)) },
      })

    default:
      // defer / asm / fence 等 → 不透明块
      return opaque(stmt, source)
  }
}

// ── 声明 ──────────────────────────────────────────────────────────

export function decompileDecl(decl: Decl, source: string): BlockTree | null {
  switch (decl.kind) {
    case 'func_decl':
      return block(BLOCK.func, {
        fields: {
          NAME: decl.name,
          RET: decl.returnType ? typeText(decl.returnType, source) : '',
        },
        statements: {
          PARAMS: decl.params.map((p) =>
            block(BLOCK.param, {
              fields: { NAME: p.name, TYPE: typeText(p.typeAnnotation, source) },
            }),
          ),
          BODY: decl.body ? decompileStmtList(decl.body.statements, source) : [],
        },
      })

    case 'type_decl': {
      if (decl.body.kind === 'struct_def') {
        return block(BLOCK.structDef, {
          fields: { NAME: decl.name },
          statements: {
            FIELDS: decl.body.fields.map((f) =>
              block(BLOCK.fieldDecl, {
                fields: { NAME: f.name, TYPE: typeText(f.typeAnnotation, source) },
              }),
            ),
          },
        })
      }
      if (decl.body.kind === 'enum_def') {
        return block(BLOCK.enumDef, {
          fields: { NAME: decl.name },
          statements: {
            VARIANTS: decl.body.variants.map((v) =>
              block(BLOCK.variantDecl, {
                fields: {
                  NAME: v.name,
                  TYPE: v.payloadType ? typeText(v.payloadType, source) : '',
                },
              }),
            ),
          },
        })
      }
      // 类型别名
      return block(BLOCK.typedef, {
        fields: { NAME: decl.name, TYPE: typeText(decl.body, source) },
      })
    }

    case 'import_decl':
      return block(BLOCK.import, { fields: { MODULE: decl.name } })

    case 'extern_decl': {
      // C 函数声明 —— 参数表用**文本**表示（`fmt: *u8, val: i32`）
      return block(BLOCK.externFn, {
        fields: {
          NAME: decl.name,
          PARAMS: decl.params
            .map((p) => `${p.name}: ${typeText(p.typeAnnotation, source)}`)
            .join(', '),
          RET: decl.returnType ? typeText(decl.returnType, source) : '',
        },
      })
    }

    case 'let':
      return decompileStmt(decl, source)

    default:
      // extern fn / const → 不透明块
      return opaque(decl, source)
  }
}

/** 整个模块 → 顶层块列表。 */
export function decompileModule(module: ModuleNode, source: string): BlockTree[] {
  const out: BlockTree[] = []
  for (const decl of module.declarations) {
    const b = decompileDecl(decl, source)
    if (b) out.push(b)
  }
  return out
}
