import type { BlockTree } from '@lang/blocks/tree'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Diagnostic, RunResult, ToolchainInfo } from '@shared/jhyy'
import BlockPane from './panes/BlockPane'
import ChatPane from './panes/ChatPane'
import CodePane from './panes/CodePane'
import OutputPane from './panes/OutputPane'
import ProblemsPane from './panes/ProblemsPane'
import { blocksToSource, sourceToBlocks } from './sync/doc'

const WELCOME = `// JHYY IDE
//
// 入口是 fn main_jhyy() -> i32，返回值即进程退出码。
// 类型必须显式标注；整数与浮点之间不能隐式转换，要用 as。

extern fn printf(fmt: *u8, val: i32) -> i32;

fn fib(n: i32) -> i32 {
    if n < 2 { return n; }
    fib(n - 1) + fib(n - 2)
}

fn main_jhyy() -> i32 {
    let total = 0;
    let mut i = 0;
    while i < 10 {
        total = total + fib(i);
        i = i + 1;
    }
    printf("total = %d\\n", total);
    total
}
`

interface Status {
  text: string
  kind: 'ok' | 'bad' | 'info'
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

export default function App() {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [source, setSource] = useState(WELCOME)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [status, setStatus] = useState<Status | undefined>(undefined)

  // 块视图状态
  const [blockTree, setBlockTree] = useState<BlockTree[]>([])
  const [blocksStale, setBlocksStale] = useState(false)
  /** 当前活动的视图：'blocks' | 'code' —— 决定"谁覆盖谁" */
  const [activePane, setActivePane] = useState<'blocks' | 'code'>('code')
  /** 右侧栏当前显示哪个标签 */
  const [sideTab, setSideTab] = useState<'claude' | 'problems'>('claude')
  /** 文件在 IDE 外面被改了（比如 Claude 用 Edit 改的） */
  const [externalChange, setExternalChange] = useState<string | null>(null)

  // 启动时探测工具链，并打开命令行带来的文件
  useEffect(() => {
    void window.jhyyIde.toolchain.locate().then(setToolchain)
    void window.jhyyIde.file.initial().then((opened) => {
      if (!opened) return
      setFilePath(opened.path)
      setSource(opened.content)
      setDirty(false)
      // 块视图一开始就绪（不用等用户点"块视图"）
      setBlockTree(sourceToBlocks(opened.content).trees)
      setBlocksStale(false)
      void window.jhyyIde.file.watch(dirnameOf(opened.path))
    })
  }, [])

  // 实时诊断：改完代码 debounce 一下，跑一次"只检查不链接"的编译
  //
  // 用 `compile --no-link`：parse/sema 错误都在 codegen 之前报，链接对
  // "代码有没有错"没有额外信息，却要花 6 倍时间（gcc 链接是瓶颈）。
  const diagTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleDiagnostics = useCallback(() => {
    if (!filePath) return
    if (diagTimer.current) clearTimeout(diagTimer.current)
    diagTimer.current = setTimeout(() => {
      void window.jhyyIde.jhyy
        .compile({ file: filePath, noLink: true })
        .then((r) => setDiagnostics(r.diagnostics))
    }, 600)
  }, [filePath])

  // 文件在 IDE 外面被改了（Claude 用 Edit/Write 改的）—— 提示，不静默覆盖
  useEffect(() => {
    return window.jhyyIde.file.onChanged((path) => {
      setExternalChange((prev) => (prev === path ? prev : path))
    })
  }, [])

  const reloadFromDisk = useCallback(async () => {
    if (!externalChange) return
    const content = await window.jhyyIde.file.read(externalChange)
    setSource(content)
    setDirty(false)
    setExternalChange(null)
    const { trees } = sourceToBlocks(content)
    setBlockTree(trees)
    setBlocksStale(false)
  }, [externalChange])

  const openFile = useCallback(async () => {
    const opened = await window.jhyyIde.file.openDialog()
    if (!opened) return
    setFilePath(opened.path)
    setSource(opened.content)
    setDirty(false)
    setDiagnostics([])
    setRunResult(null)
    setStatus(undefined)
    // 打开新文件 → 块视图跟着重建
    const { trees } = sourceToBlocks(opened.content)
    setBlockTree(trees)
    setBlocksStale(false)
    void window.jhyyIde.file.watch(dirnameOf(opened.path))
  }, [])

  const saveFile = useCallback(async () => {
    if (!filePath) return
    await window.jhyyIde.file.write(filePath, source)
    setDirty(false)
    setStatus({ text: `已保存 ${filePath}`, kind: 'ok' })
  }, [filePath, source])

  /** 文本视图改了 → 源码变 → 块视图过期。 */
  const onSourceChange = useCallback(
    (code: string) => {
      setSource(code)
      setDirty(true)
      setActivePane('code')
      setBlocksStale(true)
      scheduleDiagnostics()
    },
    [scheduleDiagnostics],
  )

  /** 块视图改了 → 重新生成源码 → 写回文本视图。 */
  const onBlockChange = useCallback(
    (tree: BlockTree[]) => {
      // 块树没变就别换引用 —— 否则会触发一次没必要的重建
      setBlockTree((prev) => (JSON.stringify(prev) === JSON.stringify(tree) ? prev : tree))
      const generated = blocksToSource(tree)
      setSource(generated)
      setDirty(true)
      setBlocksStale(false)
      scheduleDiagnostics()
    },
    [scheduleDiagnostics],
  )

  /**
   * 切到块视图 —— 如果块过期了就用当前源码重建。
   *
   * 重建时机很讲究：
   * - **鼠标进入块视图区域**时重建（最自然，且不会打断正在进行的拖拽）
   * - 点「块视图」标签时重建
   * - 在块视图里按下鼠标时**不重建** —— 那会把光标底下的块换掉，拖拽直接失效
   */
  const focusBlocks = useCallback(() => {
    setActivePane('blocks')
    if (!blocksStale) return
    const { trees, parseErrors } = sourceToBlocks(source)
    setBlockTree(trees)
    setBlocksStale(false)
    if (parseErrors.length > 0) {
      setStatus({
        text: `源码有语法问题，块视图只重建了能解析的部分（${parseErrors.length} 处）`,
        kind: 'bad',
      })
    }
  }, [blocksStale, source])

  const rebuildBlocks = useCallback(() => {
    const { trees, parseErrors } = sourceToBlocks(source)
    setBlockTree(trees)
    setBlocksStale(false)
    setStatus(
      parseErrors.length > 0
        ? { text: `重建完成，但源码有 ${parseErrors.length} 处语法问题`, kind: 'bad' }
        : { text: '块视图已按源码重建', kind: 'ok' },
    )
  }, [source])

  const doCompile = useCallback(
    async (noLink: boolean) => {
      if (!filePath) {
        setStatus({ text: '先打开一个 .jhyy 文件', kind: 'bad' })
        return
      }
      if (dirty) await saveFile()
      setBusy(true)
      try {
        const result = await window.jhyyIde.jhyy.compile({ file: filePath, noLink })
        setDiagnostics(result.diagnostics)
        setRunResult(null)
        setStatus({
          text: result.ok
            ? `编译成功（${result.durationMs}ms${noLink ? '，仅检查' : ''}）`
            : `编译失败（${result.durationMs}ms）`,
          kind: result.ok ? 'ok' : 'bad',
        })
      } finally {
        setBusy(false)
      }
    },
    [dirty, filePath, saveFile],
  )

  const doRun = useCallback(async () => {
    if (!filePath) {
      setStatus({ text: '先打开一个 .jhyy 文件', kind: 'bad' })
      return
    }
    if (dirty) await saveFile()
    setBusy(true)
    setStatus({ text: '运行中…', kind: 'info' })
    try {
      const result = await window.jhyyIde.jhyy.run({ file: filePath })
      setDiagnostics(result.diagnostics)
      setRunResult(result)
      if (!result.ran) {
        setStatus({ text: '编译失败，未运行', kind: 'bad' })
      } else if (result.crashed) {
        setStatus({
          text: `程序崩溃：${result.crashName}（退出码 ${result.exitCode}）`,
          kind: 'bad',
        })
      } else if (result.exitCode === 0) {
        setStatus({ text: `运行结束，退出码 0（${result.durationMs}ms）`, kind: 'ok' })
      } else {
        setStatus({ text: `运行结束，退出码 ${result.exitCode}`, kind: 'bad' })
      }
    } finally {
      setBusy(false)
    }
  }, [dirty, filePath, saveFile])

  const stop = useCallback(async () => {
    await window.jhyyIde.jhyy.stop()
    setBusy(false)
    setStatus({ text: '已停止', kind: 'info' })
  }, [])

  const badgeClass = toolchain
    ? toolchain.available
      ? 'toolchain-badge ok'
      : 'toolchain-badge bad'
    : 'toolchain-badge'

  const badgeText = toolchain
    ? toolchain.available
      ? (toolchain.versionText ?? '工具链就绪')
      : '找不到 jhyy 编译器'
    : '探测中…'

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={() => void openFile()}>打开…</button>
        <button onClick={() => void saveFile()} disabled={!filePath || !dirty}>
          保存
        </button>
        <span className="file-path">
          {filePath ?? '（未打开文件）'}
          {dirty ? ' •' : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => void doCompile(true)} disabled={busy || !filePath}>
          检查
        </button>
        <button onClick={() => void doRun()} disabled={busy || !filePath} className="primary">
          运行
        </button>
        <button onClick={() => void stop()} disabled={!busy}>
          停止
        </button>
        <span className={badgeClass} title={toolchain?.exePath ?? ''}>
          <span className="dot" />
          {badgeText}
        </span>
      </div>

      <div className="panes-bar">
        <button
          className={activePane === 'blocks' ? 'pane-tab active' : 'pane-tab'}
          onClick={focusBlocks}
        >
          块视图
        </button>
        <button
          className={activePane === 'code' ? 'pane-tab active' : 'pane-tab'}
          onClick={() => setActivePane('code')}
        >
          文本视图
        </button>
        {blocksStale && (
          <button className="pane-tab warn" onClick={rebuildBlocks}>
            块视图已过期 · 点击重建
          </button>
        )}
        <span className="spacer" />
        <span className="pane-hint">
          {activePane === 'blocks'
            ? '在块视图里改 → 文本视图跟着更新'
            : '在文本视图里改 → 切回块视图时重建'}
        </span>
      </div>

      <div className="workspace">
        <div
          className={`pane pane-blocks${activePane === 'blocks' ? ' active' : ''}`}
          onPointerEnter={focusBlocks}
          onMouseDown={(e) => {
            // 按在块上时不重建 —— 否则光标底下的块会被换掉，拖拽直接失效
            const target = e.target as HTMLElement | null
            if (target?.closest?.('.blocklyDraggable')) return
            focusBlocks()
          }}
        >
          <BlockPane tree={blockTree} onChange={onBlockChange} />
        </div>
        <div
          className={`pane pane-code${activePane === 'code' ? ' active' : ''}`}
          onMouseDown={() => setActivePane('code')}
        >
          <CodePane value={source} onChange={onSourceChange} diagnostics={diagnostics} />
        </div>
        <div className="side-column">
          <div className="side-tabs">
            <button
              className={sideTab === 'claude' ? 'pane-tab active' : 'pane-tab'}
              onClick={() => setSideTab('claude')}
            >
              Claude Code
            </button>
            <button
              className={sideTab === 'problems' ? 'pane-tab active' : 'pane-tab'}
              onClick={() => setSideTab('problems')}
            >
              问题{diagnostics.length > 0 ? ` (${diagnostics.length})` : ''}
            </button>
          </div>
          {sideTab === 'claude' ? (
            <ChatPane
              filePath={filePath}
              externalChange={externalChange}
              onReload={() => void reloadFromDisk()}
            />
          ) : (
            <ProblemsPane diagnostics={diagnostics} />
          )}
        </div>
      </div>

      <div className="bottom-panel">
        <OutputPane
          programStdout={runResult?.programStdout ?? ''}
          programStderr={runResult?.programStderr ?? ''}
          compilerRaw={runResult?.raw ?? []}
          status={status}
        />
      </div>
    </div>
  )
}
