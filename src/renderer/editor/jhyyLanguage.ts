import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { KEYWORD_LIST } from '@lang/token'

/**
 * JHYY 的 CodeMirror 6 语言模式。
 *
 * ⚠️ 为什么用 StreamLanguage 而不是 TextMate 语法（`vscode-ext/syntaxes/
 * jhyy.tmLanguage.json`）：
 * - npm 上没有现成的 "TextMate → CodeMirror 6" 桥接包（`@codemirror/lang-textmate`
 *   不存在，`@replit/codemirror-lang-textmate` 也不在 registry 上）
 * - TextMate 那份语法本身**跟真实语言对不上**：缺 `defer` / `break` / `continue` /
 *   `const` / `null` / `volatile` / `asm` 关键字，缺 `::` 运算符，字符字面量规则
 *   不匹配转义，数字规则允许 `_` 分隔（而语言里 `1_000_000` 是解析错误）
 *
 * 所以这里直接按语言真实规则写 —— 覆盖更全，也不用多一个依赖。
 */

/** 语言内建的基础类型名 —— 高亮成类型色。 */
const TYPE_NAMES = new Set([
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
  'Cap',
  'PhantomData',
])

const KEYWORDS = new Set(KEYWORD_LIST)

/**
 * 运算符 —— **长的排前面**，否则 `<<` 会被 `<` 抢先匹配。
 */
const OPERATORS = [
  '::',
  '->',
  '=>',
  '..',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '&',
  '|',
  '^',
  '~',
]

interface JhyyState {
  /** 处在跨行的块注释里 */
  inBlockComment: boolean
  /** 在字符串/字符字面量里（记着引号是哪个） */
  inString: '' | '"' | "'"
}

/*
  ⚠️ **字符类判断全是手写的，不用正则** ——
  `@codemirror/streamparser` 的 `match(正则)` 会把「这一行从当前位置往后」
  **切一份新的字符串出来**（`this.string.slice(this.pos).match(pattern)`）⇒
  ⇒ 一行里有 N 个 token 就要切 N 次 ⇒ **O(行长²)** ✗
  ⇒ ⇒ 一行 10000 字符（CodeMirror 自己的行长上限）能切出几千万次字符 ⇒ 卡 ✗
  ⇒ ⇒ 下面这几个函数只读 `charCodeAt` / `charAt` ⇒ **O(1)，零分配** ✓
*/

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isHexDigit(c: string | undefined): boolean {
  return (
    isDigit(c) || (c !== undefined && ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')))
  )
}

function isIdentStart(c: string | undefined): boolean {
  return (
    c !== undefined &&
    ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_')
  )
}

function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c)
}

/** `[from, to)` 这段是不是全是十六进制数字（`\u{1F600}` 的那部分）。 */
function isHex(s: string, from: number, to: number): boolean {
  if (from >= to) return false
  for (let i = from; i < to; i++) {
    if (!isHexDigit(s.charAt(i))) return false
  }
  return true
}

const jhyyParser: StreamParser<JhyyState> = {
  name: 'jhyy',

  startState(): JhyyState {
    return { inBlockComment: false, inString: '' }
  },

  token(stream, state): string | null {
    // 上一行留了个没闭合的块注释
    if (state.inBlockComment) {
      if (!stream.match('*/')) {
        stream.skipToEnd()
        return 'comment'
      }
      state.inBlockComment = false
    }

    /*
      字符串 / 字符字面量 —— **逐段吐**，好让转义序列单独一个 token。

      ⚠️ 用户提的：「换行 \n 这种还没有特殊颜色」。
      以前整个字符串是一个 token ⇒ `\n` 跟普通文字一个颜色 ✗。
      现在：转义序列（`\n` `\t` `\\` `\u{...}` …）单独标成 `escape` ✓。
    */
    if (state.inString) {
      const quote = state.inString
      /*
        ⚠️⚠️ **这里原来是一行 `stream.match(/…/)` —— 现在改成手写扫描** ——
        `@codemirror/streamparser` 的 `match(正则)` 是
        `this.string.slice(this.pos).match(pattern)` ⇒
        **每次匹配都要把「这一行的剩余部分」切一份出来** ⇒
        ⇒ 而这行正则**每个字符都要跑一次**（字符串字面量里）⇒
        ⇒ 一个 5000 字符的字符串字面量 ⇒ 5000 次切片 ⇒ **O(行长²)** ✗✗

        ⇒ 现在一次扫到「下一个 `\` 或结束引号」⇒ **O(行长)** ✓
        （token 的颜色不变 —— 普通文字还是 `string`，转义还是 `escape`；
          CodeMirror 会把相邻的同色 token 合并 ⇒ 渲染结果一模一样 ✓）
      */
      const s = stream.string
      const p = stream.pos
      if (s.charAt(p) === '\\') {
        // 转义序列：`\u{1F600}` 整段算一个；`\n` 两个字符算一个
        if (s.charAt(p + 1) === 'u' && s.charAt(p + 2) === '{') {
          const close = s.indexOf('}', p + 3)
          if (close > 0 && isHex(s, p + 3, close)) {
            stream.pos = close + 1
            return 'escape'
          }
        }
        if (p + 1 < s.length) {
          stream.pos = p + 2
          return 'escape'
        }
        // 行尾一个孤零零的 `\` —— 没有可转义的字符 ⇒ 当普通文字
        stream.pos = p + 1
        return 'string'
      }
      // 扫到结束引号或者下一个反斜杠
      let i = p
      while (i < s.length && s.charAt(i) !== '\\' && s.charAt(i) !== quote) i++
      if (i > p) {
        stream.pos = i
        return 'string'
      }
      // 到了结束引号
      stream.pos = p + 1
      state.inString = ''
      return 'string'
    }

    if (stream.eatSpace()) return null

    // 注释
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      if (!stream.match('*/')) {
        stream.skipToEnd()
        state.inBlockComment = true
      }
      return 'comment'
    }

    // 字符串 / 字符字面量的开头
    const quote = stream.peek()
    if (quote === '"' || quote === "'") {
      stream.next()
      state.inString = quote
      return 'string'
    }

    // 数字
    //
    // ⚠️ **手写扫描，不用正则** —— 理由跟上面字符串那句一样：
    // `stream.match(/正则/)` 会把「这一行从当前位置往后」切一份出来 ⇒
    // 一行里有 N 个数字就要切 N 次 ⇒ **O(行长²)** ✗
    // （`@codemirror/streamparser` 的 `match`：`this.string.slice(this.pos).match(pattern)`）
    {
      const c0 = stream.peek()
      if (isDigit(c0)) {
        const s = stream.string
        const i = stream.pos
        if (c0 === '0' && i + 1 < s.length) {
          const c1 = s.charAt(i + 1)
          // 0x / 0o / 0b —— 后面**必须**有对应的数字，否则退回十进制
          if (c1 === 'x' || c1 === 'X') {
            let j = i + 2
            while (j < s.length && isHexDigit(s.charAt(j))) j++
            if (j > i + 2) {
              stream.pos = j
              return 'number'
            }
          } else if (c1 === 'o' || c1 === 'O') {
            let j = i + 2
            while (j < s.length && s.charAt(j) >= '0' && s.charAt(j) <= '7') j++
            if (j > i + 2) {
              stream.pos = j
              return 'number'
            }
          } else if (c1 === 'b' || c1 === 'B') {
            let j = i + 2
            while (j < s.length && (s.charAt(j) === '0' || s.charAt(j) === '1')) j++
            if (j > i + 2) {
              stream.pos = j
              return 'number'
            }
          }
        }
        // 十进制（可以带小数；小数点后**必须**有数字 —— `123.` 只吃 `123`）
        let j = i
        while (j < s.length && isDigit(s.charAt(j))) j++
        if (
          j < s.length &&
          s.charAt(j) === '.' &&
          j + 1 < s.length &&
          isDigit(s.charAt(j + 1))
        ) {
          j++
          while (j < s.length && isDigit(s.charAt(j))) j++
        }
        stream.pos = j
        return 'number'
      }
    }

    // 标识符 / 关键字
    //
    // ⚠️ **同样手写扫描** —— 标识符是**最高频**的 token ⇒ 用正则的话
    // 一行要切 N 次 ⇒ O(行长²)
    {
      const c0 = stream.peek()
      if (isIdentStart(c0)) {
        const s = stream.string
        let j = stream.pos + 1
        while (j < s.length && isIdentPart(s.charAt(j))) j++
        stream.pos = j
        const word = s.slice(stream.start, j)
        if (word === 'true' || word === 'false') return 'bool'
        if (word === 'null') return 'null'
        if (TYPE_NAMES.has(word)) return 'typeName'
        if (KEYWORDS.has(word)) return 'keyword'
        // 大写开头的名字按类型名处理（语言约定类型名大写）
        const first = word.charCodeAt(0)
        if (first >= 65 && first <= 90) return 'typeName'
        return 'variableName'
      }
    }

    // 运算符
    for (const op of OPERATORS) {
      if (stream.match(op)) return 'operator'
    }

    // 括号 / 标点 / 属性 —— 也是手写比较（正则要切片）
    {
      const c = stream.peek()
      if (
        c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}'
      ) {
        stream.next()
        return 'bracket'
      }
      if (c === '.' || c === ',' || c === ';' || c === ':') {
        stream.next()
        return 'punctuation'
      }
      if (c === '#' && isIdentStart(stream.string.charAt(stream.pos + 1))) {
        stream.pos += 2
        return 'meta'
      }
    }

    stream.next()
    return 'invalid'
  },

  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    /*
      ⚠️ **这里必须是「正则表达式」，不能写 `true`。**
      CodeMirror 的 `indentOnInput()` 扩展是个**事务过滤器**：每次输入都读
      语言数据里的这个字段，然后 `rules.some(r => r.test(lineStart))`。
      写成 `true` ⇒ `true.test` 不是函数 ⇒ **抛 TypeError** ⇒
      整个事务被丢掉 ⇒ **编辑器里的字打不进去**（看着跟只读一模一样）。
      用户报过「编译器又变成只读的了」—— 就是这一行。
      文档原文：*which must hold a regular expression*。

      规则本身：在一行开头打「}」时，把这一行缩进到外层缩进级别
      （跟 CM6 自带的 JavaScript StreamLanguage 一个路子）。
      回车自动缩进是 `insertNewlineAndIndent` 干的，不靠这里。
    */
    indentOnInput: /^\s*\}$/,
    bracketMatching: true,
    wordChars: '_',
  },

  /**
   * token 名字 → 高亮标签。
   * ⚠️ 这里**不能**再套一层语言名 —— StreamParser 的 tokenTable 就是
   * 「token 名字 → Tag」的平表。
   */
  tokenTable: {
    keyword: tags.keyword,
    bool: tags.bool,
    null: tags.null,
    typeName: tags.typeName,
    number: tags.number,
    string: tags.string,
    escape: tags.escape,
    comment: tags.comment,
    operator: tags.operator,
    bracket: tags.bracket,
    punctuation: tags.punctuation,
    variableName: tags.variableName,
    meta: tags.meta,
    invalid: tags.invalid,
  },
}

const jhyyStreamLanguage = StreamLanguage.define(jhyyParser)

export const jhyyLanguage: LanguageSupport = new LanguageSupport(jhyyStreamLanguage)

/** 高亮用的样式（暗色主题）。 */
export const jhyyHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c792ea' },
  { tag: tags.bool, color: '#ff9cac' },
  { tag: tags.null, color: '#ff9cac' },
  { tag: tags.typeName, color: '#ffcb6b' },
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.string, color: '#c3e88d' },
  // 转义序列（`\n` `\t` …）—— 单独一个颜色（用户提的）
  { tag: tags.escape, color: '#ffcb6b' },
  { tag: tags.comment, color: '#5f6b7a', fontStyle: 'italic' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.bracket, color: '#a6accd' },
  { tag: tags.punctuation, color: '#a6accd' },
  { tag: tags.variableName, color: '#d7dce5' },
  { tag: tags.meta, color: '#ffcb6b' },
  { tag: tags.invalid, color: '#ff6b6b' },
])
