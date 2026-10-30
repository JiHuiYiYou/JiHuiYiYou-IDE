import { forceLinting, linter } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { Diagnostic } from '@shared/jhyy'
import {
  createCodeEditor,
  cursorInfoOf,
  lineWrapCompartment,
  readOnlyCompartment,
  toCmDiagnostics,
  type CursorInfo,
} from '../editor/codemirror'
import { revealLine, runEditorCommand, type EditorCommand } from '../editor/editorCommands'
import { applyTextChange, normalizeEol } from '../sync/caret'

interface Props {
  value: string
  onChange?: (value: string) => void
  diagnostics?: Diagnostic[]
  readOnly?: boolean
  /** 光标位置变了（状态栏用） */
  onCursorChange?: (info: CursorInfo) => void
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
  /** 切换自动换行（Alt+Z） */
  toggleLineWrapping(): void
  /** 切换只读 */
  setReadOnly(readOnly: boolean): void
}

/**
 * 文本视图 —— CodeMirror 6。
 *
 * React 19 里 `ref` 就是一个普通 prop，不用 forwardRef。
 */
export default function CodePane({
  value,
  onChange,
  diagnostics = [],
  readOnly,
  onCursorChange,
  ref,
}: Props & { ref?: Ref<CodePaneHandle> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const diagnosticsRef = useRef<Diagnostic[]>(diagnostics)
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursorChange)
  /** 正在把外部的值写进编辑器 —— 这时不要回调 onChange（否则自激） */
  const applyingRef = useRef(false)
  /** 自动换行当前开没开（用来做切换） */
  const wrappedRef = useRef(true)
  diagnosticsRef.current = diagnostics
  onChangeRef.current = onChange
  onCursorRef.current = onCursorChange

  // 建编辑器（只建一次）
  useEffect(() => {
    if (!hostRef.current) return
    const view = createCodeEditor(hostRef.current, {
      doc: value,
      onChange: (v) => {
        if (applyingRef.current) return
        onChangeRef.current?.(v)
      },
      onCursorChange: (info) => onCursorRef.current?.(info),
      readOnly,
      linter: linter((v) => toCmDiagnostics(v.state.doc, diagnosticsRef.current)),
    })
    viewRef.current = view
    // 建好之后立刻报一次位置 —— 否则状态栏在第一次移动光标前是空的
    onCursorRef.current?.(cursorInfoOf(view.state))
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部（块视图）改了内容 → 同步进编辑器，并保住光标
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // ⚠️ 比的是**归一化成 LF 之后**的文本 —— CodeMirror 的文档里
    // 永远是 LF（灌字符串时 `\r` 会被丢掉），而磁盘上的文件可能是 CRLF。
    // 不归一化就会每次都判成「变了」，白白应用一次（还会让选区越界）。
    if (view.state.doc.toString() !== normalizeEol(value)) {
      applyingRef.current = true
      try {
        applyTextChange(view, value)
      } finally {
        applyingRef.current = false
      }
    }
  }, [value])

  // 诊断变了 → 让 lint 重新跑一遍
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    forceLinting(view)
  }, [diagnostics])

  // 只读状态变了
  //
  // ⚠️ 以前这里是 `view.dispatch({ effects: [] })` —— **空操作**。
  // `EditorState.readOnly` 只在**建视图时**生效，所以运行时切只读根本不生效。
  // 现在用 compartment 重配。
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(readOnly))),
    })
  }, [readOnly])

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
      toggleLineWrapping() {
        const view = viewRef.current
        if (!view) return
        wrappedRef.current = !wrappedRef.current
        view.dispatch({
          effects: lineWrapCompartment.reconfigure(
            wrappedRef.current ? EditorView.lineWrapping : [],
          ),
        })
      },
      setReadOnly(next) {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next)),
        })
      },
    }),
    [],
  )

  return <div ref={hostRef} className="code-pane" />
}
