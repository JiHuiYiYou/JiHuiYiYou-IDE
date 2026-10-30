import { useResizable } from '../hooks/useResizable'
import ChatPane from '../panes/ChatPane'

interface Props {
  open: boolean
  width: number
  onWidthChange: (w: number) => void
  filePath: string | null
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
export default function SecondarySidebar(props: Props) {
  const drag = useResizable({
    onResize: props.onWidthChange,
    size: props.width,
    direction: 'vertical',
    min: 260,
    max: 900,
    invert: true,
  })

  return (
    <div
      className={props.open ? 'secondary-sidebar' : 'secondary-sidebar closed'}
      style={props.open ? { width: props.width } : undefined}
    >
      {props.open && <div className="sidebar-resize-handle" onPointerDown={drag.onPointerDown} />}
      <ChatPane
        filePath={props.filePath}
        externalChange={props.externalChange}
        onReload={props.onReload}
        readOnly={props.readOnly}
        onReadOnlyChange={props.onReadOnlyChange}
      />
    </div>
  )
}
