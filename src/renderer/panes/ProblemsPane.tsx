import type { Diagnostic } from '@shared/jhyy'

interface Props {
  diagnostics: Diagnostic[]
  onSelect?: (diagnostic: Diagnostic) => void
}

/** 问题面板：展示编译器报出的诊断。 */
export default function ProblemsPane({ diagnostics, onSelect }: Props) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  return (
    <>
      <div className="pane-header">
        问题
        <span className="count">
          {errors > 0 ? `${errors} 错误` : ''}
          {errors > 0 && warnings > 0 ? ' · ' : ''}
          {warnings > 0 ? `${warnings} 警告` : ''}
          {diagnostics.length === 0 ? '无' : ''}
        </span>
      </div>
      <div className="pane-body">
        {diagnostics.length === 0 ? (
          <div className="empty">没有诊断。</div>
        ) : (
          <ul className="problem-list">
            {diagnostics.map((d, i) => (
              <li
                key={`${d.file}:${d.line}:${d.col}:${i}`}
                className={`problem ${d.severity}`}
                onClick={() => onSelect?.(d)}
              >
                <span className="severity">{d.severity === 'error' ? '×' : '!'}</span>
                <span className="location">
                  {d.line}:{d.col}
                </span>
                <span className="message">{d.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
