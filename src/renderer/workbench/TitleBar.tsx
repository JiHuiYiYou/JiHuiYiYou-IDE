import type { Command, MenuSpec } from '../commands/types'
import { Icon } from './icons'
import MenuBar from './MenuBar'

interface Props {
  menus: MenuSpec[]
  commands: Command[]
  onRun: (cmd: Command) => void

  /** 命令中心 —— 点开命令面板 */
  onOpenPalette: () => void

  /** 当前文件标题（显示在命令中心左边） */
  title: string

  // 右侧的开关
  blocksActive: boolean
  blocksStale: boolean
  onToggleBlocks: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  panelOpen: boolean
  onTogglePanel: () => void
  statusBarVisible: boolean
  onToggleStatusBar: () => void
  onOpenLayoutMenu: () => void

  // 后退 / 前进（文件历史）
  canGoBack: boolean
  canGoForward: boolean
  onGoBack: () => void
  onGoForward: () => void
}

/**
 * 自绘标题栏。
 *
 * ⚠️ **整条是 `-webkit-app-region: drag`** —— 靠它才能拖窗口。
 * 但拖拽区会**吞掉所有点击**，所以里面每个可交互的元素都得标
 * `-webkit-app-region: no-drag`（`.titlebar button` / `.titlebar input`）。
 *
 * ⚠️ **右侧要留 ~138px 空位** —— `titleBarOverlay` 让系统把最小化/最大化/关闭
 * 按钮**画在我们的内容上面**（右上角）。留不出位置，按钮就压到布局开关上。
 */
export default function TitleBar(props: Props) {
  return (
    <div className="titlebar">
      <div className="titlebar-logo" title="JHYY IDE">
        <span className="logo-mark">◈</span>
      </div>

      {props.menus.length > 0 && (
        <MenuBar menus={props.menus} commands={props.commands} onRun={props.onRun} />
      )}

      <div className="titlebar-nav">
        <button
          className="icon-button"
          title="后退"
          disabled={!props.canGoBack}
          onClick={props.onGoBack}
        >
          <Icon name="chevron-right" className="flip" />
        </button>
        <button
          className="icon-button"
          title="前进"
          disabled={!props.canGoForward}
          onClick={props.onGoForward}
        >
          <Icon name="chevron-right" />
        </button>
      </div>

      <button className="command-center" onClick={props.onOpenPalette} title="命令面板 (Ctrl+Shift+P)">
        <Icon name="search" className="command-center-icon" />
        <span className="command-center-text">
          {props.title ? props.title : '搜索文件 / 输入命令'}
        </span>
      </button>

      <div className="titlebar-right">
        <button
          className={props.blocksActive ? 'icon-button active' : 'icon-button'}
          title={props.blocksStale ? '块视图已过期 —— 点此重建并切换' : '切换块视图 (Ctrl+Shift+B)'}
          onClick={props.onToggleBlocks}
        >
          <Icon name="blocks" />
          {props.blocksStale && <span className="icon-badge" />}
        </button>
        <button
          className={props.sidebarOpen ? 'icon-button active' : 'icon-button'}
          title="聊天侧栏 (Ctrl+Alt+B)"
          onClick={props.onToggleSidebar}
        >
          <Icon name="chat" />
        </button>
        <button
          className={props.panelOpen ? 'icon-button active' : 'icon-button'}
          title="底部面板 (Ctrl+J)"
          onClick={props.onTogglePanel}
        >
          <Icon name="panel-bottom" />
        </button>
        <button className="icon-button" title="自定义布局" onClick={props.onOpenLayoutMenu}>
          <Icon name="layout" />
        </button>
      </div>
    </div>
  )
}
