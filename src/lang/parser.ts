import type {
  BlockNode,
  Decl,
  EnumDefNode,
  EnumVariantDecl,
  Expr,
  FieldInit,
  FuncDeclNode,
  FuncParam,
  MatchArm,
  ModuleNode,
  Pattern,
  Stmt,
  StructDefNode,
  StructField,
  TypeExpr,
} from './ast'
import { Lexer, tokenize } from './lexer'
import { TokenKind, tokenKindName, type Token } from './token'

/**
 * JHYY 语法分析器 —— 移植自 `compiler/src0/parser.jhyy`。
 *
 * 与编译器版的差异：
 * - **纯句法**：不做符号解析。编译器在几处靠符号表消歧（turbofish vs `<`、
 *   `Option::None` vs `mod::fn`），IDE 侧改用**同样的句法规则**：
 *   · `ident :: <`      → turbofish（语法上唯一解）
 *   · `ident :: ident (` → 限定调用 `mod::fn(...)`
 *   · `ident :: ident`   → 枚举变体 `Option::None`
 *   · `大写 ident <`    → 泛型实参（编译器自己也用"首字母大写"这条句法规则）
 * - 错误恢复更激进：IDE 不能像编译器那样"第一个错误就 bail"，否则用户每敲一个
 *   字就看到一屏报错。IDE 会尽量往下走，把能解析的部分解析出来。
 * - 作用域/符号表完全不建 —— IDE 不需要类型信息。
 */

export interface ParseError {
  message: string
  line: number
  col: number
  start: number
  end: number
}

export interface ParseResult {
  module: ModuleNode | null
  errors: ParseError[]
}

// ── 优先级表（对齐 compiler/src0/parser.jhyy:425-437）─────────────

const PREC_NONE = 0
const PREC_ASSIGN = 1
const PREC_OR = 2
const PREC_AND = 3
const PREC_COMPARE = 4
const PREC_BIT_OR = 5
const PREC_BIT_XOR = 6
const PREC_BIT_AND = 7
const PREC_SHIFT = 8
const PREC_TERM = 9
const PREC_FACTOR = 10
const PREC_UNARY = 11
const PREC_PRIMARY = 12

/** 基础类型名 —— `volatile T` 只允许这些。 */
const PRIMITIVE_TYPES = new Set([
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
])

const FENCE_BUILTINS = new Set(['fence_seq_cst', 'fence_acquire', 'fence_release'])

class Parser {
  private readonly lexer: Lexer
  private cur: Token
  readonly errors: ParseError[] = []
  /** 本文件里用 `type X = ...` 声明过的类型名 */
  private readonly typeNames: Set<string>
  /** 本文件里声明过的枚举变体名（`type X = enum { A, B }` 里的 A / B） */
  private readonly variantNames: Set<string>

  constructor(
    source: string,
    typeNames: Set<string> = new Set(),
    variantNames: Set<string> = new Set(),
  ) {
    this.lexer = new Lexer(source)
    this.cur = this.lexer.next()
    this.typeNames = typeNames
    this.variantNames = variantNames
  }

  /**
   * 这个名字像不像一个类型名？
   *
   * 用来判断 `IDENT {` 是不是结构体字面量 —— 见 parseIdentPrefix 的说明。
   */
  private looksLikeTypeName(name: string): boolean {
    return /^[A-Z]/.test(name) || this.typeNames.has(name)
  }

  // ── token 原语 ──────────────────────────────────────────────────

  private advance(): Token {
    const prev = this.cur
    this.cur = this.lexer.next()
    return prev
  }

  private check(kind: TokenKind): boolean {
    return this.cur.kind === kind
  }

  private peekKind(): TokenKind {
    return this.lexer.peek().kind
  }

  /** 当前 token 是 kind 就消费掉，返回 true。 */
  private match(kind: TokenKind): boolean {
    if (this.check(kind)) {
      this.advance()
      return true
    }
    return false
  }

  private error(message: string, token: Token = this.cur): Token {
    this.errors.push({
      message,
      line: token.line,
      col: token.col,
      start: token.start,
      end: token.start + Math.max(token.length, 1),
    })
    return token
  }

  /** 期望某个 token；失败时记错误并**不消费**（由调用方决定怎么恢复）。 */
  private expect(kind: TokenKind, what: string): Token | null {
    if (this.check(kind)) return this.advance()
    this.error(`expected ${what}, got ${tokenKindName(this.cur.kind)}`)
    return null
  }

  private expectIdent(what: string): Token | null {
    return this.expect(TokenKind.Ident, what)
  }

  // ── 节点工厂 ────────────────────────────────────────────────────

  /**
   * 用"起始 token"和"结束位置"算出一个节点的 span。
   *
   * 结束位置可以是 Token（用它的 start+length）也可以是已经有 `end` 的节点。
   */
  private spanFrom(startTok: Token, endTok: Token | { end: number }) {
    const end = 'end' in endTok ? endTok.end : endTok.start + endTok.length
    return {
      start: startTok.start,
      end,
      line: startTok.line,
      col: startTok.col,
    }
  }

  // ── 入口 ────────────────────────────────────────────────────────

  parseModule(): ModuleNode | null {
    const startTok = this.cur
    const isNoStd = this.parseModuleAttributes()
    const declarations: Decl[] = []

    while (!this.check(TokenKind.Eof)) {
      const before = this.cur.start
      const decl = this.parseDecl()
      if (decl) declarations.push(decl)
      if (this.cur.start === before) {
        // 没进展 → 强制跳一个 token，防止死循环
        this.advance()
      }
    }

    const endTok = this.cur
    return {
      kind: 'module',
      ...this.spanFrom(startTok, endTok),
      declarations,
      isNoStd,
    }
  }

  /** 模块级属性：`#[no_std]` 等。 */
  private parseModuleAttributes(): boolean {
    let isNoStd = false
    while (this.check(TokenKind.Hash)) {
      this.advance() // '#'
      if (!this.expect(TokenKind.LBracket, '[')) break
      const nameTok = this.expectIdent('attribute name')
      const name = nameTok?.text ?? ''
      if (name === 'no_std') {
        isNoStd = true
        this.expect(TokenKind.RBracket, '] after attribute')
      } else if (name === 'inline' || name === 'naked') {
        // 函数级属性，写在文件顶部也算 —— 记下来给下一个函数用
        this.pendingAttrs.push(name)
        this.expect(TokenKind.RBracket, '] after attribute')
      } else if (name === 'link_section') {
        this.expect(TokenKind.LParen, '( after link_section')
        const s = this.expect(TokenKind.String, 'section name string')
        if (s) this.pendingLinkSection = s.text.slice(1, -1)
        this.expect(TokenKind.RParen, ') after section name')
        this.expect(TokenKind.RBracket, '] after attribute')
      } else {
        // 未知属性：吃掉到 ']'
        this.skipUnknownAttribute()
      }
    }
    return isNoStd
  }

  private pendingAttrs: string[] = []
  private pendingLinkSection: string | null = null

  private skipUnknownAttribute(): void {
    let depth = 1
    while (depth > 0 && !this.check(TokenKind.Eof)) {
      if (this.check(TokenKind.LBracket)) depth++
      if (this.check(TokenKind.RBracket)) {
        depth--
        if (depth === 0) {
          this.advance()
          return
        }
      }
      this.advance()
    }
  }

  // ── 声明 ────────────────────────────────────────────────────────

  private parseDecl(): Decl | null {
    switch (this.cur.kind) {
      case TokenKind.Fn:
      case TokenKind.Hash:
        return this.parseFunc(false)
      case TokenKind.Type:
        return this.parseTypeDecl()
      case TokenKind.Extern:
        return this.parseExternDecl()
      case TokenKind.Import:
        return this.parseImportDecl()
      case TokenKind.Const:
        return this.parseConstDecl()
      default:
        return this.parseStmt() as Decl | null
    }
  }

  /** 函数/类型声明前的 `#[...]`。 */
  private parseAttributes(): { isInline: boolean; isNaked: boolean; linkSection: string | null } {
    let isInline = false
    let isNaked = false
    let linkSection: string | null = null

    // 文件顶部的 `#[inline]` / `#[naked]` 会被 parseModuleAttributes 暂存
    while (this.pendingAttrs.length > 0) {
      const a = this.pendingAttrs.shift()!
      if (a === 'inline') isInline = true
      if (a === 'naked') isNaked = true
    }
    if (this.pendingLinkSection) {
      linkSection = this.pendingLinkSection
      this.pendingLinkSection = null
    }

    while (this.check(TokenKind.Hash)) {
      this.advance() // '#'
      if (!this.expect(TokenKind.LBracket, '[')) break
      const nameTok = this.expectIdent('attribute name')
      const name = nameTok?.text ?? ''
      if (name === 'inline') {
        isInline = true
        this.expect(TokenKind.RBracket, '] after attribute')
      } else if (name === 'naked') {
        isNaked = true
        this.expect(TokenKind.RBracket, '] after attribute')
      } else if (name === 'link_section') {
        this.expect(TokenKind.LParen, '( after link_section')
        const s = this.expect(TokenKind.String, 'section name string')
        if (s) linkSection = s.text.slice(1, -1)
        this.expect(TokenKind.RParen, ') after section name')
        this.expect(TokenKind.RBracket, '] after attribute')
      } else {
        this.skipUnknownAttribute()
      }
    }

    return { isInline, isNaked, linkSection }
  }

  private parseFunc(isExtern: boolean): FuncDeclNode | null {
    const attrs = this.parseAttributes()
    const startTok = this.cur
    if (!this.expect(TokenKind.Fn, 'fn')) return null

    const nameTok = this.expectIdent('function name')
    const name = nameTok?.text ?? ''

    // 泛型参数 `fn max<T>(...)`
    const typeParams: string[] = []
    if (this.check(TokenKind.Lt)) {
      this.advance()
      while (!this.check(TokenKind.Gt) && !this.check(TokenKind.Eof)) {
        const tp = this.expectIdent('type parameter name')
        if (tp) typeParams.push(tp.text)
        if (!this.match(TokenKind.Comma)) break
      }
      this.expect(TokenKind.Gt, '> after type param list')
    }

    const params = this.parseParamList()

    // 返回类型 `-> T`（可省略）
    let returnType: TypeExpr | null = null
    if (this.match(TokenKind.Arrow)) {
      returnType = this.parseType()
    }

    // 函数体
    let body: BlockNode | null = null
    if (this.check(TokenKind.LBrace)) {
      body = this.parseBlock()
    } else {
      this.expect(TokenKind.Semicolon, '; after function declaration')
    }

    const endTok = this.cur
    return {
      kind: 'func_decl',
      ...this.spanFrom(startTok, endTok),
      name,
      params,
      returnType,
      body,
      isExtern,
      isInline: attrs.isInline,
      isNaked: attrs.isNaked,
      linkSection: attrs.linkSection,
      typeParams,
    }
  }

  private parseParamList(): FuncParam[] {
    const params: FuncParam[] = []
    if (!this.expect(TokenKind.LParen, '(')) return params

    while (!this.check(TokenKind.RParen) && !this.check(TokenKind.Eof)) {
      const nameTok = this.expectIdent('parameter name')
      if (!nameTok) break
      this.expect(TokenKind.Colon, ':')
      const type = this.parseType()
      if (!type) break
      params.push({
        name: nameTok.text,
        typeAnnotation: type,
        start: nameTok.start,
        end: type.end,
      })
      if (!this.match(TokenKind.Comma)) break
    }

    this.expect(TokenKind.RParen, ')')
    return params
  }

  private parseTypeDecl(): Decl | null {
    const startTok = this.cur
    if (!this.expect(TokenKind.Type, 'type')) return null

    const nameTok = this.expectIdent('type name')
    const name = nameTok?.text ?? ''

    // 泛型参数 `type Pair<T> = struct { ... }`
    const typeParams: string[] = []
    if (this.check(TokenKind.Lt)) {
      this.advance()
      while (!this.check(TokenKind.Gt) && !this.check(TokenKind.Eof)) {
        const tp = this.expectIdent('type parameter name')
        if (tp) typeParams.push(tp.text)
        if (!this.match(TokenKind.Comma)) break
      }
      this.expect(TokenKind.Gt, '> after type param list')
    }

    this.expect(TokenKind.Eq, '=')

    let body: TypeExpr
    if (this.check(TokenKind.Struct)) {
      body = this.parseStructDef()
    } else if (this.check(TokenKind.Enum)) {
      body = this.parseEnumDef()
    } else {
      const t = this.parseType()
      if (!t) return null
      body = t
    }

    // ⚠️ `type X = ...` 结尾**不能**带 `;`（带了就报 "unexpected token ';' in expression"）
    const endTok = this.cur
    return {
      kind: 'type_decl',
      ...this.spanFrom(startTok, endTok),
      name,
      body,
      typeParams,
    }
  }

  private parseStructDef(): StructDefNode {
    const startTok = this.cur
    this.advance() // 'struct'
    const fields: StructField[] = []
    this.expect(TokenKind.LBrace, '{ in struct definition')
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const nameTok = this.expectIdent('field name')
      if (!nameTok) break
      this.expect(TokenKind.Colon, ':')
      const type = this.parseType()
      if (!type) break
      fields.push({ name: nameTok.text, typeAnnotation: type, start: nameTok.start, end: type.end })
      if (!this.match(TokenKind.Comma)) break
    }
    this.expect(TokenKind.RBrace, '} in struct definition')
    const endTok = this.cur
    return {
      kind: 'struct_def',
      ...this.spanFrom(startTok, endTok),
      fields,
    }
  }

  private parseEnumDef(): EnumDefNode {
    const startTok = this.cur
    this.advance() // 'enum'
    const variants: EnumVariantDecl[] = []
    this.expect(TokenKind.LBrace, '{ in enum definition')
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const nameTok = this.expectIdent('variant name')
      if (!nameTok) break
      let payloadType: TypeExpr | null = null
      if (this.check(TokenKind.LParen)) {
        this.advance()
        payloadType = this.parseType()
        this.expect(TokenKind.RParen, ') after variant payload type')
      }
      variants.push({
        name: nameTok.text,
        payloadType,
        start: nameTok.start,
        end: this.cur.start + this.cur.length,
      })
      if (!this.match(TokenKind.Comma)) break
    }
    this.expect(TokenKind.RBrace, '} in enum definition')
    const endTok = this.cur
    return {
      kind: 'enum_def',
      ...this.spanFrom(startTok, endTok),
      variants,
    }
  }

  private parseExternDecl(): Decl | null {
    const startTok = this.cur
    this.advance() // 'extern'
    if (!this.expect(TokenKind.Fn, 'fn after extern')) return null

    const nameTok = this.expectIdent('function name')
    const name = nameTok?.text ?? ''
    const params = this.parseParamList()
    let returnType: TypeExpr | null = null
    if (this.match(TokenKind.Arrow)) {
      returnType = this.parseType()
    }
    this.expect(TokenKind.Semicolon, '; after extern declaration')

    const endTok = this.cur
    return {
      kind: 'extern_decl',
      ...this.spanFrom(startTok, endTok),
      name,
      params,
      returnType,
    }
  }

  private parseImportDecl(): Decl | null {
    const startTok = this.cur
    this.advance() // 'import'
    // ⚠️ 模块名是**裸标识符** —— `import std::vec;` 是解析错误
    const nameTok = this.expectIdent('module name')
    this.expect(TokenKind.Semicolon, '; after import')

    const endTok = this.cur
    return {
      kind: 'import_decl',
      ...this.spanFrom(startTok, endTok),
      name: nameTok?.text ?? '',
    }
  }

  private parseConstDecl(): Decl | null {
    const startTok = this.cur
    this.advance() // 'const'
    const nameTok = this.expectIdent('constant name')
    const name = nameTok?.text ?? ''
    let typeAnnotation: TypeExpr | null = null
    if (this.match(TokenKind.Colon)) {
      typeAnnotation = this.parseType()
    }
    this.expect(TokenKind.Eq, '=')
    const init = this.parseExpr(PREC_NONE)
    if (!init) return null
    this.expect(TokenKind.Semicolon, '; after const declaration')

    const endTok = this.cur
    return {
      kind: 'const_decl',
      ...this.spanFrom(startTok, endTok),
      name,
      typeAnnotation,
      init,
    }
  }

  // ── 语句 ────────────────────────────────────────────────────────

  private parseStmt(): Stmt | null {
    switch (this.cur.kind) {
      case TokenKind.Let:
        return this.parseLet()
      case TokenKind.If:
        return this.parseIf()
      case TokenKind.While:
        return this.parseWhile()
      case TokenKind.For:
        return this.parseFor()
      case TokenKind.Match:
        return this.parseMatch()
      case TokenKind.Return:
        return this.parseReturn()
      case TokenKind.Break:
        return this.parseBreak()
      case TokenKind.Continue:
        return this.parseContinue()
      case TokenKind.Defer:
        return this.parseDefer()
      default:
        return this.parseExprStmt()
    }
  }

  private parseLet(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'let'
    const isMutable = this.match(TokenKind.Mut)
    const nameTok = this.expectIdent('variable name')
    let typeAnnotation: TypeExpr | null = null
    if (this.match(TokenKind.Colon)) {
      typeAnnotation = this.parseType()
    }
    this.expect(TokenKind.Eq, '=')
    const init = this.parseExpr(PREC_NONE)
    this.expect(TokenKind.Semicolon, ';')

    const endTok = this.cur
    return {
      kind: 'let',
      ...this.spanFrom(startTok, endTok),
      isMutable,
      name: nameTok?.text ?? '',
      typeAnnotation,
      init,
    }
  }

  private parseReturn(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'return'
    // `return` 后面跟表达式时，表达式不能跨 `}`（编译器用 peek 判断）
    let expr: Expr | null = null
    if (!this.check(TokenKind.Semicolon) && !this.check(TokenKind.RBrace)) {
      expr = this.parseExpr(PREC_NONE)
    }
    this.expect(TokenKind.Semicolon, ';')

    const endTok = this.cur
    return { kind: 'return', ...this.spanFrom(startTok, endTok), expr }
  }

  private parseBreak(): Stmt | null {
    const startTok = this.cur
    this.advance()
    this.expect(TokenKind.Semicolon, ';')
    const endTok = this.cur
    return { kind: 'break', ...this.spanFrom(startTok, endTok) }
  }

  private parseContinue(): Stmt | null {
    const startTok = this.cur
    this.advance()
    this.expect(TokenKind.Semicolon, ';')
    const endTok = this.cur
    return { kind: 'continue', ...this.spanFrom(startTok, endTok) }
  }

  private parseDefer(): Stmt | null {
    const startTok = this.cur
    this.advance()
    const expr = this.parseExpr(PREC_NONE)
    if (this.check(TokenKind.RBrace)) {
      // 函数体末尾可以省分号
    } else {
      this.expect(TokenKind.Semicolon, ';')
    }
    const endTok = this.cur
    if (!expr) return null
    return { kind: 'defer', ...this.spanFrom(startTok, endTok), expr }
  }

  private parseExprStmt(): Stmt | null {
    const expr = this.parseExpr(PREC_NONE)
    if (!expr) return null
    // `;` 可省略（`}` / EOF 之前）
    if (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      this.expect(TokenKind.Semicolon, ';')
    }
    const endTok = this.cur
    return { kind: 'expr_stmt', ...this.spanFrom(startTokOf(expr), endTok), expr }
  }

  private parseBlock(): BlockNode {
    const startTok = this.cur
    this.expect(TokenKind.LBrace, '{')
    const statements: Stmt[] = []
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const before = this.cur.start
      const stmt = this.parseStmt()
      if (stmt) statements.push(stmt)
      if (this.cur.start === before) this.advance()
    }
    this.expect(TokenKind.RBrace, '}')
    const endTok = this.cur
    return { kind: 'block', ...this.spanFrom(startTok, endTok), statements }
  }

  private parseIf(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'if'
    const cond = this.parseExpr(PREC_NONE)
    if (!cond) return null

    // ⚠️ parseBlock 自己会消费 `{` —— 这里**不能**再 expect 一次
    const thenBody = this.parseBlock()

    let elseBody: BlockNode | Extract<Stmt, { kind: 'if' }> | null = null
    if (this.match(TokenKind.Else)) {
      if (this.check(TokenKind.If)) {
        elseBody = this.parseIf() as Extract<Stmt, { kind: 'if' }> | null
      } else {
        // ⚠️ parseBlock 自己会消费 `{`
        elseBody = this.parseBlock()
      }
    }

    const endTok = this.cur
    return { kind: 'if', ...this.spanFrom(startTok, endTok), cond, thenBody, elseBody }
  }

  private parseWhile(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'while'
    const cond = this.parseExpr(PREC_NONE)
    if (!cond) return null
    // ⚠️ parseBlock 自己会消费 `{`
    const body = this.parseBlock()
    const endTok = this.cur
    return { kind: 'while', ...this.spanFrom(startTok, endTok), cond, body }
  }

  private parseFor(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'for'
    const varTok = this.expectIdent('loop variable')
    this.expect(TokenKind.In, 'in')
    const first = this.parseExpr(PREC_NONE)
    if (!first) return null

    // 区间形式 `for x in a..b` 还是切片形式 `for x in slice`
    let end: Expr | null = null
    let isSlice = false
    if (this.match(TokenKind.DotDot)) {
      end = this.parseExpr(PREC_NONE)
    } else {
      isSlice = true
    }

    // ⚠️ parseBlock 自己会消费 `{`
    const body = this.parseBlock()

    const endTok = this.cur
    return {
      kind: 'for',
      ...this.spanFrom(startTok, endTok),
      varName: varTok?.text ?? '',
      rangeStart: first,
      rangeEnd: end,
      isSlice,
      body,
    }
  }

  private parseMatch(): Stmt | null {
    const startTok = this.cur
    this.advance() // 'match'
    const subject = this.parseExpr(PREC_NONE)
    if (!subject) return null
    this.expect(TokenKind.LBrace, '{ after match subject')

    const arms: MatchArm[] = []
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const before = this.cur.start
      const armStart = this.cur
      let pattern = this.parsePattern()
      // OR pattern：`pat1 | pat2`
      while (pattern && this.check(TokenKind.Pipe)) {
        this.advance()
        const right = this.parsePattern()
        if (!right) break
        pattern = {
          kind: 'pattern_or',
          ...this.spanFrom(armStart, right),
          left: pattern,
          right,
        }
      }
      if (!pattern) {
        if (this.cur.start === before) this.advance()
        continue
      }
      this.expect(TokenKind.FatArrow, '=>')
      const body = this.parseExpr(PREC_NONE)
      if (!body) {
        if (this.cur.start === before) this.advance()
        continue
      }
      arms.push({ pattern, body, start: armStart.start, end: body.end })
      this.match(TokenKind.Comma)
      if (this.cur.start === before) this.advance()
    }

    this.expect(TokenKind.RBrace, '}')
    const endTok = this.cur
    return { kind: 'match', ...this.spanFrom(startTok, endTok), subject, arms }
  }

  // ── 模式 ────────────────────────────────────────────────────────

  private parsePattern(): Pattern | null {
    const startTok = this.cur

    // `_` 通配符
    if (this.check(TokenKind.Ident) && this.cur.text === '_') {
      this.advance()
      return { kind: 'pattern_wild', ...this.spanFrom(startTok, this.cur) }
    }

    // ── IDENT 分支 ──
    if (this.check(TokenKind.Ident)) {
      this.advance()
      const name = startTok.text

      // `Type::Variant(binding)`
      if (this.match(TokenKind.ColonColon)) {
        const variantTok = this.expectIdent('variant name')
        let inner: Pattern | null = null
        if (this.match(TokenKind.LParen)) {
          inner = this.parsePattern()
          this.expect(TokenKind.RParen, ') after enum pattern')
        }
        return {
          kind: 'pattern_enum',
          ...this.spanFrom(startTok, this.cur),
          typeName: name,
          variantName: variantTok?.text ?? '',
          inner,
        }
      }

      // `x..y` —— lo 是绑定标识符
      if (this.match(TokenKind.DotDot)) {
        const hi = this.parsePatternPrimary()
        if (!hi) return null
        const lo: Pattern = {
          kind: 'pattern_ident',
          ...this.spanFrom(startTok, startTok),
          name,
        }
        return { kind: 'pattern_range', ...this.spanFrom(startTok, hi), lo, hi }
      }

      // 短名变体 `Some(v)` / `None`
      //
      // 编译器靠符号表判断（名字是不是已声明的枚举变体）。IDE 是纯句法的，
      // 用预扫描收集到的**本文件里的变体名**来判断。
      if (this.variantNames.has(name)) {
        let inner: Pattern | null = null
        if (this.match(TokenKind.LParen)) {
          inner = this.parsePattern()
          this.expect(TokenKind.RParen, ') after enum pattern')
        }
        return {
          kind: 'pattern_enum',
          ...this.spanFrom(startTok, this.cur),
          typeName: null,
          variantName: name,
          inner,
        }
      }

      // 普通绑定模式 `x`
      return { kind: 'pattern_ident', ...this.spanFrom(startTok, startTok), name }
    }

    // ── 字面量分支（int / bool / char / -int），都支持 `..hi` 变成区间 ──
    if (
      this.check(TokenKind.Int) ||
      this.check(TokenKind.Bool) ||
      this.check(TokenKind.Char) ||
      this.check(TokenKind.Minus)
    ) {
      const lit = this.parsePatternLiteral()
      if (!lit) return null
      if (this.match(TokenKind.DotDot)) {
        const hi = this.parsePatternPrimary()
        if (!hi) return null
        return { kind: 'pattern_range', ...this.spanFrom(startTok, hi), lo: lit, hi }
      }
      return lit
    }

    // `( pattern )`
    if (this.check(TokenKind.LParen)) {
      this.advance()
      const inner = this.parsePattern()
      this.expect(TokenKind.RParen, ')')
      return inner
    }

    this.error(`unexpected token '${tokenKindName(this.cur.kind)}' in pattern`)
    return null
  }

  /** 模式里的字面量（int / char / bool），带负号。 */
  private parsePatternLiteral(): Pattern | null {
    const startTok = this.cur
    if (this.match(TokenKind.Minus)) {
      const intTok = this.expect(TokenKind.Int, 'integer after - in pattern')
      if (!intTok) return null
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, intTok),
        value: -parseIntLiteral(intTok.text),
        litKind: 'int',
        raw: `-${intTok.text}`,
      }
    }
    if (this.check(TokenKind.Int)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: parseIntLiteral(t.text),
        litKind: 'int',
        raw: t.text,
      }
    }
    if (this.check(TokenKind.Char)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: decodeCharLiteral(t.text),
        litKind: 'char',
        raw: t.text,
      }
    }
    if (this.check(TokenKind.Bool)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: t.text === 'true',
        litKind: 'bool',
        raw: t.text,
      }
    }
    return null
  }

  /** 区间的上界（也可能是标识符绑定）。 */
  private parsePatternPrimary(): Pattern | null {
    const startTok = this.cur
    if (this.match(TokenKind.Minus)) {
      const intTok = this.expect(TokenKind.Int, 'integer after - in pattern')
      if (!intTok) return null
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, intTok),
        value: -parseIntLiteral(intTok.text),
        litKind: 'int',
        raw: `-${intTok.text}`,
      }
    }
    if (this.check(TokenKind.Int)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: parseIntLiteral(t.text),
        litKind: 'int',
        raw: t.text,
      }
    }
    if (this.check(TokenKind.Char)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: decodeCharLiteral(t.text),
        litKind: 'char',
        raw: t.text,
      }
    }
    if (this.check(TokenKind.Bool)) {
      const t = this.advance()
      return {
        kind: 'pattern_lit',
        ...this.spanFrom(startTok, t),
        value: t.text === 'true',
        litKind: 'bool',
        raw: t.text,
      }
    }
    if (this.check(TokenKind.Ident)) {
      const t = this.advance()
      return { kind: 'pattern_ident', ...this.spanFrom(startTok, t), name: t.text }
    }
    if (this.check(TokenKind.LParen)) {
      this.advance()
      const inner = this.parsePatternPrimary()
      this.expect(TokenKind.RParen, ')')
      return inner
    }
    this.error(`unexpected token '${tokenKindName(this.cur.kind)}' in pattern`)
    return null
  }

  // ── 类型 ────────────────────────────────────────────────────────

  private parseType(): TypeExpr | null {
    const startTok = this.cur

    // `&&T` —— 借用是 terminal，明确报错
    if (this.check(TokenKind.AmpAmp)) {
      this.advance()
      this.error('chained `&&T` not allowed (borrow is terminal — use one `&` per level)')
      this.advance()
      return null
    }

    // `&T` / `&mut T`
    if (this.check(TokenKind.Amp)) {
      this.advance()
      const isMutable = this.match(TokenKind.Mut)
      if (this.check(TokenKind.Amp)) {
        this.error('chained `&` is not allowed (borrow type is terminal — use one `&` per level)')
        this.advance()
        return null
      }
      const inner = this.parseType()
      if (!inner) return null
      const endTok = this.cur
      return { kind: 'ref_type', ...this.spanFrom(startTok, endTok), inner, isMutable }
    }

    // `*T` —— 指针类型。编译器用 NODE_UNARY 表示（跟表达式位置的解引用区分）
    if (this.match(TokenKind.Star)) {
      const inner = this.parseType()
      if (!inner) return null
      const endTok = this.cur
      return { kind: 'unary', ...this.spanFrom(startTok, endTok), op: '*', expr: inner }
    }

    // `[*]T`（切片）或 `[T; N]`（数组）
    if (this.match(TokenKind.LBracket)) {
      if (this.match(TokenKind.Star)) {
        this.expect(TokenKind.RBracket, '] after [*')
        const elem = this.parseType()
        if (!elem) return null
        const endTok = this.cur
        return { kind: 'slice_type', ...this.spanFrom(startTok, endTok), elemType: elem }
      }
      const base = this.parseType()
      if (!base) return null
      this.expect(TokenKind.Semicolon, '; in array type')
      const countTok = this.expect(TokenKind.Int, 'array size')
      const count: Expr | null = countTok
        ? {
            kind: 'int',
            start: countTok.start,
            end: countTok.start + countTok.length,
            line: countTok.line,
            col: countTok.col,
            value: parseIntLiteral(countTok.text),
            raw: countTok.text,
          }
        : null
      this.expect(TokenKind.RBracket, '] in array type')
      const endTok = this.cur
      return { kind: 'array_type', ...this.spanFrom(startTok, endTok), elemType: base, count }
    }

    // `fn(T1, T2) -> Ret` —— 类型位置不接受（编译器只占位）
    if (this.match(TokenKind.Fn)) {
      this.expect(TokenKind.LParen, '( in fn type')
      let depth = 1
      while (depth > 0 && !this.check(TokenKind.Eof)) {
        if (this.check(TokenKind.LParen)) depth++
        if (this.check(TokenKind.RParen)) depth--
        this.advance()
      }
      this.error('function pointer types are not supported in type position')
      return null
    }

    // `volatile T` —— 只允许基础类型
    if (this.check(TokenKind.Volatile)) {
      this.advance()
      if (this.check(TokenKind.Volatile)) {
        this.error('chained `volatile volatile` is not allowed (volatile is primitive-only qualifier)')
        this.advance()
        return null
      }
      const innerTok = this.expectIdent('primitive type after volatile')
      if (!innerTok) return null
      if (!PRIMITIVE_TYPES.has(innerTok.text)) {
        this.error(
          `\`volatile\` requires a primitive type (struct/pointer/array not allowed per spec § 6), got \`${innerTok.text}\``,
          innerTok,
        )
      }
      const inner: TypeExpr = {
        kind: 'ident',
        start: innerTok.start,
        end: innerTok.start + innerTok.length,
        line: innerTok.line,
        col: innerTok.col,
        name: innerTok.text,
      }
      const endTok = this.cur
      return { kind: 'volatile_type', ...this.spanFrom(startTok, endTok), inner }
    }

    // 名字（可能带泛型实参）
    const nameTok = this.expectIdent('type name')
    if (!nameTok) return null
    const name = nameTok.text

    let typeArgs: TypeExpr[] | undefined
    if (this.check(TokenKind.Lt)) {
      typeArgs = this.parseTypeArgs()
    }

    const endTok = this.cur
    const node: TypeExpr = {
      kind: 'ident',
      ...this.spanFrom(nameTok, endTok),
      name,
    }
    if (typeArgs && typeArgs.length > 0) node.typeArgs = typeArgs
    return node
  }

  /** `<T, U>` 泛型实参列表。 */
  private parseTypeArgs(): TypeExpr[] {
    const args: TypeExpr[] = []
    this.advance() // '<'
    while (!this.check(TokenKind.Gt) && !this.check(TokenKind.Eof)) {
      const t = this.parseType()
      if (!t) break
      args.push(t)
      if (!this.match(TokenKind.Comma)) break
    }
    this.expect(TokenKind.Gt, '> after generic args')
    return args
  }

  // ── 表达式（Pratt）──────────────────────────────────────────────

  private parseExpr(minPrec: number): Expr | null {
    const startTok = this.cur
    let left = this.parsePrefix()
    if (!left) return null

    for (;;) {
      const t = this.cur
      // 停止条件
      switch (t.kind) {
        case TokenKind.Eof:
        case TokenKind.Semicolon:
        case TokenKind.RBrace:
        case TokenKind.RParen:
        case TokenKind.RBracket:
        case TokenKind.Comma:
        case TokenKind.Colon:
        case TokenKind.FatArrow:
        case TokenKind.In:
        case TokenKind.Else:
          return left
        default:
          break
      }

      const prec = infixPrecedence(t.kind)
      if (prec === null) return left
      if (prec < minPrec) return left

      left = this.parseInfix(left, prec, startTok)
      if (!left) return null
    }
  }

  private parseInfix(left: Expr, prec: number, startTok: Token): Expr | null {
    const opTok = this.advance()

    switch (opTok.kind) {
      case TokenKind.Eq: {
        const right = this.parseExpr(PREC_NONE)
        if (!right) return left
        return { kind: 'assign', ...this.spanFrom(startTok, right), target: left, value: right }
      }
      case TokenKind.PlusEq:
      case TokenKind.MinusEq:
      case TokenKind.StarEq:
      case TokenKind.SlashEq:
      case TokenKind.PercentEq: {
        // 复合赋值：assign(target, binary(target, op, right))
        const right = this.parseExpr(PREC_NONE)
        if (!right) return left
        const op = compoundOp(opTok.kind)
        const bin: Expr = {
          kind: 'binary',
          ...this.spanFrom(startTok, right),
          op,
          left,
          right,
        }
        return { kind: 'assign', ...this.spanFrom(startTok, right), target: left, value: bin }
      }
      case TokenKind.LParen: {
        const args = this.parseCallArgs()
        return { kind: 'call', ...this.spanFrom(startTok, this.cur), callee: left, args }
      }
      case TokenKind.Dot: {
        const fieldTok = this.expectIdent('field name')
        if (!fieldTok) return left
        return {
          kind: 'field',
          ...this.spanFrom(startTok, fieldTok),
          expr: left,
          field: fieldTok.text,
        }
      }
      case TokenKind.LBracket: {
        const indexExpr = this.parseExpr(PREC_NONE)
        if (!indexExpr) return left
        if (this.match(TokenKind.DotDot)) {
          const end = this.parseExpr(PREC_NONE)
          if (!end) return left
          this.expect(TokenKind.RBracket, ']')
          return {
            kind: 'slice_range',
            ...this.spanFrom(startTok, this.cur),
            base: left,
            rangeStart: indexExpr,
            rangeEnd: end,
          }
        }
        this.expect(TokenKind.RBracket, ']')
        return { kind: 'index', ...this.spanFrom(startTok, this.cur), expr: left, index: indexExpr }
      }
      case TokenKind.As: {
        const target = this.parseType()
        if (!target) return left
        return { kind: 'cast', ...this.spanFrom(startTok, target), expr: left, targetType: target }
      }
      default: {
        const right = this.parseExpr(prec + 1)
        if (!right) return left
        return {
          kind: 'binary',
          ...this.spanFrom(startTok, right),
          op: tokenKindName(opTok.kind),
          left,
          right,
        }
      }
    }
  }

  private parseCallArgs(): Expr[] {
    const args: Expr[] = []
    while (!this.check(TokenKind.RParen) && !this.check(TokenKind.Eof)) {
      const before = this.cur.start
      const arg = this.parseExpr(PREC_NONE)
      if (arg) args.push(arg)
      if (!this.match(TokenKind.Comma)) break
      if (this.cur.start === before) this.advance()
    }
    this.expect(TokenKind.RParen, ')')
    return args
  }

  private parsePrefix(): Expr | null {
    const t = this.cur

    switch (t.kind) {
      case TokenKind.Eof:
        this.error('unexpected end of file in expression')
        return null

      case TokenKind.Int: {
        this.advance()
        return { kind: 'int', ...this.spanFrom(t, t), value: parseIntLiteral(t.text), raw: t.text }
      }
      case TokenKind.Float: {
        this.advance()
        return {
          kind: 'float',
          ...this.spanFrom(t, t),
          value: parseFloatLiteral(t.text),
          raw: t.text,
        }
      }
      case TokenKind.String: {
        this.advance()
        return {
          kind: 'string',
          ...this.spanFrom(t, t),
          value: decodeStringLiteral(t.text),
          raw: t.text,
        }
      }
      case TokenKind.Char: {
        this.advance()
        return { kind: 'char', ...this.spanFrom(t, t), value: decodeCharLiteral(t.text), raw: t.text }
      }
      case TokenKind.Bool: {
        this.advance()
        return { kind: 'bool', ...this.spanFrom(t, t), value: t.text === 'true' }
      }
      case TokenKind.Null: {
        this.advance()
        return { kind: 'null', ...this.spanFrom(t, t) }
      }

      case TokenKind.Ident:
        return this.parseIdentPrefix()

      case TokenKind.Minus:
      case TokenKind.Bang:
      case TokenKind.Tilde: {
        this.advance()
        const expr = this.parseExpr(PREC_UNARY)
        if (!expr) return null
        return {
          kind: 'unary',
          ...this.spanFrom(t, this.cur),
          op: tokenKindName(t.kind),
          expr,
        }
      }

      case TokenKind.Star: {
        // `*p` 解引用
        this.advance()
        const expr = this.parseExpr(PREC_UNARY)
        if (!expr) return null
        return { kind: 'deref', ...this.spanFrom(t, this.cur), expr }
      }

      case TokenKind.Amp: {
        // `&x` 取地址 / `&mut x` / `&[1,2,3]` 切片字面量
        this.advance()
        if (this.check(TokenKind.LBracket)) {
          this.advance()
          const elements: Expr[] = []
          while (!this.check(TokenKind.RBracket) && !this.check(TokenKind.Eof)) {
            const before = this.cur.start
            const elem = this.parseExpr(PREC_NONE)
            if (elem) elements.push(elem)
            if (!this.match(TokenKind.Comma)) break
            if (this.cur.start === before) this.advance()
          }
          this.expect(TokenKind.RBracket, '] in slice literal')
          const arr: Expr = {
            kind: 'array_lit',
            start: t.start + 1,
            end: this.cur.start,
            line: t.line,
            col: t.col,
            elements,
          }
          return { kind: 'slice_lit', ...this.spanFrom(t, this.cur), array: arr }
        }
        const isMutable = this.match(TokenKind.Mut)
        const expr = this.parseExpr(PREC_UNARY)
        if (!expr) return null
        return { kind: 'addr_of', ...this.spanFrom(t, this.cur), expr, isMutable }
      }

      case TokenKind.LParen: {
        // 括号分组 / unit
        this.advance()
        if (this.match(TokenKind.RParen)) {
          return { kind: 'int', ...this.spanFrom(t, this.cur), value: 0n, raw: '0' }
        }
        const expr = this.parseExpr(PREC_NONE)
        this.expect(TokenKind.RParen, ')')
        return expr
      }

      case TokenKind.Sizeof: {
        this.advance()
        this.expect(TokenKind.LParen, '(')
        const target = this.parseType()
        this.expect(TokenKind.RParen, ')')
        if (!target) return null
        return { kind: 'sizeof', ...this.spanFrom(t, this.cur), target }
      }

      case TokenKind.Alignof: {
        this.advance()
        this.expect(TokenKind.LParen, '(')
        const target = this.parseType()
        this.expect(TokenKind.RParen, ')')
        if (!target) return null
        return { kind: 'alignof', ...this.spanFrom(t, this.cur), target }
      }

      case TokenKind.If:
        return this.parseIf() as unknown as Expr

      case TokenKind.Match:
        return this.parseMatch() as unknown as Expr

      case TokenKind.LBracket: {
        // 数组字面量 `[1, 2, 3]`
        this.advance()
        const elements: Expr[] = []
        while (!this.check(TokenKind.RBracket) && !this.check(TokenKind.Eof)) {
          const before = this.cur.start
          const elem = this.parseExpr(PREC_NONE)
          if (elem) elements.push(elem)
          if (!this.match(TokenKind.Comma)) break
          if (this.cur.start === before) this.advance()
        }
        this.expect(TokenKind.RBracket, ']')
        return { kind: 'array_lit', ...this.spanFrom(t, this.cur), elements }
      }

      case TokenKind.Pipe:
        return this.parseClosure()

      default:
        this.error(`unexpected token '${tokenKindName(t.kind)}' in expression`)
        this.advance()
        return null
    }
  }

  /** 标识符开头的前缀表达式。 */
  private parseIdentPrefix(): Expr | null {
    const t = this.advance()
    const name = t.text

    // `asm!(...)`
    if (name === 'asm' && this.check(TokenKind.Bang)) {
      return this.parseAsmBlock(t)
    }

    // `fence_seq_cst()` 等内建
    if (FENCE_BUILTINS.has(name) && this.check(TokenKind.LParen)) {
      this.advance() // '('
      this.expect(TokenKind.RParen, ')')
      return { kind: 'builtin_fence', ...this.spanFrom(t, this.cur), fence: name }
    }

    // turbofish：`f::<i32>(...)`
    if (this.check(TokenKind.ColonColon) && this.peekKind() === TokenKind.Lt) {
      this.advance() // '::'
      this.advance() // '<'
      const typeArgs: TypeExpr[] = []
      while (!this.check(TokenKind.Gt) && !this.check(TokenKind.Eof)) {
        const ta = this.parseType()
        if (!ta) break
        typeArgs.push(ta)
        if (!this.match(TokenKind.Comma)) break
      }
      this.expect(TokenKind.Gt, '> after turbofish args')
      let args: Expr[] = []
      if (this.check(TokenKind.LParen)) {
        this.advance()
        args = this.parseCallArgs()
      }
      return {
        kind: 'call',
        ...this.spanFrom(t, this.cur),
        callee: { kind: 'ident', ...this.spanFrom(t, t), name },
        args,
        typeArgs,
      }
    }

    // 结构体字面量 `Point { x: 1 }`
    //
    // ⚠️ 编译器靠符号表判断 `IDENT {` 是不是结构体字面量（只有 SYM_TYPE 才行）。
    // IDE 是纯句法的，用两条规则：
    //   1. 名字**首字母大写**（语言约定类型名大写；跟编译器判泛型实例同一条规则）
    //   2. 或者这个名字在本文件里被 `type X = ...` 声明过（预扫描收集）
    // 否则 `match c {` / `while i < n {` 里的 `c {` 会被误当成结构体字面量。
    if (this.check(TokenKind.LBrace) && this.looksLikeTypeName(name)) {
      const fields = this.parseStructLitFields()
      return { kind: 'struct_lit', ...this.spanFrom(t, this.cur), typeName: name, fields }
    }

    // 限定路径 `mod::fn(...)` 或 `Enum::Variant`
    //
    // ⚠️ 编译器靠符号表区分这两者（模块 vs 类型）。IDE 是纯句法的，用
    // **首字母大写**这条规则（跟编译器判泛型实例用的是同一条规则）：
    // 大写 → 枚举变体；小写 → 限定调用。
    if (this.check(TokenKind.ColonColon)) {
      this.advance() // '::'
      const memberTok = this.expectIdent('name after ::')
      const member = memberTok?.text ?? ''

      if (/^[A-Z]/.test(name)) {
        // `Enum::Variant` 或 `Enum::Variant(payload)`
        let payload: Expr | null = null
        if (this.check(TokenKind.LParen)) {
          this.advance()
          payload = this.parseExpr(PREC_NONE)
          this.expect(TokenKind.RParen, ')')
        }
        return {
          kind: 'enum_variant',
          ...this.spanFrom(t, this.cur),
          typeName: name,
          variantName: member,
          payload,
        }
      }

      // `mod::fn(args)`
      this.expect(TokenKind.LParen, '(')
      const args = this.parseCallArgs()
      return {
        kind: 'qualified_call',
        ...this.spanFrom(t, this.cur),
        module: name,
        function: member,
        args,
      }
    }

    // 泛型实参 `Vec<i32> { ... }` / `Option<i32>::Some(x)`（大写开头才当泛型，
    // 跟编译器同一条句法规则）
    if (this.check(TokenKind.Lt) && /^[A-Z]/.test(name)) {
      this.advance() // '<'
      const typeArgs: TypeExpr[] = []
      while (!this.check(TokenKind.Gt) && !this.check(TokenKind.Eof)) {
        const ta = this.parseType()
        if (!ta) break
        typeArgs.push(ta)
        if (!this.match(TokenKind.Comma)) break
      }
      this.expect(TokenKind.Gt, '> after generic args')

      // `Pair<i32> { a: 1 }` —— 带泛型实参的结构体字面量
      if (this.check(TokenKind.LBrace)) {
        const fields = this.parseStructLitFields()
        return {
          kind: 'struct_lit',
          ...this.spanFrom(t, this.cur),
          typeName: name,
          typeArgs,
          fields,
        }
      }

      // `Option<i32>::Some(x)` —— 带泛型实参的枚举变体
      if (this.check(TokenKind.ColonColon)) {
        this.advance() // '::'
        const variantTok = this.expectIdent('variant name')
        let payload: Expr | null = null
        if (this.check(TokenKind.LParen)) {
          this.advance()
          payload = this.parseExpr(PREC_NONE)
          this.expect(TokenKind.RParen, ')')
        }
        return {
          kind: 'enum_variant',
          ...this.spanFrom(t, this.cur),
          typeName: name,
          typeArgs,
          variantName: variantTok?.text ?? '',
          payload,
        }
      }

      return { kind: 'ident', ...this.spanFrom(t, this.cur), name, typeArgs }
    }

    return { kind: 'ident', ...this.spanFrom(t, t), name }
  }

  private parseStructLitFields(): FieldInit[] {
    this.advance() // '{'
    const fields: FieldInit[] = []
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.Eof)) {
      const before = this.cur.start
      const nameTok = this.expectIdent('field name')
      if (!nameTok) break
      this.expect(TokenKind.Colon, ':')
      const value = this.parseExpr(PREC_NONE)
      if (!value) break
      fields.push({ name: nameTok.text, value, start: nameTok.start, end: value.end })
      if (!this.match(TokenKind.Comma)) break
      if (this.cur.start === before) this.advance()
    }
    this.expect(TokenKind.RBrace, '}')
    return fields
  }

  private parseAsmBlock(identTok: Token): Expr {
    this.advance() // '!'
    this.expect(TokenKind.LParen, '( in asm!')
    // ⚠️ `asm!(...)` 只支持单个字符串字面量 —— 但那是 **sema** 层的检查，
    // 解析层不报（编译器也是 parse 过、sema 才拒）。这里照做，别越权报错。
    const strTok = this.expect(TokenKind.String, 'string literal in asm!')
    this.expect(TokenKind.RParen, ') in asm!')
    return {
      kind: 'asm_block',
      ...this.spanFrom(identTok, this.cur),
      text: strTok ? strTok.text.slice(1, -1) : '',
    }
  }

  /** 闭包 `|x: i32| { expr }`。 */
  private parseClosure(): Expr | null {
    const t = this.advance() // '|'
    const params: FuncParam[] = []
    while (!this.check(TokenKind.Pipe) && !this.check(TokenKind.Eof)) {
      const nameTok = this.expectIdent('closure parameter name')
      if (!nameTok) break
      this.expect(TokenKind.Colon, ':')
      const type = this.parseType()
      if (!type) break
      params.push({ name: nameTok.text, typeAnnotation: type, start: nameTok.start, end: type.end })
      if (!this.match(TokenKind.Comma)) break
    }
    this.expect(TokenKind.Pipe, '|')

    this.expect(TokenKind.LBrace, '{ in closure body')
    const body = this.parseExpr(PREC_NONE)
    this.expect(TokenKind.RBrace, '} in closure body')
    if (!body) return null
    return { kind: 'closure_literal', ...this.spanFrom(t, this.cur), params, body }
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function startTokOf(node: { start: number; line: number; col: number }): Token {
  return {
    kind: TokenKind.Ident,
    start: node.start,
    length: 0,
    line: node.line,
    col: node.col,
    text: '',
  }
}

function infixPrecedence(kind: TokenKind): number | null {
  switch (kind) {
    case TokenKind.Eq:
    case TokenKind.PlusEq:
    case TokenKind.MinusEq:
    case TokenKind.StarEq:
    case TokenKind.SlashEq:
    case TokenKind.PercentEq:
      return PREC_ASSIGN
    case TokenKind.PipePipe:
      return PREC_OR
    case TokenKind.AmpAmp:
      return PREC_AND
    case TokenKind.EqEq:
    case TokenKind.BangEq:
    case TokenKind.Lt:
    case TokenKind.Gt:
    case TokenKind.LtEq:
    case TokenKind.GtEq:
      return PREC_COMPARE
    case TokenKind.Pipe:
      return PREC_BIT_OR
    case TokenKind.Caret:
      return PREC_BIT_XOR
    case TokenKind.Amp:
      return PREC_BIT_AND
    case TokenKind.LtLt:
    case TokenKind.GtGt:
      return PREC_SHIFT
    case TokenKind.Plus:
    case TokenKind.Minus:
      return PREC_TERM
    case TokenKind.Star:
    case TokenKind.Slash:
    case TokenKind.Percent:
      return PREC_FACTOR
    case TokenKind.LParen:
    case TokenKind.Dot:
    case TokenKind.LBracket:
      return PREC_PRIMARY
    case TokenKind.As:
      return PREC_FACTOR
    default:
      return null
  }
}

function compoundOp(kind: TokenKind): string {
  switch (kind) {
    case TokenKind.PlusEq:
      return '+'
    case TokenKind.MinusEq:
      return '-'
    case TokenKind.StarEq:
      return '*'
    case TokenKind.SlashEq:
      return '/'
    case TokenKind.PercentEq:
      return '%'
    default:
      return '?'
  }
}

/**
 * 整数字面量 —— 对齐编译器 `parse_int_literal`（C 的 strtoll base=0 语义：
 * `0x` 十六进制、`0o`/`0` 前缀八进制、`0b` 二进制，其余十进制）。
 */
export function parseIntLiteral(text: string): bigint {
  const t = text.trim()
  // 去掉类型后缀（i8..u64）
  const suffixMatch = /[iu](8|16|32|64)$/.exec(t)
  const body = suffixMatch ? t.slice(0, suffixMatch.index) : t
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(body)) return BigInt(body)
    if (/^0[oO][0-7]+$/.test(body)) return BigInt(body)
    if (/^0[bB][01]+$/.test(body)) return BigInt(body)
    if (/^0[0-7]+$/.test(body)) return BigInt(`0o${body.slice(1)}`)
    return BigInt(body)
  } catch {
    return 0n
  }
}

/** 浮点字面量 —— 只有 `N.M` 形式（语言没有指数形式）。 */
export function parseFloatLiteral(text: string): number {
  const suffixMatch = /f(32|64)?$/.exec(text)
  const body = suffixMatch ? text.slice(0, suffixMatch.index) : text
  const v = Number.parseFloat(body)
  return Number.isNaN(v) ? 0 : v
}

/** 字符串字面量解码（去掉两端引号，处理转义）。 */
export function decodeStringLiteral(raw: string): string {
  const body = raw.length >= 2 ? raw.slice(1, -1) : raw
  return decodeEscapes(body)
}

/** 字符字面量解码 → Unicode 码点。 */
export function decodeCharLiteral(raw: string): number {
  const body = raw.length >= 2 ? raw.slice(1, -1) : raw
  const decoded = decodeEscapes(body)
  const cp = decoded.codePointAt(0)
  return cp ?? 0
}

function decodeEscapes(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const e = body[i + 1]
    i++
    switch (e) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '0':
        out += '\0'
        break
      case '\\':
        out += '\\'
        break
      case '"':
        out += '"'
        break
      case "'":
        out += "'"
        break
      case 'x': {
        const hex = body.slice(i + 1, i + 3)
        const code = Number.parseInt(hex, 16)
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code)
          i += 2
        } else {
          out += '\\x'
        }
        break
      }
      default:
        // 未知转义：反斜杠被丢掉（跟编译器一致）
        out += e ?? ''
        break
    }
  }
  return out
}




/**
 * 预扫描：收集本文件里 `type X = ...` 声明过的类型名和枚举变体名。
 *
 * 编译器靠符号表判断两件事：
 * 1. `IDENT {` 是不是结构体字面量（只有 SYM_TYPE 才行）
 * 2. 模式里的裸标识符是枚举变体（`None`）还是绑定（`x`）
 *
 * IDE 是纯句法的，需要这两份名单才能做出同样的判断。
 */
function collectDeclaredNames(source: string): { types: Set<string>; variants: Set<string> } {
  const types = new Set<string>()
  const variants = new Set<string>()
  const tokens = tokenize(source)

  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].kind === TokenKind.Type &&
      tokens[i + 1].kind === TokenKind.Ident &&
      tokens[i + 2].kind === TokenKind.Eq
    ) {
      types.add(tokens[i + 1].text)
    }
  }

  // `type X = enum { A, B(T), C }` —— 收集变体名
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== TokenKind.Enum) continue
    // 找 enum 后面的 `{`
    let j = i + 1
    while (j < tokens.length && tokens[j].kind !== TokenKind.LBrace) {
      if (tokens[j].kind === TokenKind.Eof) break
      j++
    }
    if (j >= tokens.length || tokens[j].kind !== TokenKind.LBrace) continue
    j++
    // 变体之间用逗号分隔；有载荷的是 `Name(T)`
    while (j < tokens.length && tokens[j].kind !== TokenKind.RBrace) {
      if (tokens[j].kind === TokenKind.Ident) {
        variants.add(tokens[j].text)
        j++
        if (j < tokens.length && tokens[j].kind === TokenKind.LParen) {
          // 跳过载荷类型
          let depth = 1
          j++
          while (j < tokens.length && depth > 0) {
            if (tokens[j].kind === TokenKind.LParen) depth++
            if (tokens[j].kind === TokenKind.RParen) depth--
            j++
          }
        }
        continue
      }
      if (tokens[j].kind === TokenKind.Eof) break
      j++
    }
  }

  return { types, variants }
}

/** 解析一份 JHYY 源码。 */
export function parse(source: string): ParseResult {
  const { types, variants } = collectDeclaredNames(source)
  const parser = new Parser(source, types, variants)
  const module = parser.parseModule()
  return { module, errors: parser.errors }
}
