/**
 * 变异目录 —— 「把一段能编译的 JHYY 代码改坏成一种典型错误」。
 *
 * ## 为什么要有这个
 *
 * 评测要能区分「模型知道这条规则」和「模型不知道」。光看「修好它」不够 ——
 * 判据太软：把出错的行删掉也能编译过。
 *
 * 所以这里的每个变异都满足三条：
 *
 * 1. **对应一条真实的 JHYY 反直觉规则**（`rule` 字段指回规范章节 / 速查表条目）
 * 2. **变异后确实坏掉**（构建时真编译 + 真跑一遍验）
 * 3. **修法唯一** —— 原文件带着 EXPECT 判据，修好后 stdout 必须跟原文件一样
 *    ⇒ 「删代码蒙混」这条路被堵死
 *
 * ## 两种破坏方式
 *
 * - `compile-break` —— 变异后**编译不过**（语法/语义规则用错）
 * - `behavior-break` —— 变异后**还能编译，但行为变了**（语义规则记错：
 *   比如把 match 的闭区间当半开）
 *
 * 后者更贴近「模型会不会写错语义」，也更难靠编译器纠正 ⇒ 更有区分力。
 *
 * ## ⚠️ 选变异的一条硬规矩
 *
 * **别只挑「速查表那 12 条已经说了」的规则** —— 实测踩过：四个变异全在
 * 速查表里 ⇒ 基线臂直接 100% 通过 ⇒ 这把尺子测不出任何东西。
 * ⇒ 变异要覆盖**速查表没覆盖**的规则（速查表覆盖的留一两个当对照）。
 */

/** 变异破坏的方式。 */
export type BreakKind = 'compile-break' | 'behavior-break'

/** 一个变异。 */
export interface Mutation {
  /** 变异 id（评测报告按它分组） */
  id: string
  /** 对应的规则引用 —— 规范章节号或速查表条目名 */
  rule: string
  /** 人读的「错在哪」描述 */
  title: string
  /** 破坏方式 */
  kind: BreakKind
  /** 这个变异对这段源码适不适用 */
  appliesTo(src: string): boolean
  /** 施加变异；不适用的返回 null */
  apply(src: string): string | null
}

/**
 * 找出 `header` 那个大括号的**内容区间**（不含大括号本身）。
 *
 * JHYY 的 enum / match / struct 都是大括号块 ⇒ 用括号配对找边界。
 */
function blockBody(src: string, headerRe: RegExp): { start: number; end: number } | null {
  const m = headerRe.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { start: open + 1, end: i }
    }
  }
  return null
}

/** 找出 `type X = struct {` 那个声明的闭合大括号位置（返回 '}' 的下标）。 */
function structDeclEnd(src: string): number {
  const m = /type\s+\w+\s*=\s*struct\s*\{/.exec(src)
  if (!m) return -1
  const open = src.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ── 速查表**已覆盖**的规则（当对照用） ──────────────────────────

/**
 * 入口函数名写错：`fn main_jhyy(` → `fn main(`。
 *
 * 规则：入口是 `fn main_jhyy() -> i32`，不是 `main`。
 * ⚠️ 这条**在速查表里** ⇒ 基线臂应该 100% 对 ⇒ 当对照，不指望它区分。
 */
const entryName: Mutation = {
  id: 'entry-name',
  rule: '§ 1 程序结构',
  title: '入口函数必须是 fn main_jhyy()，不是 fn main()',
  kind: 'compile-break',
  appliesTo: (src) => src.includes('fn main_jhyy('),
  apply: (src) => src.replace('fn main_jhyy(', 'fn main('),
}

/**
 * 类型别名后面多带一个分号。
 *
 * 规则：`type X = struct { ... }` 结尾**不能**带 `;`。
 */
const typeSemicolon: Mutation = {
  id: 'type-semicolon',
  rule: '§ 2.3 类型别名',
  title: 'type X = struct { ... } 结尾不能带分号',
  kind: 'compile-break',
  appliesTo: (src) => structDeclEnd(src) >= 0,
  apply: (src) => {
    const end = structDeclEnd(src)
    if (end < 0) return null
    return src.slice(0, end + 1) + ';' + src.slice(end + 1)
  },
}

/**
 * import 带上 `std::` 前缀。
 *
 * 规则：`import vec;` —— 模块名**不带** `std::` 前缀（规范 § 13）。
 */
const importStdPrefix: Mutation = {
  id: 'import-std-prefix',
  rule: '§ 13 模块与导入',
  title: 'import 只写模块名本身，不带 std:: 前缀',
  kind: 'compile-break',
  appliesTo: (src) => /^\s*import\s+\w+\s*;/m.test(src),
  apply: (src) => src.replace(/^(\s*import\s+)(\w+)(\s*;)/m, '$1std::$2$3'),
}

/**
 * 整数到浮点的隐式转换（去掉 `as`）。
 *
 * 规则：整数 ↔ 浮点**不能**隐式转换，必须写 `as`（规范 § 4.3）。
 */
const implicitFloatCast: Mutation = {
  id: 'implicit-float-cast',
  rule: '§ 4.3 类型转换',
  title: '整数与浮点之间不能隐式转换，必须写 as',
  kind: 'compile-break',
  appliesTo: (src) => /:\s*f64\s*=\s*[^;]*\bas\s+f64/.test(src),
  apply: (src) => src.replace(/(:\s*f64\s*=\s*[^;]*?)\s+as\s+f64/g, '$1'),
}

// ── 速查表**没覆盖**的规则（这才是有区分力的） ──────────────────

/**
 * 闭包体写成语句块（里面塞 `let`）。
 *
 * 规则：闭包体是**单个表达式**，不是语句块（规范 § 5.7 / 附录 B「已实装但受限」）。
 * ⚠️ 速查表只说了「闭包不能捕获外层变量」，**没提体必须是单个表达式** ⇒
 * 这条对模型是盲区。
 */
const closureBodyStatement: Mutation = {
  id: 'closure-body-statement',
  rule: '§ 5.7 闭包',
  title: '闭包体是单个表达式，不能写成语句块（里面不能有 let）',
  kind: 'compile-break',
  appliesTo: (src) => /\|\s*\w+\s*:\s*[\w<>\[\]]+\s*\|\s*\{/.test(src),
  apply: (src) => {
    // 抓住 `|名字: 类型| { ... }`，在体里插一条 `let` 语句
    return src.replace(
      /(\|\s*(\w+)\s*:\s*([\w<>\[\]]+)\s*\|\s*\{)\s*([^}]*?)(\s*\})/g,
      (_all, head, name, type, body, tail) => `${head} let __v: ${type} = ${name}; ${body}${tail}`,
    )
  },
}

/**
 * match 分支体写成语句块。
 *
 * 规则：match arm 的 body 只能是**单个表达式**，不能是 `{ ... }`（附录 B「未实装」）。
 */
const matchArmBlock: Mutation = {
  id: 'match-arm-block',
  rule: '附录 B 未实装',
  title: 'match 分支的 body 是单个表达式，不能写成 { ... } 语句块',
  kind: 'compile-break',
  appliesTo: (src) => blockBody(src, /\bmatch\b[^{]*\{/) !== null,
  apply: (src) => {
    const blk = blockBody(src, /\bmatch\b[^{]*\{/)
    if (!blk) return null
    const body = src.slice(blk.start, blk.end)
    // 只改「=> 表达式,」这种单行分支
    const patched = body.replace(/=>\s*([^,\n}]+?)\s*,/g, '=> { $1 },')
    if (patched === body) return null
    return src.slice(0, blk.start) + patched + src.slice(blk.end)
  },
}

/**
 * enum 变体带两个 payload。
 *
 * 规则：enum 变体最多只能带**一个** payload（附录 B「已实装但受限」）。
 */
const enumTwoPayloads: Mutation = {
  id: 'enum-two-payloads',
  rule: '附录 B 已实装但受限',
  title: 'enum 变体最多只能带一个 payload',
  kind: 'compile-break',
  appliesTo: (src) => blockBody(src, /type\s+\w+\s*=\s*enum\s*\{/) !== null,
  apply: (src) => {
    const blk = blockBody(src, /type\s+\w+\s*=\s*enum\s*\{/)
    if (!blk) return null
    const body = src.slice(blk.start, blk.end)
    const patched = body.replace(
      /(\w+)\((i8|i16|i32|i64|u8|u16|u32|u64|f32|f64)\)/,
      '$1($2, $2)',
    )
    if (patched === body) return null
    return src.slice(0, blk.start) + patched + src.slice(blk.end)
  },
}

/**
 * match 的区间当半开用。
 *
 * 规则：match 的区间是**闭**区间（`1..10` 含 10），`for` 的区间才是半开（规范 § 5.6）。
 *
 * ⚠️ **这条在速查表里** ⇒ 当对照用。但它是**行为变异**（还能编译、只是边界错了）
 *   —— 比「编译不过」那类更难被发现 ⇒ 是对照组里最有意思的一个。
 */
const matchRangeHalfOpen: Mutation = {
  id: 'match-range-halfopen',
  rule: '§ 5.6 match',
  title: 'match 的区间是闭区间（1..10 含 10），for 的区间才是半开',
  kind: 'behavior-break',
  appliesTo: (src) => blockBody(src, /\bmatch\b[^{]*\{/) !== null,
  apply: (src) => {
    const blk = blockBody(src, /\bmatch\b[^{]*\{/)
    if (!blk) return null
    const body = src.slice(blk.start, blk.end)
    // `A..B` → `A..(B-1)`（B 必须是字面量整数；`..` 两边有空格的不动）
    const patched = body.replace(/(-?\d+)\.\.(\d+)/g, (all, lo: string, hi: string) => {
      if (Number(hi) <= Number(lo)) return all
      return `${lo}..${Number(hi) - 1}`
    })
    if (patched === body) return null
    return src.slice(0, blk.start) + patched + src.slice(blk.end)
  },
}

/** 全部变异。 */
export const MUTATIONS: Mutation[] = [
  // 速查表已覆盖（对照）
  entryName,
  typeSemicolon,
  importStdPrefix,
  implicitFloatCast,
  // 速查表没覆盖（主力）
  closureBodyStatement,
  matchArmBlock,
  enumTwoPayloads,
  // 行为变异
  matchRangeHalfOpen,
]

/** 按 id 查变异。 */
export function mutationById(id: string): Mutation | undefined {
  return MUTATIONS.find((m) => m.id === id)
}
