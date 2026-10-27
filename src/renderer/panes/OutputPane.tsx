interface Props {
  /** 程序的 stdout */
  programStdout: string
  /** 程序的 stderr */
  programStderr: string
  /** 编译器的原始 stderr 行（进度噪声等） */
  compilerRaw: string[]
  /** 状态行（退出码、耗时等） */
  status?: { text: string; kind: 'ok' | 'bad' | 'info' }
}

/** 输出面板：程序输出 + 编译器原始输出 + 状态行。 */
export default function OutputPane({ programStdout, programStderr, compilerRaw, status }: Props) {
  const hasContent = programStdout || programStderr || compilerRaw.length > 0

  return (
    <>
      <div className="pane-header">输出</div>
      <div className="pane-body">
        {!hasContent ? (
          <div className="empty">还没有输出。点「运行」试试。</div>
        ) : (
          <pre>
            {programStdout}
            {programStderr && (
              <>
                {programStdout && '\n'}
                {programStderr}
              </>
            )}
            {compilerRaw.length > 0 && (
              <>
                {(programStdout || programStderr) && '\n'}
                {compilerRaw.map((line, i) => (
                  <span key={i} className="output-line dim">
                    {line}
                    {'\n'}
                  </span>
                ))}
              </>
            )}
          </pre>
        )}
      </div>
      {status && <div className={`status-line ${status.kind}`}>{status.text}</div>}
    </>
  )
}
