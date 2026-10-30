import type { Diagnostic } from '@shared/jhyy'
import { useResizable } from '../hooks/useResizable'
import OutputPane, { type OutputLine } from '../panes/OutputPane'
import ProblemsPane from '../panes/ProblemsPane'
import TerminalPane from '../panes/TerminalPane'
import type { PanelTab } from '../state/layout'
import { Icon } from './icons'

interface Props {
  open: boolean
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  onClose: () => void
  maximized: boolean
  onToggleMaximize: () => void

  height: number
  onHeightChange: (h: number) => void

  diagnostics: Diagnostic[]
  onSelectDiagnostic: (d: Diagnostic) => void
  outputLines: OutputLine[]
  onClearOutput: () => void
  /** 终端的起始目录 */
  cwd: string
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'problems', label: '问题' },
  { id: 'output', label: '输出' },
  { id: 'terminal', label: '终端' },
]

/**
 * 底部面板 —— VS Code 的那个（问题 / 输出 / 终端）。
 *
 * ⚠️ **面板一直挂载**，折叠时只是整体 `display:none`。
 * 终端的 xterm 实例一销毁，scrollback 和 shell 状态就全没了 ——
 * 所以这里**不能**用「折叠时不渲染」的写法，DOM 结构必须始终一致。
 *
 * ⚠️ 三个页签的**内容也都一直挂载**，只有当前页签可见（`display:none`）——
 * 终端同理。切页签时终端的 ResizeObserver 会重新量尺寸。
 */
export default function PanelView(props: Props) {
  const drag = useResizable({
    onResize: props.onHeightChange,
    size: props.height,
    direction: 'horizontal',
    min: 120,
    max: 900,
    invert: true,
  })

  const cls = ['panel']
  if (!props.open) cls.push('collapsed')
  if (props.maximized) cls.push('maximized')

  return (
    <div
      className={cls.join(' ')}
      style={props.maximized || !props.open ? undefined : { height: props.height }}
    >
      <div className="panel-resize-handle" onPointerDown={drag.onPointerDown} />
      <div className="panel-header">
        <div className="panel-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={props.tab === t.id ? 'panel-tab active' : 'panel-tab'}
              onClick={() => props.onTabChange(t.id)}
            >
              {t.label}
              {t.id === 'problems' && props.diagnostics.length > 0 && (
                <span className="panel-tab-badge">{props.diagnostics.length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {props.tab === 'output' && (
            <button className="icon-button" title="清空输出" onClick={props.onClearOutput}>
              <Icon name="trash" size={14} />
            </button>
          )}
          <button
            className="icon-button"
            title={props.maximized ? '还原面板大小' : '最大化面板'}
            onClick={props.onToggleMaximize}
          >
            <Icon name={props.maximized ? 'restore' : 'maximize'} size={14} />
          </button>
          <button className="icon-button" title="关闭面板 (Ctrl+J)" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="panel-bodies">
        <div className="panel-body" style={{ display: props.tab === 'problems' ? 'flex' : 'none' }}>
          <ProblemsPane diagnostics={props.diagnostics} onSelect={props.onSelectDiagnostic} />
        </div>
        <div className="panel-body" style={{ display: props.tab === 'output' ? 'flex' : 'none' }}>
          <OutputPane lines={props.outputLines} />
        </div>
        <div className="panel-body" style={{ display: props.tab === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPane cwd={props.cwd} active={props.tab === 'terminal'} />
        </div>
      </div>
    </div>
  )
}
