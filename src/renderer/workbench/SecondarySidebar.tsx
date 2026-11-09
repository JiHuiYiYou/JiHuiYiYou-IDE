import { forwardRef, useRef } from 'react'
import { useResizable } from '../hooks/useResizable'
import ChatPane, { type ChatPaneHandle } from '../panes/ChatPane'

interface Props {
  open: boolean
  width: number
  onWidthChange: (w: number) => void
  filePath: string | null
  /**
   * 当前标签页显示的名字。
   *
   * ⚠️ **新建的未命名文件没有路径**（`filePath` 是 null）—— 只看路径的话，
   * 聊天面板会对它显示「（没打开文件）」（用户报过：这不对）。
   */
  fileName: string | null
  /**
   * Claude 的工作目录。
   *
   * ⚠️ 未命名的新文件**没有路径** ⇒ 不能跟着它走 ⇒ 退到最近打开过的
   * 那个文件的目录（再退才是 home 目录）。
   */
  cwd?: string | null
  externalChange: string | null
  onReload: () => void
  /** 只读模式（聊天里那个开关） */
  readOnly: boolean
  onReadOnlyChange: (readOnly: boolean) => void
}

/**
 * 右侧辅助侧边栏 —— 装聊天。
 *
 * VS Code 把 Copilot 放在这儿（辅助侧边栏），我们把 Claude Code 对话放这儿。
 * 宽度可拖，折叠时聊天**不卸载**（Claude 会话在主进程里跑着，卸载只是把 UI 藏了，
 * 但组件还在 —— 所以这里用 `display:none` 而不是条件渲染）。
 */
const SecondarySidebar = forwardRef<ChatPaneHandle, Props>(function SecondarySidebar(props, chatRef) {
  /** 侧栏的 DOM（拖动时直接改它的 style ⇒ 不进 React） */
  const ref = useRef<HTMLDivElement>(null)
  const drag = useResizable({
    /*
      ⚠️ **拖动中直接改 DOM** —— 不写 React state ⇒ 不重渲染 ✓
      （松手时才 `onCommit` ⇒ 写回 state + 存档，一次）✓
    */
    onResize: (w) => {
      const el = ref.current
      if (el) el.style.width = `${w}px`
    },
    onCommit: props.onWidthChange,
    size: props.width,
    direction: 'vertical',
    min: 260,
    max: 900,
    invert: true,
  })

  return (
    <div
      ref={ref}
      className={props.open ? 'secondary-sidebar' : 'secondary-sidebar closed'}
      style={props.open ? { width: props.width } : undefined}
    >
      {props.open && <div className="sidebar-resize-handle" onPointerDown={drag.onPointerDown} />}
      <ChatPane
        ref={chatRef}
        filePath={props.filePath}
        fileName={props.fileName}
        cwd={props.cwd}
        externalChange={props.externalChange}
        onReload={props.onReload}
        readOnly={props.readOnly}
        onReadOnlyChange={props.onReadOnlyChange}
      />
    </div>
  )
})

export default SecondarySidebar
