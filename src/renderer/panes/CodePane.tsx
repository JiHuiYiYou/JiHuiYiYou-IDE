import { forceLinting } from '@codemirror/lint'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { Diagnostic } from '@shared/jhyy'
import {
  createCodeEditor,
  cursorInfoOf,
  readOnlyCompartment,
  setEditorDiagnostics,
  type CursorInfo,
} from '../editor/codemirror'
import type { DocStore } from '../editor/docStore'
import {
  applyWordWrap,
  revealLine,
  runEditorCommand,
  type EditorCommand,
} from '../editor/editorCommands'
import { applyTextChange } from '../sync/caret'
import { DEFAULT_SETTINGS } from '../state/settings'

interface Props {
  /** 当前显示的是哪个文件（null = 没开文件） */
  fileId: string | null
  /** 文档仓库 —— 文本只存在这儿（编辑器里） */
  store: DocStore
  diagnostics?: Diagnostic[]
  readOnly?: boolean
  /** 编辑区字体（CSS font-family）—— 用户设置里改的 */
  fontFamily?: string
  /** 编辑区字号（像素）—— 用户设置里改的 */
  fontSize?: number
}

/**
 * 文本视图对外暴露的能力。
 *
 * 菜单（撤销/重做/复制/粘贴/查找…）、快捷键、问题面板的「点击跳转」都要驱动编辑器，
 * 而编辑器实例在 `useEffect` 里创建、外面拿不到 —— 所以用 imperative handle 递出去。
 */
export interface CodePaneHandle {
  /** 跳到 1-based 的行列并把光标放过去 */
  revealLine(line: number, col: number): void
  focus(): void
  /** 当前选区文本（复制用） */
  getSelection(): string
  /** 当前选区（状态栏的 "Ln x, Col y" 用） */
  getSelectionInfo(): CursorInfo
  /** 执行一条编辑器命令 */
  exec(cmd: EditorCommand): void
  /** 切换只读 */
  setReadOnly(readOnly: boolean): void
  /** 把整个文档换成另一段（块视图回写用）—— 是一次**真事务** ⇒ 可以撤销 ✓ */
  replaceDoc(text: string): void
  /** 把整个文档换成另一段，**不进撤销历史**（磁盘上被改了 ⇒ 重新加载） */
  setDoc(text: string): void
  /**
   * **视图现在显示的是不是这个文件**？
   *
   * ⚠️ **为什么需要它** ——
   *   切标签是「先 `setActiveId`（render 时更新）→ 再由 effect 换视图」⇒
   *   ⇒ **中间有一个窗口**：视图还显示着**上一个**文件 ⇒
   *   ⇒ 这时候往视图里写内容 ⇒ **写错文件了** ✗✗
   *   ⇒ ⇒ 用它问一句「你现在显示的是这个文件吗」✓
   */
  isShowing(fileId: string): boolean
}

/**
 * 文本视图 —— CodeMirror 6。
 *
 * React 19 里 `ref` 就是一个普通 prop，不用 forwardRef。
 *
 * ⚠️⚠️ **这里不持有文本** ——
 *   文本在 `DocStore` 里（每个文件一份 `EditorState`）⇒
 *   ⇒ 切标签 = `view.setState(store.get(fileId))` ⇒ **O(1)** ✓
 *   ⇒ 而且**每个文件的撤销历史各归各的**（VS Code 的 model ↔ view 模型）✓
 */
export default function CodePane({
  fileId,
  store,
  diagnostics = [],
  readOnly,
  fontFamily,
  fontSize,
  ref,
}: Props & { ref?: Ref<CodePaneHandle> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const diagnosticsRef = useRef<Diagnostic[]>(diagnostics)
  diagnosticsRef.current = diagnostics
  /** 上一次显示的是哪个文件（切走时要记它的滚动位置） */
  const prevIdRef = useRef<string | null>(null)
  /**
   * **视图现在显示的是哪个文件** ——
   *
   * ⚠️ **在 effect 里更新**（不是 render 时）⇒
   * ⇒ 它代表的是「**视图真的换了**」的时刻 ⇒
   * ⇒ 切标签的那个窗口里，它还是**旧文件** ⇒ 正好用来挡住写错文件 ✓
   */
  const shownIdRef = useRef<string | null>(null)
  /** 每个文件的滚动位置（VS Code：切回来还在原处） */
  const scrollMem = useRef(new Map<string, number>())

  /*
    建编辑器（只建一次）。

    ⚠️⚠️ **这里现在什么回调都不传** ——
    「文档变了」「光标动了」这些回调**跟着每个文件自己的 `EditorState` 走**
    （`App` 建 state 的时候传进去）⇒ ⇒ 切标签时 `view.setState(...)`
    ⇒ ⇒ 回调也跟着换成了**那个文件的** ⇒ ⇒ 分得清「是哪个文件变了」✓
  */
  useEffect(() => {
    if (!hostRef.current) return
    const view = createCodeEditor(hostRef.current, {
      doc: '',
      readOnly,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
    切文件 ⇒ 把视图换成**那个文件的 state**（O(1)）。

    ⚠️ **以前这里是「按内容 diff」** ——
      `view.state.doc.toString() !== normalizeEol(value)` ⇒
      然后 `applyTextChange` 用**逐字符**的最长公共前后缀去算改动区间 ⇒
      ⇒ 一个 10 MB 的文件 ⇒ **上千万次 JS 字符比较** ⇒ 切一下卡一下 ✗✗
      ⇒ 而且那个 dispatch **没带 `addToHistory: false`** ⇒
      ⇒ **切文件后按 Ctrl+Z 会把上一个文件的文本恢复进当前文件**（真 bug）✗

    ⇒ 现在：**换 state**，不碰内容 ⇒ O(1) ⇒ 而且**根本没有事务** ⇒
    ⇒ 撤销历史各归各的 ⇒ 那个 bug 自动没了 ✓

    ⚠️⚠️ **但 `view.setState()` 会把滚动位置重置掉** ——
      它建的是**全新的 `ViewState`** ⇒ 滚动锚点归零 ⇒
      ⇒ 切一下标签，文件就跳回顶部 ✗
      ⇒ ⇒ **每个文件各记一份滚动位置**（VS Code 就是这样的）⇒
      ⇒ 切回去 ⇒ 回到你离开时的那一行 ✓
  */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // ① 记住**上一个**文件的滚动位置
    const prevId = prevIdRef.current
    if (prevId && prevId !== fileId) {
      scrollMem.current.set(prevId, view.scrollDOM.scrollTop)
    }
    // ② 换 state
    const next = fileId ? store.get(fileId) : undefined
    view.setState(next ?? EditorState.create({ doc: '' }))
    /*
      ⚠️ **换 state 会把「自动换行」的配置一起换掉** ——
        `lineWrapCompartment` 在 **state 的扩展**里 ⇒ 每个文件各存一份 ⇒
        ⇒ `setState` 换过去 ⇒ 变成那个文件存的值（默认「关」）⇒
        ⇒ 菜单上还打着勾、编辑器里却没换行 ⇒ **自相矛盾** ✗
        ⇒ ⇒ 重新压一次全局设置 ✓
    */
    applyWordWrap(view)
    // ③ 恢复**这个**文件的滚动位置
    const top = fileId ? (scrollMem.current.get(fileId) ?? 0) : 0
    const restore = (): void => {
      view.scrollDOM.scrollTop = top
    }
    restore()
    // ⚠️ **布局还没量完的时候设 scrollTop 会被吃掉** ⇒ 再补一次（下一帧）✓
    requestAnimationFrame(restore)
    prevIdRef.current = fileId
    // ⚠️ **只有「真的换到那个文件了」才记** ——
    //   仓库里没有这个文件 ⇒ 视图显示的是空的 ⇒ 不该声称「显示着它」✓
    shownIdRef.current = next ? fileId : null
    // 切过去之后，诊断要重新画一遍（lint 状态随 state 换了）
    forceLinting(view)
  }, [fileId, store])

  // 诊断变了 → 让 lint 重新跑一遍
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    setEditorDiagnostics(diagnostics)
    forceLinting(view)
  }, [diagnostics])

  // 只读状态变了
  //
  // ⚠️ 以前这里是 `view.dispatch({ effects: [] })` —— **空操作**。
  // `EditorState.readOnly` 只在**建视图时**生效，所以运行时切只读根本不生效。
  // 现在用 compartment 重配。
  //
  // ⚠️ **切文件也要重配** —— 每个文件的状态里都存着自己的 `readOnly`
  //   （`view.setState()` 会把它一起换掉）⇒ ⇒ 切完得再压一次 ✓
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(readOnly))),
    })
  }, [readOnly, fileId])

  useImperativeHandle(
    ref,
    (): CodePaneHandle => ({
      revealLine(line, col) {
        const view = viewRef.current
        if (view) revealLine(view, line, col)
      },
      focus() {
        viewRef.current?.focus()
      },
      getSelection() {
        const view = viewRef.current
        if (!view) return ''
        const range = view.state.selection.main
        return view.state.sliceDoc(range.from, range.to)
      },
      getSelectionInfo() {
        const view = viewRef.current
        if (!view) return { line: 1, col: 1, selectedLines: 0 }
        return cursorInfoOf(view.state)
      },
      exec(cmd) {
        const view = viewRef.current
        if (view) runEditorCommand(view, cmd)
      },
      setReadOnly(next) {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next)),
        })
      },
      replaceDoc(text) {
        const view = viewRef.current
        if (!view) return
        /*
          ⚠️⚠️ **别用「整段替换」** ——
          块视图回写时整份源码都变了 ⇒ 直接换掉 ⇒ **光标跳到开头** ✗
          ⇒ 用户刚从块视图切回文本 ⇒ 光标在第一行 ⇒ 体验很差 ⇒
          ⇒ 用 `applyTextChange`（最长公共前后缀 ⇒ 只改真正变了的那一段，
          光标映射过去）✓
          ⚠️ 代价是 O(n) 的一次全文比较 —— 但块编辑本来就是 O(n)
          （要解析、要打印）⇒ 不改变复杂度 ✓
        */
        applyTextChange(view, text)
      },
      setDoc(text) {
        const view = viewRef.current
        if (!view) return
        /*
          ⚠️ **不进撤销历史** ——
          「磁盘上被改了 ⇒ 重新加载」不是用户的编辑 ⇒
          ⇒ 用户按 Ctrl+Z 不该把它变回去 ⇒ `addToHistory: false` ✓
        */
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: Transaction.addToHistory.of(false),
        })
      },
      isShowing(fileId) {
        return shownIdRef.current === fileId
      },
    }),
    [],
  )

  return (
    <div
      ref={hostRef}
      className="code-pane"
      style={
        {
          /*
            ⚠️ **字体/字号走 CSS 变量** ——
            CSS 变量是「活」的 ⇒ 改完**立刻生效**，不用重建编辑器 ✓
            （而 CodeMirror 的主题只在建视图时生效 ⇒ 走主题就得用 compartment 重配，
              那套更绕 ⇒ 用变量 ✓）
            ⚠️ **字号设在 `&`（编辑器根）上** —— 设 `.cm-content` 的话
            **行号那一栏还是 body 的字号** ⇒ 大小不一致 ✗（gutter 继承 `&` ⇒ 一起变 ✓）
            ⚠️ **字体要设两处** —— base theme 里 `.cm-content` 写死了自己的 font-family，
            它的选择器比 `&` 具体 ⇒ 只改 `&` 的话**正文还是老的字体** ⇒ 一起改 ✓
          */
          '--editor-font-family': fontFamily ?? DEFAULT_SETTINGS.editorFontFamily,
          '--editor-font-size': `${fontSize ?? DEFAULT_SETTINGS.editorFontSize}px`,
        } as React.CSSProperties
      }
    />
  )
}
