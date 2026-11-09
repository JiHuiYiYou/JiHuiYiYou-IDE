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
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { lintKeymap, linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, Compartment, Transaction, type Extension, type Text } from '@codemirror/state'
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
  type ViewUpdate,
} from '@codemirror/view'
import { KEYWORD_LIST } from '@lang/token'
import { findSpecForWord, formatSectionRef } from '@lang/spec'
import { BUILTINS, STDLIB_MODULES, findStdlibModule } from '@lang/stdlib'
import type { Diagnostic } from '@shared/jhyy'
import { cursorStore, type CursorInfo } from '../state/cursorStore'
import { jhyyHighlightStyle, jhyyLanguage } from './jhyyLanguage'

/** 主题（暗色）。 */
const theme = EditorView.theme(
  {
    '&': {
      color: '#d7dce5',
      backgroundColor: '#101219',
      height: '100%',
      /*
        ⚠️ **字体/字号走 CSS 变量** —— 用户在设置里改 ⇒
        React 把变量写在 `.code-pane` 的行内样式上 ⇒
        **CSS 变量是会「活」的** ⇒ 改完立刻生效，**不用重建编辑器** ✓
        （而 CodeMirror 的主题只在建视图时生效 ⇒ 走主题就得用 compartment 重配）

        ⚠️ **字号设在 `&`（编辑器根）上** —— 设 `.cm-content` 的话
        **行号那一栏还是 body 的字号** ⇒ 大小不一致 ✗（gutter 继承 `&` ⇒ 一起变 ✓）
        ⚠️ **字体要设两处** —— base theme 里 `.cm-content` 写死了自己的 font-family，
        它的选择器比 `&` 具体 ⇒ 只改 `&` 的话**正文还是老的字体** ⇒ 一起改 ✓
      */
      fontFamily: 'var(--editor-font-family)',
      fontSize: 'var(--editor-font-size)',
    },
    '.cm-content': {
      caretColor: '#00d4aa',
      fontFamily: 'var(--editor-font-family)',
    },
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

/**
 * 关键字 / 类型 / 内建 的补全项。
 *
 * ⚠️ **选项表是模块级常量** —— 以前每次补全激活都重建一遍（~90 项对象）
 * ⇒ 白白分配 ⇒ 现在只建一次 ✓
 */
const KEYWORD_COMPLETION_OPTIONS: CompletionResult['options'] = [
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

function keywordCompletions(): CompletionResult {
  return { from: 0, options: KEYWORD_COMPLETION_OPTIONS, validFor: /^[\w]*$/ }
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
  /**
   * **文档内容变了** —— 只报「变了」，**不报内容**！
   *
   * ⚠️⚠️ **这里原来是把整份文档传出去的**（`onChange(value: string)`）⇒
   *   以前每次按键都要 `update.state.doc.toString()` ⇒
   *   **把整个文件重新物化成字符串** ⇒
   *   ⇒ 文件越大越卡（10 MB 的文件：每次按键几十毫秒 + 几十 MB 垃圾）✗✗
   *   ⇒ ⇒ 现在**只报「变了」** ⇒ 谁要内容谁自己**按需**去取 ⇒ **O(1)** ✓
   *
   * ⇒ 需要内容的时候（比如存盘、编译前）用 `docStore.text(id)` 取**一次** ✓
   *
   * ⇒ 传的是整个 `ViewUpdate`（要 `startState` 才能认出「撤销 / 重做」）✓
   */
  onDocChange?: (update: ViewUpdate) => void
  readOnly?: boolean
  placeholder?: string
}

/** 光标位置（行列都是 **1-based**，跟编译器一致）。 */
export type { CursorInfo } from '../state/cursorStore'

/**
 * **这次改动是不是「撤销 / 重做」**？
 *
 * ⚠️ **为什么认这个** ——
 *   脏标记要在「撤销回存盘点」的那一刻**准确地消失**（VS Code 的行为）⇒
 *   ⇒ 撤销/重做之后必须**精确比一次内容**（O(n)）⇒
 *   ⇒ 但**普通打字不能比**（O(n) ⇒ 每敲一个字都全文件比较 ⇒ 卡）✗
 *   ⇒ ⇒ 得认得出「这是撤销」⇒ 只在撤销/重做时才付 O(n) 的代价 ✓
 *
 * ⚠️ **怎么认** —— CodeMirror 的 `history` 扩展在撤销/重做时会给事务打上
 *   `Transaction.userEvent` 注解：`"undo"` / `"redo"`
 *   （源码：`@codemirror/commands` 的 `HistoryState.pop`）✓
 *   ⇒ 别的路子（比 `undoDepth`）都靠不住 —— 它会**饱和**，而且
 *   「普通编辑」和「重做」都会让它**变大** ⇒ 分不出来 ✗
 */
export function isHistoryJump(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => {
    const ev = tr.annotation(Transaction.userEvent)
    return ev === 'undo' || ev === 'redo'
  })
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

/**
 * **编辑器里当前的诊断**（波浪线）。
 *
 * ⚠️ **为什么是模块级的** ——
 *   linter 扩展是**跟着 `EditorState` 走的**（每个文件一份）⇒
 *   ⇒ 它不能闭包捕获 `App` 的 state ⇒ ⇒ 诊断放在这儿，谁要谁取 ✓
 *   （`CodePane` 每次诊断变了就往这儿写一份 + `forceLinting`）
 */
let editorDiagnostics: Diagnostic[] = []

/** 把诊断写进编辑器（`CodePane` 在诊断变化时调）。 */
export function setEditorDiagnostics(diagnostics: Diagnostic[]): void {
  editorDiagnostics = diagnostics
}

/**
 * 建一个 JHYY 编辑器的**扩展集**。
 *
 * ⚠️ **每个打开的文件各有一份 `EditorState`** ⇒ 每个文件也就各有一份扩展集
 * （`history` / `Language.state` 这些 state 字段都是**跟着 state 走**的）⇒
 * ⇒ 切标签 = `view.setState(别的文件的 state)` ⇒ 撤销历史、语法树、光标
 * **全都各归各的** ✓（VS Code 的 model ↔ view 模型）
 */
export function jhyyExtensions(opts: Omit<CreateEditorOptions, 'doc'>): Extension[] {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    /*
      ⚠️ **这里以前有 `foldGutter()` —— 现在删掉了** ——
      折叠要语言数据里有 `foldable` 才会生效，而 JHYY 的语言数据
      （`jhyyLanguage.ts` 的 `languageData`）**没有** `foldable` ⇒
      ⇒ 折叠箭头**从来没出现过** ⇒ 那是个纯死代码（还白占一点渲染开销）✗
      ⇒ 真要折叠 ⇒ 得给语言数据加 `foldable`（按 `{`/`}` 配对），
      那是一件独立的活儿。
    */
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
    /*
      ⚠️ **自动换行默认关**（跟 VS Code 的 `editor.wordWrap: off` 一个路子）。

      自动换行是**大文件的头号性能杀手** —— 一行 5 万字符的代码会被拆成
      几十万个视觉行盒子 ⇒ 布局计算暴增 ⇒ 滚动直接卡住。

      ⇒ 用户想开随时按 **Alt+Z**（命令 `view.toggleWordWrap`）✓
    */
    lineWrapCompartment.of([]),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
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
      /*
        ⚠️⚠️ **这里原来是把整份文档传出去的** ——
        `opts.onChange?.(update.state.doc.toString())` ⇒
        **每次按键都把整个文件重新物化成字符串** ⇒
        文件越大越卡（10 MB ⇒ 每次按键几十毫秒）✗✗
        ⇒ ⇒ 现在**只报「变了」**（state 本身就在那儿，要内容自己去取）⇒ O(1) ✓
      */
      if (update.docChanged) opts.onDocChange?.(update)
      if (update.docChanged || update.selectionSet) {
        /*
          ⚠️ **光标直接写进自己的 store** —— 不经过 `App` 的 state ⇒
          ⇒ 光标一动，**只有状态栏重渲染**（它订阅了这个 store）⇒
          ⇒ App 那一大棵树完全不受影响 ✓（打字不再「整个 IDE 都抖」）
        */
        cursorStore.set(cursorInfoOf(update.state))
      }
    }),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(opts.readOnly))),
  ]

  if (opts.placeholder) extensions.push(placeholderExt(opts.placeholder))
  /*
    ⚠️ **诊断的波浪线** —— 扩展是**每个文件一份**（跟着 state 走）⇒
    ⇒ 它不能闭包捕获 `App` 的 state ⇒ 诊断从模块级的 `editorDiagnostics` 读 ✓
  */
  extensions.push(linter((v) => toCmDiagnostics(v.state.doc, editorDiagnostics)))

  return extensions
}

/**
 * 建一个 JHYY 编辑器的**状态**（文档 + 扩展）。
 *
 * ⚠️ **状态是「不可变」的** —— 每次事务都会产生一个新的 state 对象 ⇒
 * ⇒ 谁持有最新那份，谁就得在每次事务后更新它 ⇒
 * **这就是 `DocStore` 的活**（见 `src/renderer/editor/docStore.ts`）✓
 */
export function createEditorState(
  doc: string,
  opts: Omit<CreateEditorOptions, 'doc'> = {},
): EditorState {
  return EditorState.create({ doc, extensions: jhyyExtensions(opts) })
}

/** 创建一个 JHYY 代码编辑器（一步到位：建状态 + 建视图）。 */
export function createCodeEditor(parent: HTMLElement, opts: CreateEditorOptions): EditorView {
  const view = new EditorView({
    state: createEditorState(opts.doc, opts),
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
