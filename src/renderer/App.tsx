import type { BlockTree } from '@lang/blocks/tree'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Diagnostic, ToolchainInfo } from '@shared/jhyy'
import BlockPane, { type BlockPaneHandle } from './panes/BlockPane'
import CodePane, { type CodePaneHandle } from './panes/CodePane'
import type { OutputLine } from './panes/OutputPane'
import { createCommands, createMenus, type CommandContext } from './commands/registry'
import type { Command } from './commands/types'
import { useKeybindings } from './commands/useKeybindings'
import {
  loadLayout,
  saveLayout,
  type CenterView,
  type LayoutState,
  type PanelTab,
} from './state/layout'
import { blocksToSource, sourceToBlocks } from './sync/doc'
import { detectEol, normalizeEol, toEol, type Eol } from './sync/caret'
import Breadcrumbs from './workbench/Breadcrumbs'
import CommandPalette from './workbench/CommandPalette'
import ErrorBoundary from './workbench/ErrorBoundary'
import LayoutMenu from './workbench/LayoutMenu'
import PanelView from './workbench/PanelView'
import SecondarySidebar from './workbench/SecondarySidebar'
import StatusBar from './workbench/StatusBar'
import TabStrip, { type EditorTab } from './workbench/TabStrip'
import TitleBar from './workbench/TitleBar'
import WelcomeView from './workbench/WelcomeView'

const NEW_FILE_TEMPLATE = `// 新文件
//
// 入口是 fn main_jhyy() -> i32，返回值即进程退出码。

fn main_jhyy() -> i32 {
    0
}
`

/** 空块树 —— 每次 render 都新建一个的话，BlockPane 的 effect 会一直重跑。 */
const EMPTY_BLOCKS: BlockTree[] = []

/**
 * 输出面板最多留多少行。
 *
 * ⚠️ 必须有上限 —— 程序疯狂打印时（`while true { printf(...) }`）
 * 不能把渲染进程的内存也吃光（用户报过「整个 IDE 卡死」）。
 */
const MAX_OUTPUT_LINES = 5000

/**
 * 一个打开着的文件（一个标签页）。
 *
 * ⚠️ **脏标记不存布尔值**，而是拿「当前内容」跟「上次保存的内容」比 ——
 * VS Code 就是这么做的：撤销回保存点，小圆点自动消失。
 * 同理，「块视图已过期」也是拿源码跟「块上次重建时的源码」比。
 */
interface EditorFile {
  /** 稳定标识（磁盘文件用路径，新建文件用 untitled:N） */
  id: string
  /** 磁盘路径；新建的文件是 null */
  path: string | null
  /** 标签上显示的名字 */
  name: string
  /** 当前内容（**永远是 LF** —— 见 `normalizeEol`） */
  source: string
  /** 上次保存（或打开）时的内容 —— 脏标记靠它算 */
  saved: string
  /** 块视图最后一次重建时的源码 —— 「块已过期」靠它算 */
  blocksAt: string
  /** 当前的块树 */
  blocks: BlockTree[]
  /**
   * 这个文件在磁盘上用什么行尾 —— 存盘时照原样写回去。
   *
   * ⚠️ 编辑器里**统一用 LF**（CodeMirror 的文档里就是 LF），
   * 但存盘时要还原用户原来的行尾 —— 不然每次保存都把 CRLF 文件改成 LF。
   */
  eol: Eol
}

interface Status {
  text: string
  kind: 'ok' | 'bad' | 'info'
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

function nameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export default function App() {
  const [busy, setBusy] = useState(false)
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [status, setStatus] = useState<Status | undefined>(undefined)

  // 打开的文件（标签页）
  const [files, setFiles] = useState<EditorFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 新建文件的计数器 */
  const untitledCounter = useRef(0)

  // 中心区显示代码还是拖块 —— **互斥**，不同时显示
  const [centerView, setCenterView] = useState<CenterView>('code')
  /** 文件在 IDE 外面被改了（比如 Claude 用 Edit 改的） */
  const [externalChange, setExternalChange] = useState<string | null>(null)

  // 输出缓冲（跨多次运行累积）
  const [outputLines, setOutputLines] = useState<OutputLine[]>([])

  // 光标位置（状态栏）
  const [cursor, setCursor] = useState({ line: 1, col: 1, selectedLines: 0 })

  // 布局
  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  const [panelMaximized, setPanelMaximized] = useState(false)
  /** 聊天：只读模式（Claude 只给建议、不改文件） */
  const [chatReadOnly, setChatReadOnly] = useState(false)

  // 命令面板 / 布局下拉
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)

  // 文件历史（后退 / 前进）
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 })

  const codeRef = useRef<CodePaneHandle>(null)
  const blockRef = useRef<BlockPaneHandle>(null)
  /** 块视图的重建计数 —— 错误边界点「重来一次」时 +1，整个块视图重新挂载 */
  const [blockPaneKey, setBlockPaneKey] = useState(0)

  // ── 派生值 ────────────────────────────────────────────────
  const active = useMemo(() => files.find((f) => f.id === activeId) ?? null, [files, activeId])
  const filePath = active?.path ?? null
  const source = active?.source ?? ''
  const blockTree = active?.blocks ?? EMPTY_BLOCKS
  /** 脏标记 = 内容和上次保存的不一样 —— 撤销回保存点就自动消失（跟 VS Code 一样） */
  const dirty = active ? active.source !== active.saved : false
  /** 块视图过期 = 源码在块上次重建之后又变了 */
  const blocksStale = active ? active.source !== active.blocksAt : false

  // 状态镜像 —— 让命令表和回调永远读到最新值，而不用到处挂依赖
  const sourceRef = useRef(source)
  const blocksStaleRef = useRef(blocksStale)
  const filePathRef = useRef(filePath)
  const busyRef = useRef(busy)
  const layoutRef = useRef(layout)
  const centerViewRef = useRef(centerView)
  const activeIdRef = useRef(activeId)
  /** 打开着的文件列表（磁盘改动检测要用） */
  const filesRef = useRef(files)
  sourceRef.current = source
  blocksStaleRef.current = blocksStale
  filePathRef.current = filePath
  busyRef.current = busy
  layoutRef.current = layout
  centerViewRef.current = centerView
  activeIdRef.current = activeId
  filesRef.current = files

  /** 改当前文件的某些字段。 */
  const updateActive = useCallback((patch: Partial<EditorFile>) => {
    const id = activeIdRef.current
    if (!id) return
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  // 布局变了就存下来（重开窗口还是上次的样子）
  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  // 「已保存」小圆点 —— 让 Windows 在关闭按钮上画
  useEffect(() => {
    void window.jhyyIde.window.setEdited(dirty)
  }, [dirty])

  /*
    把 IDE 的当前状态告诉主进程（写进 Claude 的系统提示）。

    ⚠️ 用户提的：「agent 拿不到部分重要信息 —— **不知道你当前打开的是哪个文件**。
    系统提示里完全没有编辑器/IDE 的状态，只有工作目录」。

    所以这里把「当前文件 / 诊断 / 输出末尾」都报上去 ⇒ Claude 能直接回答
    「我打开的是哪个文件」「现在报了什么错」这类问题。
  */
  useEffect(() => {
    window.jhyyIde.ide.setContext({
      filePath,
      cwd: filePath ? dirnameOf(filePath) : null,
      diagnostics: diagnostics.slice(0, 20).map((d) => ({
        file: d.file,
        line: d.line,
        col: d.col,
        message: d.message,
      })),
      readOnly: chatReadOnly,
      outputTail: outputLines
        .slice(-20)
        .map((l) => l.text)
        .join('\n'),
    })
  }, [filePath, diagnostics, outputLines, chatReadOnly])

  // 启动时探测工具链，并打开命令行带来的文件
  useEffect(() => {
    void window.jhyyIde.toolchain.locate().then(setToolchain)
    void window.jhyyIde.file.initial().then((opened) => {
      if (!opened) return
      // ⚠️ 行尾统一成 LF（编辑器里是 LF），原来的行尾记下来，存盘时还原
      const eol = detectEol(opened.content)
      const content = normalizeEol(opened.content)
      const trees = sourceToBlocks(content).trees
      setFiles([
        {
          id: opened.path,
          path: opened.path,
          name: nameOf(opened.path),
          source: content,
          saved: content,
          blocksAt: content,
          blocks: trees,
          eol,
        },
      ])
      setActiveId(opened.path)
      setHistory({ stack: [opened.path], index: 0 })
      void window.jhyyIde.file.watch(dirnameOf(opened.path))
    })
  }, [])

  // 实时诊断：改完代码 debounce 一下，跑一次"只检查不链接"的编译
  //
  // 用 `compile --no-link`：parse/sema 错误都在 codegen 之前报，链接对
  // "代码有没有错"没有额外信息，却要花 6 倍时间（gcc 链接是瓶颈）。
  const diagTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 后台检查是不是正在跑 */
  const diagInFlight = useRef(false)

  const scheduleDiagnostics = useCallback(() => {
    const path = filePathRef.current
    if (!path) return
    if (diagTimer.current) clearTimeout(diagTimer.current)
    diagTimer.current = setTimeout(() => {
      // ⚠️ **别让后台检查堆积** —— 用户狂打字的时候会起一堆编译器进程，
      // CPU 被吃光（用户报过「整个 IDE 卡死」）。上一个还在跑就跳过这次。
      if (diagInFlight.current) return
      diagInFlight.current = true
      void window.jhyyIde.jhyy
        // ⚠️ `quiet: true` —— 后台实时诊断**不回显到终端**。
        // 每敲一个字就往终端里打一行 `> jhyy compile …`，终端会被刷满
        // （用户报过「都会触发就很烦人」）。
        .compile({ file: path, noLink: true, quiet: true, timeoutMs: 15_000 })
        .then((r) => setDiagnostics(r.diagnostics))
        .finally(() => {
          diagInFlight.current = false
        })
    }, 600)
  }, [])

  // 文件在磁盘上被改了。
  //
  // ⚠️ **内部改动直接应用，外部改动才提示**（用户提的）：
  // - `internal`（Claude 这个 agent 改的）⇒ 用户就是让它改的 ⇒ **直接改文件**，
  //   不用再问「要不要重新加载」。
  // - 外部程序改的 ⇒ 提示「文件在外部被修改了」，让用户决定。
  useEffect(() => {
    return window.jhyyIde.file.onChanged((e) => {
      const file = filesRef.current.find((f) => f.path === e.path)
      if (!file) return // 不是开着的文件 —— 不用管
      if (e.internal) {
        // 本地有未保存的改动 ⇒ 会被覆盖（用户明确说了「直接改文件就好」），
        // 但要说一声，别让人以为自己的编辑还在。
        const hadUnsaved = file.source !== file.saved
        void window.jhyyIde.file.read(e.path).then((raw) => {
          const content = normalizeEol(raw)
          setFiles((prev) =>
            prev.map((f) =>
              f.path === e.path
                ? {
                    ...f,
                    source: content,
                    saved: content,
                    blocksAt: content,
                    blocks: sourceToBlocks(content).trees,
                    eol: detectEol(raw),
                  }
                : f,
            ),
          )
          if (hadUnsaved) {
            setStatus({
              text: `Claude 改了 ${nameOf(e.path)}，这个文件里未保存的修改被覆盖了`,
              kind: 'bad',
            })
          }
        })
        return
      }
      setExternalChange((prev) => (prev === e.path ? prev : e.path))
    })
  }, [])

  // IDE 自己跑了一条命令 —— 终端里已经显示了。
  // 只有「运行」才把面板切过去（程序输出就在终端里，跟 VS Code 一样）；
  // 「检查」不切 —— 用户是来看诊断的，别把面板抢走。
  useEffect(() => {
    return window.jhyyIde.terminal.onCommand((e) => {
      if (!e.focus) return
      setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'terminal' }))
    })
  }, [])

  const reloadFromDisk = useCallback(async () => {
    if (!externalChange) return
    const raw = await window.jhyyIde.file.read(externalChange)
    // ⚠️ 行尾统一成 LF（编辑器里是 LF）
    const content = normalizeEol(raw)
    updateActive({
      source: content,
      saved: content,
      blocksAt: content,
      blocks: sourceToBlocks(content).trees,
      eol: detectEol(raw),
    })
    setExternalChange(null)
  }, [externalChange, updateActive])

  /** 打开（或者切到）一个文件。 */
  const openFile = useCallback(async () => {
    const opened = await window.jhyyIde.file.openDialog()
    if (!opened) return
    const eol = detectEol(opened.content)
    const content = normalizeEol(opened.content)
    setFiles((prev) => {
      // 已经开着就别再开一个标签 —— 直接切过去
      if (prev.some((f) => f.path === opened.path)) return prev
      return [
        ...prev,
        {
          id: opened.path,
          path: opened.path,
          name: nameOf(opened.path),
          source: content,
          saved: content,
          blocksAt: content,
          blocks: sourceToBlocks(content).trees,
          eol,
        },
      ]
    })
    setActiveId(opened.path)
    setDiagnostics([])
    setStatus(undefined)
    setHistory((h) => {
      if (h.stack[h.index] === opened.path) return h
      const stack = [...h.stack.slice(0, h.index + 1), opened.path]
      return { stack, index: stack.length - 1 }
    })
    void window.jhyyIde.file.watch(dirnameOf(opened.path))
  }, [])

  /** 新建文件 —— 真的建一个未保存的缓冲区。 */
  const newFile = useCallback(() => {
    untitledCounter.current += 1
    const id = `untitled:${untitledCounter.current}`
    setFiles((prev) => [
      ...prev,
      {
        id,
        path: null,
        name: `未命名-${untitledCounter.current}.jhyy`,
        source: NEW_FILE_TEMPLATE,
        saved: '',
        // ⚠️ `blocksAt` 要等于当前源码 —— 不然状态栏会一直显示「块视图已过期」
        // （新建的文件里块**已经是**按这份源码建好的）。
        blocksAt: NEW_FILE_TEMPLATE,
        blocks: sourceToBlocks(NEW_FILE_TEMPLATE).trees,
        eol: '\n',
      },
    ])
    setActiveId(id)
    setDiagnostics([])
    setStatus(undefined)
  }, [])

  /** 切到另一个标签页。 */
  const switchFile = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return
      setActiveId(id)
      setDiagnostics([])
      setStatus(undefined)
      setExternalChange(null)
      // 正在块视图里切文件 ⇒ 那个文件的块是旧的，得按新源码重建
      if (centerViewRef.current === 'blocks') {
        const file = files.find((f) => f.id === id)
        if (file && file.source !== file.blocksAt) {
          const { trees } = sourceToBlocks(file.source)
          setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, blocks: trees, blocksAt: file.source } : f)))
        }
      }
    },
    [files],
  )

  /** 关掉一个标签页。 */
  const closeFile = useCallback(
    (id: string) => {
      const idx = files.findIndex((f) => f.id === id)
      if (idx === -1) return
      const next = files.filter((f) => f.id !== id)
      setFiles(next)
      if (id === activeIdRef.current) {
        // 关掉当前标签 ⇒ 落到隔壁那个
        setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null)
      }
    },
    [files],
  )

  const saveFile = useCallback(async () => {
    const file = files.find((f) => f.id === activeIdRef.current)
    if (!file) return
    if (!file.path) {
      await saveAs()
      return
    }
    // ⚠️ 存盘时**还原原来的行尾** —— 编辑器里统一是 LF，
    // 不还原的话每保存一次就把用户的 CRLF 文件改成 LF。
    await window.jhyyIde.file.write(file.path, toEol(file.source, file.eol))
    updateActive({ saved: file.source })
    setStatus({ text: `已保存 ${file.path}`, kind: 'ok' })
  }, [files, updateActive])

  const saveAs = useCallback(async () => {
    const file = files.find((f) => f.id === activeIdRef.current)
    if (!file) return
    const path = await window.jhyyIde.file.saveDialog(file.name)
    if (!path) return
    await window.jhyyIde.file.write(path, toEol(file.source, file.eol))
    // 未保存的文件存盘后，把 id 换成路径 —— 这样以后再打开同一个文件
    // 不会多出一个标签页
    const id = file.path ? file.id : path
    updateActive({ id, path, name: nameOf(path), saved: file.source })
    if (id !== file.id) setActiveId(id)
    void window.jhyyIde.file.watch(dirnameOf(path))
    setStatus({ text: `已保存 ${path}`, kind: 'ok' })
  }, [files, updateActive])

  /** 文本视图改了 → 源码变 → 块视图过期。 */
  const onSourceChange = useCallback(
    (code: string) => {
      updateActive({ source: code })
      scheduleDiagnostics()
    },
    [scheduleDiagnostics, updateActive],
  )

  /** 块视图改了 → 重新生成源码 → 写回文本视图。 */
  const onBlockChange = useCallback(
    (tree: BlockTree[]) => {
      const generated = blocksToSource(tree)
      // 块是**最新的** ⇒ 块视图不再过期（blocksAt 跟着源码走）
      updateActive({ source: generated, blocksAt: generated, blocks: tree })
      scheduleDiagnostics()
    },
    [scheduleDiagnostics, updateActive],
  )

  /**
   * 切到块视图 —— 如果块过期了就用当前源码重建。
   *
   * 重建时机很讲究：
   * - **切到块视图时**重建（最自然，且不会打断正在进行的拖拽）
   * - 块**可见着的时候绝不重建** —— 那会把光标底下的块换掉，拖拽直接失效
   */
  const showBlocks = useCallback(() => {
    if (blocksStaleRef.current) {
      const { trees, parseErrors } = sourceToBlocks(sourceRef.current)
      updateActive({ blocks: trees, blocksAt: sourceRef.current })
      if (parseErrors.length > 0) {
        setStatus({
          text: `源码有语法问题，块视图只重建了能解析的部分（${parseErrors.length} 处）`,
          kind: 'bad',
        })
      }
    }
    setCenterView('blocks')
  }, [updateActive])

  const toggleBlocks = useCallback(() => {
    if (centerViewRef.current === 'blocks') {
      setCenterView('code')
    } else {
      showBlocks()
    }
  }, [showBlocks])

  const pushOutput = useCallback((lines: OutputLine[]) => {
    if (lines.length === 0) return
    setOutputLines((prev) => {
      const next = [...prev, ...lines]
      // ⚠️ **缓冲要有上限** —— 程序疯狂打印时不能把渲染进程也撑爆
      //（用户报过「运行 while true 的程序整个 IDE 卡死」）。
      // 丢最旧的行，跟终端的滚动缓冲一个思路。
      return next.length > MAX_OUTPUT_LINES ? next.slice(next.length - MAX_OUTPUT_LINES) : next
    })
  }, [])

  // 程序的实时输出（边跑边推）—— 跟 VS Code 的任务终端一样。
  useEffect(() => {
    return window.jhyyIde.jhyy.onOutput((e) => {
      for (const line of splitLines(e.text)) {
        pushOutput([{ kind: e.stream === 'stderr' ? 'stderr' : 'stdout', text: line }])
      }
    })
  }, [pushOutput])

  const doCompile = useCallback(
    async (noLink: boolean) => {
      const path = filePathRef.current
      if (!path) {
        setStatus({ text: '先打开一个 .jhyy 文件', kind: 'bad' })
        return
      }
      if (dirty) await saveFile()
      setBusy(true)
      // 「检查」⇒ 弹底部面板并切到问题页
      setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'problems' }))
      try {
        const result = await window.jhyyIde.jhyy.compile({ file: path, noLink })
        setDiagnostics(result.diagnostics)
        pushOutput(result.raw.map((text) => ({ kind: 'compiler' as const, text })))
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
    [dirty, pushOutput, saveFile],
  )

  const doRun = useCallback(async () => {
    const path = filePathRef.current
    if (!path) {
      setStatus({ text: '先打开一个 .jhyy 文件', kind: 'bad' })
      return
    }
    if (dirty) await saveFile()
    setBusy(true)
    setStatus({ text: '运行中…', kind: 'info' })
    // 「运行」⇒ 弹底部面板并切到输出页
    setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'output' }))
    try {
      const result = await window.jhyyIde.jhyy.run({ file: path })
      setDiagnostics(result.diagnostics)
      const lines: OutputLine[] = []
      // ⚠️ 程序的 stdout/stderr 已经**流式**推过来了（`jhyy.onOutput`），
      // 这里**不要**再推一遍 —— 否则输出会重复。
      for (const line of result.raw) lines.push({ kind: 'compiler', text: line })
      for (const d of result.diagnostics) {
        lines.push({ kind: 'error', text: `${d.file}:${d.line}:${d.col}: ${d.message}` })
      }
      pushOutput(lines)
      if (result.truncated) {
        // 程序在疯狂打印 ⇒ IDE 已经把它杀了（不然机器会被撑爆）
        setStatus({ text: '程序输出过多，已终止', kind: 'bad' })
      } else if (!result.ran) {
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
  }, [dirty, pushOutput, saveFile])

  const stop = useCallback(async () => {
    await window.jhyyIde.jhyy.stop()
    setBusy(false)
    setStatus({ text: '已停止', kind: 'info' })
  }, [])

  // ── 布局开关 ────────────────────────────────────────────────
  const togglePanel = useCallback(() => {
    setLayout((l) => ({ ...l, panelOpen: !l.panelOpen }))
  }, [])

  const showPanelTab = useCallback((tab: PanelTab) => {
    setLayout((l) => ({ ...l, panelOpen: true, panelTab: tab }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setLayout((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))
  }, [])

  const toggleStatusBar = useCallback(() => {
    setLayout((l) => ({ ...l, statusBarVisible: !l.statusBarVisible }))
  }, [])

  const toggleMenuBar = useCallback(() => {
    setLayout((l) => ({ ...l, menuBarVisible: !l.menuBarVisible }))
  }, [])

  /** 点问题列表的一条 → 跳到编辑器对应位置。 */
  const revealDiagnostic = useCallback((d: Diagnostic) => {
    // 在块视图里点问题 —— 先切回代码视图
    if (centerViewRef.current === 'blocks') setCenterView('code')
    // 等视图切完（隐藏的那格是 inert 的）再跳
    requestAnimationFrame(() => {
      codeRef.current?.revealLine(d.line, d.col)
    })
  }, [])

  // ── 后退 / 前进（文件历史） ──────────────────────────────────
  const goToHistory = useCallback(
    async (delta: number) => {
      const target = history.index + delta
      if (target < 0 || target >= history.stack.length) return
      const path = history.stack[target]
      try {
        const raw = await window.jhyyIde.file.read(path)
        const content = normalizeEol(raw)
        setHistory((h) => ({ ...h, index: target }))
        setFiles((prev) =>
          prev.map((f) =>
            f.path === path
              ? {
                  ...f,
                  source: content,
                  saved: content,
                  blocksAt: content,
                  blocks: sourceToBlocks(content).trees,
                  eol: detectEol(raw),
                }
              : f,
          ),
        )
        setActiveId(path)
        void window.jhyyIde.file.watch(dirnameOf(path))
      } catch {
        setStatus({ text: `打不开 ${path}`, kind: 'bad' })
      }
    },
    [history],
  )

  // ── 命令表 ──────────────────────────────────────────────────
  const menus = useMemo(() => createMenus(), [])

  const ctxRef = useRef<CommandContext>(null!)
  ctxRef.current = {
    newFile,
    openFile,
    saveFile,
    saveAs,
    closeFile: () => {
      const id = activeIdRef.current
      if (id) closeFile(id)
    },
    compile: () => void doCompile(true),
    run: () => void doRun(),
    stop: () => void stop(),
    showCommandPalette: () => setPaletteOpen(true),
    toggleBlocks,
    togglePanel,
    showPanelTab,
    toggleSidebar,
    toggleStatusBar,
    editor: () => codeRef.current,
    hasFile: () => filePathRef.current !== null,
    isBusy: () => busyRef.current,
    isBlocksView: () => centerViewRef.current === 'blocks',
    isPanelOpen: () => layoutRef.current.panelOpen,
    isSidebarOpen: () => layoutRef.current.sidebarOpen,
    activePanelTab: () => (layoutRef.current.panelOpen ? layoutRef.current.panelTab : null),
  }

  const commands = useMemo(() => createCommands(ctxRef), [])

  useKeybindings(commands)

  const runCommand = useCallback((cmd: Command) => {
    if (cmd.enabled && !cmd.enabled()) return
    void cmd.run()
  }, [])

  // 终端的起始目录 = 当前打开的文件所在目录
  const terminalCwd = useMemo(() => (filePath ? dirnameOf(filePath) : ''), [filePath])

  const tabs: EditorTab[] = useMemo(
    () =>
      files.map((f) => ({
        id: f.id,
        name: f.name,
        dirty: f.source !== f.saved,
        active: f.id === activeId,
      })),
    [files, activeId],
  )

  return (
    <div className="app">
      <TitleBar
        menus={layout.menuBarVisible ? menus : []}
        commands={commands}
        onRun={runCommand}
        onOpenPalette={() => setPaletteOpen(true)}
        title={active?.name ?? ''}
        blocksActive={centerView === 'blocks'}
        blocksStale={blocksStale}
        onToggleBlocks={toggleBlocks}
        sidebarOpen={layout.sidebarOpen}
        onToggleSidebar={toggleSidebar}
        panelOpen={layout.panelOpen}
        onTogglePanel={togglePanel}
        statusBarVisible={layout.statusBarVisible}
        onToggleStatusBar={toggleStatusBar}
        onOpenLayoutMenu={() => setLayoutMenuOpen((v) => !v)}
        canGoBack={history.index > 0}
        canGoForward={history.index < history.stack.length - 1}
        onGoBack={() => void goToHistory(-1)}
        onGoForward={() => void goToHistory(1)}
      />

      <LayoutMenu
        open={layoutMenuOpen}
        onClose={() => setLayoutMenuOpen(false)}
        menuBarVisible={layout.menuBarVisible}
        statusBarVisible={layout.statusBarVisible}
        sidebarOpen={layout.sidebarOpen}
        panelOpen={layout.panelOpen}
        onToggleMenuBar={toggleMenuBar}
        onToggleStatusBar={toggleStatusBar}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
      />

      <div className="workbench">
        <div className="editor-area">
          <TabStrip
            tabs={tabs}
            onSelect={switchFile}
            onClose={closeFile}
            onRun={() => void doRun()}
            onCheck={() => void doCompile(true)}
            onStop={() => void stop()}
            busy={busy}
            canRun={filePath !== null}
          />
          <Breadcrumbs filePath={filePath} view={centerView} />

          {/*
            ⚠️ 代码和拖块**同时挂载**，靠 `visibility: hidden` + `inert` 藏掉不 active 的那个。
            - `visibility:hidden` **保留布局盒子** ⇒ Blockly 的 `offsetWidth` 一直是真实值，
              `svgResize` 才算得对；用 `display:none` 会把它变成 0，SVG 被设成 0×0。
            - `inert` 把隐藏的那棵子树移出 a11y 树并禁止聚焦。
            - 两个面板都活着 ⇒ Blockly 的缩放/平移、CodeMirror 的撤销历史都保得住。
          */}
          <div className="editor-surface">
            <div
              className="pane-cell"
              data-hidden={centerView === 'blocks'}
              inert={centerView === 'blocks'}
            >
              <CodePane
                ref={codeRef}
                value={source}
                onChange={onSourceChange}
                diagnostics={diagnostics}
                onCursorChange={setCursor}
              />
            </div>
            <div
              className="pane-cell"
              data-hidden={centerView === 'code'}
              inert={centerView === 'code'}
            >
              {/*
                错误边界 —— Blockly 偶尔会抛
                （"The block associated with the block move event could not be found"）。
                没有边界的话，一个块视图的异常会把**整个应用**炸掉。
                「重来一次」= 换 key 把块视图整个重建。
              */}
              <ErrorBoundary
                label="块视图"
                onRetry={() => setBlockPaneKey((k) => k + 1)}
              >
                <BlockPane
                  key={blockPaneKey}
                  ref={blockRef}
                  tree={blockTree}
                  onChange={onBlockChange}
                />
              </ErrorBoundary>
            </div>
            {files.length === 0 && (
              <WelcomeView onOpen={() => void openFile()} onNew={newFile} />
            )}
          </div>

          {/*
            底部面板**只在编辑器下面** —— 跟 VS Code 一样。
            聊天侧栏是**整列**的（从标题栏一直到底部状态栏），
            面板开合不会把它压小。
          */}
          <PanelView
            open={layout.panelOpen}
            tab={layout.panelTab}
            onTabChange={(tab) => setLayout((l) => ({ ...l, panelTab: tab }))}
            onClose={() => setLayout((l) => ({ ...l, panelOpen: false }))}
            maximized={panelMaximized}
            onToggleMaximize={() => setPanelMaximized((v) => !v)}
            height={layout.panelHeight}
            onHeightChange={(h) => setLayout((l) => ({ ...l, panelHeight: h }))}
            diagnostics={diagnostics}
            onSelectDiagnostic={revealDiagnostic}
            outputLines={outputLines}
            onClearOutput={() => setOutputLines([])}
            cwd={terminalCwd}
          />
        </div>

        <SecondarySidebar
          open={layout.sidebarOpen}
          width={layout.sidebarWidth}
          onWidthChange={(w) => setLayout((l) => ({ ...l, sidebarWidth: w }))}
          filePath={filePath}
          externalChange={externalChange}
          onReload={() => void reloadFromDisk()}
          readOnly={chatReadOnly}
          onReadOnlyChange={setChatReadOnly}
        />
      </div>

      {layout.statusBarVisible && (
        <StatusBar
          cursor={cursor}
          diagnostics={diagnostics}
          toolchain={toolchain}
          message={status}
          view={centerView}
          blocksStale={blocksStale}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}

function splitLines(text: string): string[] {
  if (!text) return []
  return text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0)
}
