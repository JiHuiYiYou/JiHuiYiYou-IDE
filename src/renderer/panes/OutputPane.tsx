/** 输出面板里的一行。 */
export interface OutputLine {
  kind: 'stdout' | 'stderr' | 'compiler' | 'error'
  text: string
}

interface Props {
  /** 累积的输出行（跨多次运行） */
  lines: OutputLine[]
}

/**
 * 输出面板 —— 程序输出 + 编译器原始输出。
 *
 * ⚠️ 以前这里是「把 stdout/stderr 当纯文本塞进一个 `<pre>`」，而
 * `styles.css` 里定义的 `.output-line.stderr` / `.output-line.error`
 * **从来没被用过**。现在改成**逐行渲染**，每行按来源上色。
 */
export default function OutputPane({ lines }: Props) {
  if (lines.length === 0) {
    return (
      <div className="pane-body output-body">
        <div className="empty">还没有输出。点「运行」试试。</div>
      </div>
    )
  }

  return (
    <div className="pane-body output-body">
      <pre className="output-pre">
        {lines.map((line, i) => (
          <span key={i} className={`output-line ${line.kind}`}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}
