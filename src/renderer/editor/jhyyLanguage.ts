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
}

const jhyyParser: StreamParser<JhyyState> = {
  name: 'jhyy',

  startState(): JhyyState {
    return { inBlockComment: false }
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

    // 字符串 / 字符字面量
    const quote = stream.peek()
    if (quote === '"' || quote === "'") {
      stream.next()
      let escaped = false
      while (!stream.eol()) {
        const ch = stream.next()
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === quote) break
      }
      return 'string'
    }

    // 数字
    if (stream.match(/^0[xX][0-9a-fA-F]+/)) return 'number'
    if (stream.match(/^0[oO][0-7]+/)) return 'number'
    if (stream.match(/^0[bB][01]+/)) return 'number'
    if (stream.match(/^[0-9]+\.[0-9]+/)) return 'number'
    if (stream.match(/^[0-9]+/)) return 'number'

    // 标识符 / 关键字
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current()
      if (word === 'true' || word === 'false') return 'bool'
      if (word === 'null') return 'null'
      if (TYPE_NAMES.has(word)) return 'typeName'
      if (KEYWORDS.has(word)) return 'keyword'
      // 大写开头的名字按类型名处理（语言约定类型名大写）
      if (/^[A-Z]/.test(word)) return 'typeName'
      return 'variableName'
    }

    // 运算符
    for (const op of OPERATORS) {
      if (stream.match(op)) return 'operator'
    }

    if (stream.match(/^[()[\]{}]/)) return 'bracket'
    if (stream.match(/^[.,;:]/)) return 'punctuation'
    if (stream.match(/^#[A-Za-z_]/)) return 'meta'

    stream.next()
    return 'invalid'
  },

  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    indentOnInput: true,
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
  { tag: tags.comment, color: '#5f6b7a', fontStyle: 'italic' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.bracket, color: '#a6accd' },
  { tag: tags.punctuation, color: '#a6accd' },
  { tag: tags.variableName, color: '#d7dce5' },
  { tag: tags.meta, color: '#ffcb6b' },
  { tag: tags.invalid, color: '#ff6b6b' },
])
