import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { lintKeymap, linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, Compartment, type Text } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  type Tooltip,
} from '@codemirror/view'
import { KEYWORD_LIST } from '@lang/token'
import { findSpecForWord, formatSectionRef } from '@lang/spec'
import { BUILTINS, STDLIB_MODULES, findStdlibModule } from '@lang/stdlib'
import { jhyyHighlightStyle, jhyyLanguage } from './jhyyLanguage'

/** 主题（暗色）。 */
const theme = EditorView.theme(
  {
    '&': { color: '#d7dce5', backgroundColor: '#101219', height: '100%' },
    '.cm-content': { caretColor: '#00d4aa', fontFamily: 'var(--mono)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#00d4aa' },
    '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      /*
        ⚠️ **必须写 `!important`**，而且**不能**要求 `.cm-focused` ——

        - CodeMirror 自带的 base theme 用的是
          `.cm-editor.dark .cm-selectionBackground`（`#222`）和
          `.cm-editor.dark.cm-focused > … .cm-selectionBackground`（`#233`）——
          两个都是**深蓝灰**，在深色背景上几乎看不见
          （用户报过「同一行内的选区特别不明显」）。
        - 编辑器**没焦点**时压根没有 `.cm-focused` ⇒ 带 `:focus` 的选择器不生效。

        而且 `drawSelection()` 会把**浏览器原生**的选区设成 transparent
        （免得两层叠在一起）⇒ 看得见的选区**只有** CM6 自己画的那一层 ⇒
        这一条的颜色就是全部。
      */
      backgroundColor: 'rgba(0, 212, 170, 0.34) !important',
    },
    '.cm-content ::selection': {
      backgroundColor: 'rgba(0, 212, 170, 0.34)',
    },
    '.cm-gutters': { backgroundColor: '#101219', color: '#5f6b7a', border: 'none' },
    /*
      ⚠️ **当前行的高亮必须是半透明的** ——

      `highlightActiveLine()` 是给**行本身**加一个 `.cm-activeLine` 的背景，
      而这个行 div 在**内容层**里 —— **画在选区层的上面**（选区层的 z-index 是 -1）。

      不透明的话 ⇒ 当前行的选区被**整个盖住** ⇒
      「光标在哪一行，那一行的选区就看不见」（用户报过两次：
      「同一行内选中的字特别不明显」/「即使你选中了部分文字仍然不会变」）。

      CodeMirror 自带的 base theme 用的是半透明色（`#99eeff33`），
      就是为了这个 —— 半透明 ⇒ 选区透上来 ✓。
    */
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.035)', color: '#a6accd' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-tooltip': {
      backgroundColor: '#1b1e26',
      border: '1px solid #2a2f3a',
      borderRadius: '6px',
      color: '#d7dce5',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#2b4a52',
      color: '#00d4aa',
    },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #ff6b6b' },
    '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy #ffb454' },
  },
  { dark: true },
)

/** 关键字 / 类型 / 内建 的补全项。 */
function keywordCompletions(): CompletionResult {
  const options = [
    ...KEYWORD_LIST.map((k) => ({ label: k, type: 'keyword' as const })),
    { label: 'true', type: 'constant' as const },
    { label: 'false', type: 'constant' as const },
    { label: 'null', type: 'constant' as const },
    { label: 'i8', type: 'type' as const },
    { label: 'i16', type: 'type' as const },
    { label: 'i32', type: 'type' as const },
    { label: 'i64', type: 'type' as const },
    { label: 'u8', type: 'type' as const },
    { label: 'u16', type: 'type' as const },
    { label: 'u32', type: 'type' as const },
    { label: 'u64', type: 'type' as const },
    { label: 'f32', type: 'type' as const },
    { label: 'f64', type: 'type' as const },
    { label: 'bool', type: 'type' as const },
    { label: 'Cap', type: 'type' as const },
    { label: 'PhantomData', type: 'type' as const },
    ...BUILTINS.map((b) => ({
      label: b.name,
      type: 'function' as const,
      detail: b.doc,
    })),
    { label: 'printf', type: 'function' as const, detail: 'C 风格格式化输出' },
  ]
  return { from: 0, options, validFor: /^[\w]*$/ }
}

/** `mod::` 之后的补全 —— 标准库的成员。 */
function qualifiedCompletion(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w$]*/)
  if (!word) return null
  if (word.from === word.to && !context.explicit) return null

  // 往前找 `mod::`
  const before = context.state.doc.sliceString(
    Math.max(0, word.from - 64),
    word.from,
  )
  const m = /([A-Za-z_][A-Za-z0-9_]*)::$/.exec(before)
  if (!m) return null

  const mod = findStdlibModule(m[1])
  if (!mod) return null

  return {
    from: word.from,
    options: mod.functions.map((f) => ({
      label: f.name,
      type: 'function' as const,
      detail: `${mod.name}::${f.name}`,
      info: f.doc,
    })),
  }
}

/** `import ` 之后的补全 —— 标准库模块名。 */
function importCompletion(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w$]*/)
  if (!word) return null
  const before = context.state.doc.sliceString(Math.max(0, word.from - 16), word.from)
  if (!/\bimport\s+$/.test(before)) return null
  return {
    from: word.from,
    options: STDLIB_MODULES.map((m) => ({
      label: m.name,
      type: 'namespace' as const,
      detail: m.doc,
    })),
  }
}

/** 悬停提示：标准库函数 / 关键字。 */
function jhyyHover(): (view: EditorView, pos: number, side: number) => Tooltip | null {
  return (view, pos) => {
    const word = wordAt(view, pos)
    if (!word) return null
    const text = word.text

    for (const m of STDLIB_MODULES) {
      const fn = m.functions.find((f) => f.name === text)
      if (fn) {
        return {
          pos: word.from,
          above: true,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-tooltip'
            dom.innerHTML = `<b>${m.name}::${fn.name}</b><br>${fn.doc ?? ''}`
            return { dom }
          },
        }
      }
    }

    const builtin = BUILTINS.find((b) => b.name === text)
    if (builtin) {
      return {
        pos: word.from,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-tooltip'
          dom.innerHTML = `<b>${builtin.name}</b><br>${builtin.doc ?? ''}`
          return { dom }
        },
      }
    }

    // 语言规范里的章节引用
    const spec = findSpecForWord(text)
    if (spec && spec.score >= 3) {
      return {
        pos: word.from,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-tooltip'
          dom.innerHTML =
            `<b>${escapeHtml(formatSectionRef(spec.section))}</b><br>` +
            `${escapeHtml(spec.excerpt)}`
          return { dom }
        },
      }
    }

    return null
  }
}

/** HTML 转义 —— 悬停内容里可能有尖括号。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 取光标处的单词（StreamLanguage 没有语法树，只能自己找）。 */
function wordAt(
  view: EditorView,
  pos: number,
): { text: string; from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch)
  if (offset > 0 && isWord(text[offset - 1])) {
    // 往左扩
    let start = offset
    while (start > 0 && isWord(text[start - 1])) start--
    let end = offset
    while (end < text.length && isWord(text[end])) end++
    return { text: text.slice(start, end), from: line.from + start, to: line.from + end }
  }
  if (offset < text.length && isWord(text[offset])) {
    let start = offset
    while (start > 0 && isWord(text[start - 1])) start--
    let end = offset
    while (end < text.length && isWord(text[end])) end++
    return { text: text.slice(start, end), from: line.from + start, to: line.from + end }
  }
  return null
}

export interface CreateEditorOptions {
  doc: string
  onChange?: (value: string) => void
  readOnly?: boolean
  /** 诊断来源（来自真实编译器的 stderr） */
  linter?: ReturnType<typeof linter>
  placeholder?: string
  /** 光标位置 / 选区变了 —— 状态栏的 "Ln x, Col y" 用 */
  onCursorChange?: (info: CursorInfo) => void
}

/** 光标位置（行列都是 **1-based**，跟编译器一致）。 */
export interface CursorInfo {
  line: number
  col: number
  /** 选区跨了几行（没有选区时是 0） */
  selectedLines: number
}

/**
 * 可重配的槽位。
 *
 * `EditorState.readOnly` 和 `EditorView.lineWrapping` 都只在**建视图时**生效，
 * 直接 `view.dispatch({ effects: [] })` 是空操作 —— 想在运行时切换（比如
 * 「自动换行」快捷键），必须用 compartment 重配。
 */
export const readOnlyCompartment = new Compartment()
export const lineWrapCompartment = new Compartment()

/** 从编辑器状态里算出光标位置。 */
export function cursorInfoOf(state: EditorState): CursorInfo {
  const range = state.selection.main
  const head = state.doc.lineAt(range.head)
  const from = state.doc.lineAt(range.from)
  const to = state.doc.lineAt(range.to)
  return {
    line: head.number,
    col: range.head - head.from + 1,
    selectedLines: range.empty ? 0 : to.number - from.number + 1,
  }
}

/** 创建一个 JHYY 代码编辑器。 */
export function createCodeEditor(parent: HTMLElement, opts: CreateEditorOptions): EditorView {
  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    indentUnit.of('    '),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    syntaxHighlighting(jhyyHighlightStyle),
    jhyyLanguage,
    theme,
    lineWrapCompartment.of(EditorView.lineWrapping),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    autocompletion({
      override: [
        qualifiedCompletion,
        importCompletion,
        keywordCompletions,
      ],
    }),
    hoverTooltip(jhyyHover()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange?.(update.state.doc.toString())
      if (update.docChanged || update.selectionSet) {
        opts.onCursorChange?.(cursorInfoOf(update.state))
      }
    }),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(opts.readOnly))),
  ]

  if (opts.placeholder) extensions.push(placeholderExt(opts.placeholder))
  if (opts.linter) extensions.push(opts.linter)

  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions }),
    parent,
  })
  return view
}

/**
 * 把编译器诊断转成 CodeMirror 的 lint 诊断。
 *
 * ⚠️ 编译器的行列是 **1-based**，CodeMirror 是 **0-based** —— 要减 1，
 *    而且要按**行**换算成文档偏移（不能拿行列直接当偏移用）。
 * ⚠️ 编译器只报**第一个**错误就 bail，所以这里通常只有一条。
 */
export function toCmDiagnostics(
  doc: Text,
  diagnostics: { line: number; col: number; message: string; severity: 'error' | 'warning' }[],
): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const lineNo = Math.min(Math.max(d.line, 1), doc.lines)
    const line = doc.line(lineNo)
    const from = Math.min(line.to, line.from + Math.max(0, d.col - 1))
    return {
      from,
      to: Math.min(line.to, from + 1),
      severity: d.severity,
      message: d.message,
    }
  })
}
