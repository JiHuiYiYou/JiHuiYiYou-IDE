import { useRef } from 'react'
import type { Diagnostic } from '@shared/jhyy'
import type { ShellState, TerminalInfo } from '@shared/terminal'
import { useResizable } from '../hooks/useResizable'
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
  /** 终端的起始目录 */
  cwd: string
  /** 每个终端的 shell 状态（当前目录 / 空闲与否 / 上一条命令的退出码） */
  shellStates?: Record<number, ShellState>
  /** 终端列表（VS Code 那样：可以有多个） */
  terminals: TerminalInfo[]
  /** 当前显示的是哪个终端 */
  activeTerminalId: number | null
  onSelectTerminal: (id: number) => void
  onCreateTerminal: () => void
  onCloseTerminal: (id: number) => void
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'problems', label: '问题' },
  { id: 'terminal', label: '终端' },
]

/**
 * 底部面板 —— VS Code 的那个（问题 / 终端）。
 *
 * ⚠️ **面板一直挂载**，折叠时只是整体 `display:none`。
 * 终端的 xterm 实例一销毁，scrollback 和 shell 状态就全丢了 ——
 * 所以这里**不能**用「折叠时不渲染」的写法，DOM 结构必须始终一致。
 *
 * ⚠️ 三个页签的**内容也都一直挂载**，只有当前页签可见（`display:none`）——
 * 终端同理。切页签时终端的 ResizeObserver 会重新量尺寸。
 */
export default function PanelView(props: Props) {
  /** 面板的 DOM（拖动时直接改它的 style ⇒ 不进 React） */
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useResizable({
    /*
      ⚠️ **拖动中直接改 DOM** —— 不写 React state ⇒
      整个 React 树不会重渲染（这个项目一处 `memo` 都没有 ⇒
      不节流的话每次 pointermove 都会重渲染 CodeMirror + Blockly + ChatPane）
      ⇒ 再加上 `useEffect(saveLayout)` 每次同步写 `localStorage`
      ⇒ 拖起来卡得要死（用户报过）✗

      ⇒ 松手时才 `onCommit` ⇒ 写回 state + 存档（**一次**）✓
    */
    onResize: (h) => {
      const el = panelRef.current
      if (el) el.style.height = `${h}px`
    },
    onCommit: props.onHeightChange,
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
      ref={panelRef}
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

        {/*
          ⚠️ **终端列表放在头部右侧** —— 跟 VS Code 一个位置 ✓
          （VS Code 那边是竖排在最右边；这里横排，跟这个 IDE 的横排风格一致）
        */}
        <div className="panel-actions">
          {props.tab === 'terminal' && (
            <div className="terminal-list">
              {props.terminals.map((t) => (
                <div
                  key={t.id}
                  className={`terminal-tab${t.id === props.activeTerminalId ? ' active' : ''}`}
                  onClick={() => props.onSelectTerminal(t.id)}
                  title={t.cwd ? `终端 #${t.id}：${t.cwd}` : `终端 #${t.id}`}
                >
                  <span className="terminal-tab-name">{t.name}</span>
                  {/*
                    ⚠️ **运行状态在终端页签上**（VS Code 的 task 页签）——
                      转圈 = 正在跑 / ✓ = 跑完了 / ✗ = 挂了
                      （`tasks/browser/taskTerminalStatus.ts`）✓
                      ⇒ **不在状态栏显示**（用户明说状态栏不要程序行为）✓
                  */}
                  {props.shellStates?.[t.id]?.run === 'running' && (
                    <span className="terminal-tab-run running" title="正在运行">
                      <Icon name="loading" size={11} />
                    </span>
                  )}
                  {props.shellStates?.[t.id]?.run === 'ok' && (
                    <span className="terminal-tab-run ok" title="运行结束">
                      <Icon name="check" size={11} />
                    </span>
                  )}
                  {props.shellStates?.[t.id]?.run === 'failed' && (
                    <span className="terminal-tab-run failed" title="运行失败">
                      <Icon name="error" size={11} />
                    </span>
                  )}
                  {/*
                    上一条命令的**退出码**。

                    ⚠️⚠️ **它不是「失败」的判据** ——
                       JHYY 的入口 `fn main_jhyy() -> i32` **返回值就是退出码**
                       ⇒ 程序自己返回什么就是什么 ⇒ ⇒ 非 0 **不等于出错**
                       ⇒ ⇒ **不用红色**（用户明说）⇒ 中性色 + tooltip 说明 ✓
                  */}
                  {props.shellStates?.[t.id]?.exitCode != null &&
                    props.shellStates?.[t.id]?.exitCode !== 0 && (
                      <span
                        className="terminal-tab-badge"
                        title={`上一条命令的退出码 ${props.shellStates?.[t.id]?.exitCode}（退出码是程序自己返回的值，不等于出错）`}
                      >
                        {props.shellStates?.[t.id]?.exitCode}
                      </span>
                    )}
                  <button
                    className="terminal-tab-close"
                    title="关掉这个终端"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onCloseTerminal(t.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button className="terminal-tab-new" title="新开一个终端" onClick={props.onCreateTerminal}>
                +
              </button>
            </div>
          )}
          <button
            className="icon-button"
            title={props.maximized ? '还原面板大小' : '全屏（盖住整个编辑区）'}
            onClick={props.onToggleMaximize}
          >
            <Icon name={props.maximized ? 'restore' : 'fullscreen'} size={14} />
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
        <div className="panel-body" style={{ display: props.tab === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPane
            cwd={props.cwd}
            // ⚠️ **面板折叠着也算「看不见」** ——
            //    以前只看页签 ⇒ 面板收起来了还在报 `visible(true)`
            //    ⇒ 主进程会继续往没人看的终端补提示符 ⇒ 一堆「空提示符」✗
            active={props.open && props.tab === 'terminal'}
            terminals={props.terminals}
            activeTerminalId={props.activeTerminalId}
          />
        </div>
      </div>
    </div>
  )
}
