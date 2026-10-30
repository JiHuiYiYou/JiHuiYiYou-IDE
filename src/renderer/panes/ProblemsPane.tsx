import type { Diagnostic } from '@shared/jhyy'
import { Icon } from '../workbench/icons'

interface Props {
  diagnostics: Diagnostic[]
  onSelect?: (diagnostic: Diagnostic) => void
}

/**
 * 问题面板 —— 编译器报出的诊断。
 *
 * 点一条会跳到编辑器对应位置（`onSelect` 由 App 接上 → `CodePane.revealLine`）。
 */
export default function ProblemsPane({ diagnostics, onSelect }: Props) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  return (
    <div className="pane-body problems-body">
      {diagnostics.length === 0 ? (
        <div className="empty">未在工作区检测到问题。</div>
      ) : (
        <ul className="problem-list">
          {diagnostics.map((d, i) => (
            <li
              key={`${d.file}:${d.line}:${d.col}:${i}`}
              className={`problem ${d.severity}`}
              onClick={() => onSelect?.(d)}
              title="点击跳到该位置"
            >
              <span className="severity">
                <Icon name={d.severity === 'error' ? 'error' : 'warning'} size={14} />
              </span>
              <span className="message">{d.message}</span>
              <span className="location">
                {d.file ? `${fileNameOf(d.file)}:` : ''}
                {d.line}:{d.col}
              </span>
            </li>
          ))}
        </ul>
      )}
      {diagnostics.length > 0 && (
        <div className="problems-summary">
          {errors} 错误 · {warnings} 警告
        </div>
      )}
    </div>
  )
}

function fileNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}
