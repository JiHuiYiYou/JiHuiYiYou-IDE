import { forceLinting, linter } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { Diagnostic } from '@shared/jhyy'
import { createCodeEditor, toCmDiagnostics } from '../editor/codemirror'
import { applyTextChange } from '../sync/caret'

interface Props {
  value: string
  onChange?: (value: string) => void
  diagnostics?: Diagnostic[]
  readOnly?: boolean
}

/** 文本视图 —— CodeMirror 6。 */
export default function CodePane({ value, onChange, diagnostics = [], readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const diagnosticsRef = useRef<Diagnostic[]>(diagnostics)
  const onChangeRef = useRef(onChange)
  /** 正在把外部的值写进编辑器 —— 这时不要回调 onChange（否则自激） */
  const applyingRef = useRef(false)
  diagnosticsRef.current = diagnostics
  onChangeRef.current = onChange

  // 建编辑器（只建一次）
  useEffect(() => {
    if (!hostRef.current) return
    const view = createCodeEditor(hostRef.current, {
      doc: value,
      onChange: (v) => {
        if (applyingRef.current) return
        onChangeRef.current?.(v)
      },
      readOnly,
      linter: linter((v) => toCmDiagnostics(v.state.doc, diagnosticsRef.current)),
    })
    viewRef.current = view
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
    if (view.state.doc.toString() !== value) {
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
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: [] })
  }, [readOnly])

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
}
