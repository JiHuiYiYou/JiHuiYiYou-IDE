import { useEffect, useRef } from 'react'
import { Icon } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  menuBarVisible: boolean
  statusBarVisible: boolean
  sidebarOpen: boolean
  panelOpen: boolean
  onToggleMenuBar: () => void
  onToggleStatusBar: () => void
  onToggleSidebar: () => void
  onTogglePanel: () => void
}

/**
 * 「自定义布局」下拉 —— 抄 VS Code 标题栏上那个布局按钮。
 *
 * VS Code 那边是个勾选清单（菜单栏 / 活动栏 / 主侧栏 / 辅助侧边栏 / 面板 / 状态栏），
 * 右边带快捷键。我们没有活动栏/主侧栏，所以只剩四项。
 */
export default function LayoutMenu(props: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!props.open) return
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [props])

  if (!props.open) return null

  const item = (
    label: string,
    checked: boolean,
    onToggle: () => void,
    keybinding?: string,
  ) => (
    <button className="layout-item" onClick={onToggle}>
      <span className="layout-item-check">{checked ? '✓' : ''}</span>
      <span className="layout-item-label">{label}</span>
      {keybinding && <span className="layout-item-key">{keybinding}</span>}
    </button>
  )

  return (
    <div className="layout-menu" ref={ref}>
      <div className="layout-menu-title">
        <span>自定义布局</span>
        <button className="icon-button small" onClick={props.onClose} title="关闭">
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="layout-menu-items">
        {item('菜单栏', props.menuBarVisible, props.onToggleMenuBar)}
        {item('辅助侧边栏', props.sidebarOpen, props.onToggleSidebar, 'Ctrl+Alt+B')}
        {item('面板', props.panelOpen, props.onTogglePanel, 'Ctrl+J')}
        {item('状态栏', props.statusBarVisible, props.onToggleStatusBar)}
      </div>
    </div>
  )
}
