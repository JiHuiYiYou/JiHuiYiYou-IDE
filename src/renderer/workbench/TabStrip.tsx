import { memo } from 'react'
import { Icon } from './icons'

export interface EditorTab {
  id: string
  name: string
  /** 有未保存的改动 */
  dirty: boolean
  /**
   * **进了「大文件模式」** —— 后台检查 / 拖块视图 / 送源码给 Claude 都关了。
   *
   * ⚠️ **要在标签上标出来** —— 用户得知道「为什么这个文件没有块视图」✓
   */
  large?: boolean
  active: boolean
}

interface Props {
  tabs: EditorTab[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** 右上角的编辑器动作按钮 */
  onRun: () => void
  onCheck: () => void
  onStop: () => void
  busy: boolean
  canRun: boolean
}

/**
 * 编辑器标签条 —— VS Code 的那一行。
 *
 * 左边是**文件标签**（多个，可以来回切），右边是编辑器动作按钮
 * （检查 / 运行 / 停止）。
 *
 * ⚠️ 这里**没有**块视图按钮 —— 标题栏已经有一个了（🧩），重复。
 */
function TabStrip(props: Props) {
  return (
    <div className="tab-strip">
      <div className="tab-strip-tabs">
        {props.tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.active ? 'editor-tab active' : 'editor-tab'}
            onClick={() => props.onSelect(tab.id)}
            title={tab.name}
          >
            <span className="editor-tab-icon">
              <Icon name="file" size={14} />
            </span>
            <span className="editor-tab-label">{tab.name}</span>
            {/*
              ⚠️ **脏标记和 × 要同时存在** —— 以前脏的时候只画小圆点、
              根本不画 ×，于是「未命名」那种没保存过的文件**根本关不掉**
              （用户报过）。VS Code 的做法是：脏的时候显示圆点，
              **鼠标移上去**圆点变成 ×。
            */}
            {tab.dirty && <span className="editor-tab-dirty" title="有未保存的改动" />}
            {/*
              ⚠️ **大文件模式的标记** ——
              这个文件太大 ⇒ IDE 自动关掉了后台实时检查、拖块视图，
              还有「把整份源码送进 Claude」⇒
              ⇒ 用户得看得见（不然会以为是 IDE 坏了）✓
            */}
            {tab.large && (
              <span
                className="editor-tab-large"
                title="大文件模式：后台实时检查、拖块视图、送源码给 Claude 都已关掉"
              >
                大
              </span>
            )}
            <button
              className="editor-tab-close"
              title="关闭"
              onClick={(e) => {
                e.stopPropagation()
                props.onClose(tab.id)
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="tab-strip-actions">
        <button
          className="icon-button"
          title="检查 (Ctrl+Shift+D)"
          disabled={!props.canRun || props.busy}
          onClick={props.onCheck}
        >
          <Icon name="check" />
        </button>
        <button
          className="icon-button"
          title="运行 (F5)"
          disabled={!props.canRun || props.busy}
          onClick={props.onRun}
        >
          <Icon name="play" />
        </button>
        <button
          className="icon-button"
          title="停止 (Shift+F5)"
          disabled={!props.busy}
          onClick={props.onStop}
        >
          <Icon name="stop" />
        </button>
      </div>
    </div>
  )
}

/**
 * ⚠️ **要 `memo`** —— 标签条每次渲染都要把**每个标签**重新画一遍 ⇒
 *   `App` 因为别的事重渲染时（诊断更新 …）它**不该**跟着画 ✓
 *
 * ⚠️ **前提：回调得是稳定的** —— `App` 里那几个 `onSelect` / `onClose` …
 *   都得是 `useCallback` ⇒ 不然每次都是新函数 ⇒ `memo` 白加 ✗
 */
export default memo(TabStrip)
