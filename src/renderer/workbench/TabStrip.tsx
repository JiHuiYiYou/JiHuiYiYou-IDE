import { Icon } from './icons'

export interface EditorTab {
  id: string
  name: string
  /** 有未保存的改动 */
  dirty: boolean
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
export default function TabStrip(props: Props) {
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
