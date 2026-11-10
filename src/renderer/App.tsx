import type { EditorState } from '@codemirror/state'
import type { BlockTree } from '@lang/blocks/tree'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Diagnostic, ToolchainInfo } from '@shared/jhyy'
import type { PtyBackendInfo, ShellState, TerminalInfo } from '@shared/terminal'
import BlockPane, { type BlockPaneHandle } from './panes/BlockPane'
import CodePane, { type CodePaneHandle } from './panes/CodePane'
import { createEditorState, isHistoryJump } from './editor/codemirror'
import { DocStore } from './editor/docStore'
import {
  blockViewAllowed,
  formatBytes,
  isLargeFile,
  LARGE_FILE_DISABLED_FEATURES,
  MAX_BLOCK_VIEW_BYTES,
} from './editor/largeFile'
import type { OutputLine } from './sync/output'
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
import { loadSettings, saveSettings, type Settings } from './state/settings'
import {
  clearStatus,
  clearWhenDiagnosticsClean,
  type Status,
  type StatusTag,
} from './state/status'
import { blocksToSource, isLosslessRewrite, sourceToBlocks } from './sync/doc'
import { detectEol, normalizeEol, toEol, type Eol } from './sync/caret'
import { accumulateOutput } from './sync/output'
import Breadcrumbs from './workbench/Breadcrumbs'
import CommandPalette from './workbench/CommandPalette'
import ErrorBoundary from './workbench/ErrorBoundary'
import LayoutMenu from './workbench/LayoutMenu'
import PanelView from './workbench/PanelView'
import SecondarySidebar from './workbench/SecondarySidebar'
import type { ChatPaneHandle } from './panes/ChatPane'
import SettingsDialog from './workbench/SettingsDialog'
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
 * **送进 Claude 系统提示的源码上限**（字节）—— 现在**由设置决定**。
 *
 * ⚠️ 超过这个大小就**不贴源码**了 —— 只把路径报上去，让 Claude 自己
 * `Read` 磁盘上的文件。
 *
 * ⇒ 理由：① 几 MB 的源码塞进系统提示 = 每轮对话都要重发一遍（token 爆炸）；
 *   ② Claude Code 本来就有 `Read` 工具，磁盘上那份它自己会读；
 *   ③ 唯一读不到的是「**还没保存的修改**」⇒ 那就明说，让用户先保存 ✓
 */

/**
 * 一个打开着的文件（一个标签页）。
 *
 * ⚠️⚠️ **这里没有「内容」字段** —— 文本**只存在编辑器里**
 * （`DocStore` 里的 `EditorState`）⇒
 * ⇒ 以前这里有 `source` / `saved` / `blocksAt` **三份全文副本** ⇒
 * ⇒ 一个大文件在内存里躺了四遍（还有一份在 CodeMirror 里）✗✗
 * ⇒ ⇒ 现在：**元信息在这里，内容在编辑器里** ✓
 *
 * ⚠️ **脏标记是「状态」，不是每次 render 派生的值** ——
 * 以前是 `source !== saved`（**每次 render 都全文比较一遍**）⇒
 * ⇒ 现在由 `DocStore` 算（编辑时置脏；撤销/重做时精确比一次）✓
 * ⇒ ⇒ 而且它**只在翻转的那一刻**才变 ⇒ ⇒ **打字不会引发 React 重渲染** ✓
 */
interface EditorFile {
  /** 稳定标识（磁盘文件用路径，新建文件用 untitled:N） */
  id: string
  /** 磁盘路径；新建的文件是 null */
  path: string | null
  /** 标签上显示的名字 */
  name: string
  /** 有未保存的改动（撤销回存盘点 ⇒ 自动消失，跟 VS Code 一样） */
  dirty: boolean
  /** 当前的块树（**懒建** —— 切到块视图时才建） */
  blocks: BlockTree[]
  /**
   * 这个文件在磁盘上用什么行尾 —— 存盘时照原样写回去。
   *
   * ⚠️ 编辑器里**统一用 LF**（CodeMirror 的文档里就是 LF），
   * 但存盘时要还原用户原来的行尾 —— 不然每次保存都把 CRLF 文件改成 LF。
   */
  eol: Eol
  /** 文件的字节数（主进程 stat 出来的）—— 判「大文件」用 */
  bytes: number
  /** 这个文件是不是进了「大文件模式」 */
  large: boolean
}

/**
 * ⚠️ **状态栏那条消息必须是「**当前的**问题」** ——
 *   用户报过：「右下角的状态栏不带更新的，一次编译失败就一直留着了」✗
 *   ⇒ ⇒ **问题解决了就得撤掉** ✓
 *   ⇒ ⇒ 消息的类型 + 撤除逻辑在 `state/status.ts`（纯函数，好测）✓
 */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

function nameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export default function App() {
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null)
  /**
   * 终端后端（真控制台 / 管道兜底）—— 状态栏上那个徽章。
   *
   * ⚠️ **会变** —— node-pty 起不来时会退到管道版 ⇒ 得让用户**看得见**
   *    （用户报过「终端一会真一会假的」⇒ 看不见就说不清）。
   */
  const [ptyBackend, setPtyBackend] = useState<PtyBackendInfo | null>(null)
  /**
   * **每个终端**的 shell 状态（当前目录 / 空闲与否 / 上一条命令的退出码）。
   *
   * ⚠️ **按终端 id 存** —— 多终端 ⇒ 状态不是一个，而是每个终端一份 ✓
   */
  const [shellStates, setShellStates] = useState<Record<number, ShellState>>({})
  /** 终端列表（主进程是唯一真相） */
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  /** 当前显示的是哪个终端 */
  const [activeTerminalId, setActiveTerminalId] = useState<number | null>(null)
  /**
   * **有没有东西正在跑** —— **从各终端的状态推出来**，不是自己维护的布尔。
   *
   * ⚠️⚠️ **为什么不用一个全局的 `busy`** ——
   *    以前 `busy` 是个全局布尔 ⇒ **旧的运行收场时会把「新的运行」的状态清掉**
   *    （用户点了「停止」再点「运行」就撞上了）✗
   *    ⇒ 现在**主进程是唯一真相**（每个终端自己报 `run` 状态）⇒
   *    ⇒ 老运行收场**只影响它自己那个终端** ⇒ 不会连累新的 ✓
   *    ⇒ VS Code 的模型（任务状态挂在终端上）✓
   */
  const busy = Object.values(shellStates).some((s) => s.run === 'running')
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  /**
   * **状态栏上的临时消息** —— ⚠️ **只放「出错」的消息**。
   *
   * ⚠️⚠️ **程序行为不放这儿** —— 用户明说：
   *    「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   *    ⇒ 「运行中…」「退出码 42」「降级运行…」「已保存…」**全都不显示** ✓
   *    ⇒ 运行状态改到**终端页签**上（转圈 / ✓ / ✗）✓
   *    ⇒ 编译诊断在**问题面板**里 ✓
   */
  const [status, setStatus] = useState<Status | undefined>(undefined)

  /**
   * **撤掉指定分类的状态栏消息** —— 别的分类**不动** ✓
   *
   * ⚠️ **为什么要有它** —— 用户报过：「一次编译失败就一直留着了」✗
   *   ⇒ 那条消息必须**跟着问题的存亡**走 ⇒ 问题好了就撤 ✓
   */
  const clearStatusByTag = useCallback((...tags: StatusTag[]) => {
    setStatus((prev) => clearStatus(prev, ...tags))
  }, [])

  // 打开的文件（标签页）
  const [files, setFiles] = useState<EditorFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /**
   * **文档仓库** —— 文本只存在这儿（每个文件一份 `EditorState`）。
   *
   * ⚠️⚠️ **以前 App 的 state 里存着三份全文**（`source` / `saved` / `blocksAt`），
   *   加上 CodeMirror 那一份 ⇒ 一个大文件在内存里躺了四遍 ⇒
   *   而且**每次按键**还要把整份文档重新物化一遍 ⇒ 卡 ✗✗
   * ⇒ ⇒ 现在文本**只有一份**（在编辑器里）⇒ 每次按键 **O(1)** ✓
   */
  const docStore = useMemo(() => new DocStore(), [])
  /** 新建文件的计数器 */
  const untitledCounter = useRef(0)

  // 中心区显示代码还是拖块 —— **互斥**，不同时显示
  const [centerView, setCenterView] = useState<CenterView>('code')
  /** 文件在 IDE 外面被改了（比如 Claude 用 Edit 改的） */
  const [externalChange, setExternalChange] = useState<string | null>(null)

  // 输出缓冲（跨多次运行累积）
  const [outputLines, setOutputLines] = useState<OutputLine[]>([])
  /**
   * 程序输出的「还没换行的那一段」。
   *
   * ⚠️ 程序的 stdout 是**无缓冲**的 ⇒ 一句提示（没有换行的那种）会被拆成
   * 好几段送过来 ⇒ 攒到换行才算一行，没换行的这段**单独留着显示**
   * （不然用户看不到「请输入一个数字：」）。
   */

  /*
    ⚠️⚠️ **光标位置不在 `App` 的 state 里** ——
    它在 `state/cursorStore.ts`（自己的小 store）⇒ 状态栏自己订阅 ✓
    ⇒ 光标一动（每敲一个字、每按一次方向键）**只有状态栏重渲染**，
      App 这一大棵树完全不受影响 ⇒ 不再「打字的时候整个 IDE 都跟着抖」✗
  */

  // 布局
  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  const [panelMaximized, setPanelMaximized] = useState(false)
  /** 用户设置（编辑区的字体/字号） */
  const [settings, setSettings] = useState<Settings>(loadSettings)
  /** 设置对话框开着没 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 聊天：只读模式（Claude 只给建议、不改文件） */
  const [chatReadOnly, setChatReadOnly] = useState(false)

  // 命令面板 / 布局下拉
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)

  // 文件历史（后退 / 前进）
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 })

  const codeRef = useRef<CodePaneHandle>(null)
  const blockRef = useRef<BlockPaneHandle>(null)
  /** 聊天面板 —— 「聚焦聊天」命令要把光标放进它的输入框 */
  const chatRef = useRef<ChatPaneHandle>(null)
  /** 「聚焦聊天」的请求号 —— 侧栏刚打开时输入框还没渲染出来 ⇒ 渲染完再聚焦 */
  const [chatFocusTick, setChatFocusTick] = useState(0)
  /** 块视图的重建计数 —— 错误边界点「重来一次」时 +1，整个块视图重新挂载 */
  const [blockPaneKey, setBlockPaneKey] = useState(0)
  /**
   * **块视图挂过没有** —— 第一次切到块视图时才挂 Blockly。
   *
   * ⚠️ **为什么要懒挂** —— Blockly 的工作区建起来不便宜
   *   （注入 SVG、建工具箱、注册块定义 …）⇒
   *   ⇒ 一直在文本视图里用的人**根本不该付这个钱** ✓
   */
  const [blocksMounted, setBlocksMounted] = useState(false)

  // 「聚焦聊天」⇒ 渲染完之后再把光标放进输入框
  useEffect(() => {
    if (chatFocusTick === 0) return
    chatRef.current?.focusInput()
  }, [chatFocusTick])

  // ── 派生值 ────────────────────────────────────────────────
  const active = useMemo(() => files.find((f) => f.id === activeId) ?? null, [files, activeId])
  const filePath = active?.path ?? null
  const blockTree = active?.blocks ?? EMPTY_BLOCKS
  /** 脏标记 —— **状态**（撤销回存盘点就消失，跟 VS Code 一样） */
  const dirty = active?.dirty ?? false

  // 状态镜像 —— 让命令表和回调永远读到最新值，而不用到处挂依赖
  const filePathRef = useRef(filePath)
  const busyRef = useRef(busy)
  const layoutRef = useRef(layout)
  const centerViewRef = useRef(centerView)
  const activeIdRef = useRef(activeId)
  /** 打开着的文件列表（磁盘改动检测要用） */
  const filesRef = useRef(files)
  /** 用户设置（Claude 上下文上限要从这儿读 —— 那个回调得是稳定的） */
  const settingsRef = useRef(settings)
  /**
   * 最近一次「有路径的文件」所在目录。
   *
   * ⚠️ 新建的文件（未命名）**没有路径** ⇒ Claude 的工作目录不能跟着它走
   * ⇒ 退到最近打开过的那个文件的目录（再退才是 home 目录）。
   */
  const lastPathDirRef = useRef<string | null>(null)
  useEffect(() => {
    if (filePath) lastPathDirRef.current = dirnameOf(filePath)
  }, [filePath])
  filePathRef.current = filePath
  busyRef.current = busy
  layoutRef.current = layout
  centerViewRef.current = centerView
  activeIdRef.current = activeId
  filesRef.current = files
  settingsRef.current = settings

  /**
   * 取当前缓冲区的内容 —— **只在「开始 Claude 会话」的那一刻调一次**。
   *
   * ⚠️ **这是个稳定的函数**（`useCallback(..., [])` + ref）⇒
   *   聊天面板拿到它不会因为每次按键而重渲染 ✓
   *
   * ⚠️ 太大就返回 `undefined` ⇒ 主进程会改成一句话说明
   *   「缓冲区有未保存的修改，但内容太大没带过来」—— 而不是贴一个空代码块
   *   （那是在骗 Claude）。
   */
  const getClaudeSource = useCallback((): string | undefined => {
    const id = activeIdRef.current
    if (!id) return undefined
    // ⚠️ **大文件模式 ⇒ 压根不贴源码** —— 就算上限调大了也不行
    if (docStore.isLarge(id)) return undefined
    const maxBytes = settingsRef.current.claudeContextMaxKb * 1024
    const s = docStore.text(id)
    if (s.length > maxBytes) return undefined
    return s
  }, [docStore])

  /** 改**某个**文件的某些字段（不一定是当前那个）。 */
  const updateFile = useCallback((id: string, patch: Partial<EditorFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  // 布局变了就存下来（重开窗口还是上次的样子）
  useEffect(() => {
    saveLayout(layout)
  }, [layout])

  // 设置变了就存下来（字体/字号这些是要跨窗口保留的）
  useEffect(() => {
    saveSettings(settings)
  }, [settings])

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

    ⚠️ **未命名的新文件也得报** —— 它没有路径，光看 `filePath` 分不清
    「用户没打开文件」和「用户开着一个还没保存的新文件」（用户报过：新建的
    未命名文件在聊天里显示成「没打开文件」，这不对）。⇒ 名字单独报一份，
    缓冲区**还没落盘**时把内容也带上（Claude 在磁盘上读不到它）。

    ⚠️⚠️ **这里绝不能再带整份源码** ——
    以前 `source: active.source` 在依赖数组里 ⇒ **每敲一个字**就把整个文件
    结构化克隆一次过 IPC（几 MB 的字符串！）⇒ 用户报过「IDE 特别卡」✗
    ⇒ 而且那份源码**只在会话开始时被读一次**（系统提示是烤死的，
    `jhyyCheatSheet()` 只在 `claude.start` 里调一次）⇒
    ⇒ **每次按键传它是纯浪费** ⇒ 现在走 `claude.start` 的参数（见 ChatPane）。

    ⚠️ **防抖 300 ms** —— 依赖里有 `outputLines` ⇒ 程序每打印一行就发一次 IPC ⇒
    ⇒ 攒一攒再发。
  */
  const ctxTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (ctxTimer.current) clearTimeout(ctxTimer.current)
    ctxTimer.current = setTimeout(() => {
      const unsaved = dirty || filePath === null
      window.jhyyIde.ide.setContext({
        filePath,
        fileName: active?.name ?? null,
        unsaved,
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
    }, 300)
    return () => {
      if (ctxTimer.current) clearTimeout(ctxTimer.current)
    }
  }, [filePath, active?.name, dirty, diagnostics, outputLines, chatReadOnly])

  // 启动时探测工具链，并打开命令行带来的文件
  useEffect(() => {
    void window.jhyyIde.toolchain.locate().then(setToolchain)
    void window.jhyyIde.file.initial().then((opened) => {
      if (!opened) return
      // ⚠️ 行尾统一成 LF（编辑器里是 LF），原来的行尾记下来，存盘时还原
      const eol = detectEol(opened.content)
      const content = normalizeEol(opened.content)
      const id = opened.path
      // ⚠️ **块树是懒建的** —— 打开文件时**不**解析源码 ⇒
      //   一个 10 MB 的文件打开是 O(1)（只建编辑器状态）⇒
      //   ⇒ 切到块视图时才解析（那时候用户本来就在等）✓
      const large = isLargeFile(opened.content.length, settingsRef.current.largeFileThreshold)
      docStore.open(id, makeEditorState(id, content), content, large, opened.path)
      setFiles([
        {
          id,
          path: opened.path,
          name: nameOf(opened.path),
          dirty: false,
          blocks: EMPTY_BLOCKS,
          eol,
          bytes: opened.content.length,
          large,
        },
      ])
      setActiveId(id)
      setHistory({ stack: [opened.path], index: 0 })
      void window.jhyyIde.file.watch(dirnameOf(opened.path))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 终端后端（真控制台 / 管道兜底）—— 状态栏上那个徽章。
   *
   * ⚠️ **后端会变** —— node-pty 什么时候起不来是**运行期**才知道的
   *    （原生模块加载不了、cwd 不存在、句柄不够 …）⇒
   *    用户报过「终端一会真一会假的」⇒ 徽章得**跟着变** ✓。
   */
  useEffect(() => {
    void window.jhyyIde.terminal.backend().then(setPtyBackend)
    return window.jhyyIde.terminal.onBackendChange(setPtyBackend)
  }, [])

  /**
   * **shell 的状态**（当前目录 / 空闲与否 / 上一条命令的退出码）。
   *
   * ⚠️ 这些是 **shell 自己报上来的**（OSC 633）⇒ 不是 IDE 猜的 ✓
   *    —— 跟 VS Code 一个路子。
   */
  useEffect(
    () =>
      window.jhyyIde.terminal.onState((e) =>
        setShellStates((prev) => ({ ...prev, [e.terminalId]: e.state })),
      ),
    [],
  )

  /**
   * **终端列表**（VS Code 那样：可以有多个）。
   *
   * ⚠️ **「当前是哪个」由主进程说了算** ⇒ 这里只管跟着走 ⇒
   *    不会出现「两边以为当前的不是同一个」✓
   */
  useEffect(() => {
    void window.jhyyIde.terminal.list().then((l) => {
      setTerminals(l)
      setActiveTerminalId((cur) => cur ?? l[l.length - 1]?.id ?? null)
    })
    return window.jhyyIde.terminal.onList((e) => {
      setTerminals(e.terminals)
      setActiveTerminalId(e.activeId)
    })
  }, [])

  /*
    ⚠️⚠️ **终端退出了 ⇒ 它上面的运行状态要清掉** ——
      VS Code 的模型：任务由**终端的 exit 事件**驱动收场
      （`tasks/browser/terminalTaskSystem.ts:971`）⇒
      关掉终端 ⇒ 任务结束 ⇒ **「运行中」不会永远亮着** ✓
      （用户报过：「有的终端杀掉了右上角还是在运行中」）✗
      ⇒ 以前渲染进程**根本不听** `terminalExit` ⇒ 没人知道 ⇒ 状态挂着 ✗

      ⚠️ **只清 `run`，别把整个状态删了** ——
        退出码还要留着（终端页签上那个徽章要显示它）✓
        ⇒ 而 `busy` 是从 `run === 'running'` 推出来的 ⇒ 清了它就不忙了 ✓
  */
  useEffect(() => {
    return window.jhyyIde.terminal.onExit((e) => {
      setShellStates((prev) => {
        const cur = prev[e.terminalId]
        if (!cur || cur.run !== 'running') return prev
        return { ...prev, [e.terminalId]: { ...cur, run: undefined } }
      })
    })
  }, [])

  // 实时诊断：改完代码 debounce 一下，跑一次"只检查不链接"的编译
  //
  // 用 `compile --no-link`：parse/sema 错误都在 codegen 之前报，链接对
  // "代码有没有错"没有额外信息，却要花 6 倍时间（gcc 链接是瓶颈）。
  const diagTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 后台检查是不是正在跑 */
  const diagInFlight = useRef(false)

  /**
   * 排一次后台实时诊断。
   *
   * ⚠️ **不再收「源码」参数** —— 以前是 `scheduleDiagnostics(source)`，
   *   而 `source` 是**每次按键**传进来的 ⇒ 等于**每次按键都把整份源码
   *   复制一遍**（参数按值传递）✗✗
   *   ⇒ 现在：**定时器到点时**才从仓库里取**一次** ⇒
   *   ⇒ 「每次按键」的成本降到 0 ⇒ 「每 600 ms 空闲」的成本是 1 次 ✓
   *
   * @param fileId 哪个文件
   */
  const scheduleDiagnostics = useCallback(
    (fileId: string) => {
      const path = docStore.path(fileId)
      if (!path) return
      /*
        ⚠️ **大文件模式：不做后台检查** ——
        后台检查 = 「把整份源码写进临时文件 + 起一个 `jhyy.exe` 编全文件」⇒
        ⇒ 大文件上跑一次要好几秒 ⇒ 而且**每 600 ms 空闲就一次** ⇒
        ⇒ 机器被压满 ⇒ 「IDE 卡死」✗
        ⇒ ⇒ 大文件直接不做（用户可以点「检查」手动跑）✓
      */
      if (docStore.isLarge(fileId)) return
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
          // ⚠️⚠️ **编的是「编辑器里现在这段」，不是磁盘上的旧文件** ——
          //   以前编磁盘那份 ⇒ **边打字边不报错**（改错了都看不见）✗
          //   而且诊断的行/列是旧版本的 ⇒ 波浪线落在错的行上 ✗
          .compile({
            file: path,
            contents: docStore.text(fileId),
            noLink: true,
            quiet: true,
            timeoutMs: 15_000,
          })
          .then((r) => {
            // ⚠️ **只更新当前那个文件的诊断** —— 切走了就别把别的文件的诊断盖掉
            if (activeIdRef.current !== fileId) return
            setDiagnostics(r.diagnostics)
            /*
              ⚠️⚠️ **后台诊断干净了 ⇒ 把状态栏那条「编译失败」撤掉** ——
                用户报过：「一次编译失败就一直留着了」✗
                ⇒ 用户改完代码、后台说「没错了」⇒ 状态栏还挂着「编译失败」
                ⇒ 就是**骗人** ✗ ⇒ 撤掉 ✓
                ⇒ ⚠️ **只撤「有源码诊断」的那种** —— 后台是 `--no-link`
                  ⇒ 它看不见链接错误 ⇒ 「链接失败」那条留着 ✓
            */
            setStatus((prev) => clearWhenDiagnosticsClean(prev))
          })
          .finally(() => {
            diagInFlight.current = false
          })
    }, 600)
  }, [])

  /**
   * **给一个文件建编辑器状态**（文本 + 扩展 + 回调）。
   *
   * ⚠️⚠️ **回调是「按文件」绑定的** —— 每个文件的状态里都存着自己的
   *   「文档变了」回调 ⇒ ⇒ 切标签时 `view.setState(别的文件的 state)`
   *   ⇒ ⇒ 回调也跟着换成**那个文件的** ⇒ ⇒ 分得清「是哪个文件变了」✓
   *   （VS Code 的 model ↔ view 模型：每个 model 有自己的 view state）
   *
   * ⚠️ **回调里绝对不碰内容** —— 只报「变了」⇒ **O(1)** ✓
   *   需要内容的时候（存盘 / 编译前 / 建块树）从 `docStore.text(id)` 取**一次** ✓
   */
  const makeEditorState = useCallback(
    (id: string, content: string): EditorState =>
      createEditorState(content, {
        onDocChange: (update) => {
          // ⚠️ **撤销 / 重做要精确比一次内容** ⇒ 脏标记能准确地「撤销回存盘点就消失」
          //   （普通打字不 比 ⇒ 每敲一个字都全文件比较 ⇒ 卡）✗
          const jump = isHistoryJump(update)
          const info = docStore.noteChange(id, update.state, jump)
          /*
            ⚠️⚠️ **脏标记翻转了才更新 React state** ——
              每次按键都 `setFiles` ⇒ **整棵 React 树重渲染** ⇒ 卡 ✗✗
              ⇒ ⇒ 只有 true↔false **翻转**的那一刻才通知 ⇒
              ⇒ 一个编辑会话里 **React 只重渲染一次** ✓✓
          */
          if (info.dirtyChanged) updateFile(id, { dirty: info.dirty })
          scheduleDiagnostics(id)
        },
      }),
    [docStore, scheduleDiagnostics, updateFile],
  )

  /**
   * **按当前源码重建某个文件的块树**。
   *
   * ⚠️ **这是 O(n) 的活儿** —— 解析整份源码 ⇒
   *   ⇒ 所以**只在真的要显示块视图的时候**才做 ⇒
   *   ⇒ 打开文件 / 打字都**不**做 ✓（打开一个大文件是 O(1)）
   */
  const rebuildBlocks = useCallback(
    (id: string) => {
      // ⚠️ **大文件不建块树** —— 兜底（`showBlocks` 已经拦了一道）✓
      if (docStore.isLarge(id)) return
      // ⚠️ **超出块视图硬上限的也不建** —— 同样是兜底 ✓
      const file = filesRef.current.find((f) => f.id === id)
      if (!blockViewAllowed(file?.bytes ?? 0)) return
      const source = docStore.text(id)
      const { trees, parseErrors } = sourceToBlocks(source)
      updateFile(id, { blocks: trees })
      docStore.setBlocksVersion(id, docStore.version(id))
      if (parseErrors.length > 0) {
        // ⚠️ **这是「有问题」** —— 不是程序行为 ⇒ 值得说一声 ✓
        setStatus({
          text: `源码有语法问题，块视图只重建了能解析的部分（${parseErrors.length} 处）`,
          kind: 'bad',
          // ⚠️ **这一条跟编译无关** ⇒ 编译成功**不该**把它撤掉 ✓
          tag: 'blocks',
        })
      }
    },
    [docStore, updateFile],
  )

  /**
   * **把磁盘上的内容灌回某个文件**（外部改动重载 / Claude 改完了 / 历史跳转）。
   *
   * ⚠️⚠️ **要改的是「被改动的那个文件」，不是当前活动文件！**
   *   以前这里用的是 `updateActive(...)` ⇒ 写进了**当前活动**的文件 ⇒
   *   而读的是**别的**文件的内容 ⇒
   *   **当前文件被另一个文件的内容覆盖了**（还标成「已保存」⇒ 未保存的编辑全丢）✗✗
   *   ⇒ 按 **id** 改那个文件本身 ✓
   *
   * ⚠️ **当前文件 ⇒ 走编辑器**（用户在屏幕上看着 ⇒ 得同步刷新）
   *   别的文件 ⇒ 直接换掉仓库里的状态（切过去的时候 `view.setState` 会带上）✓
   */
  const applyDiskContent = useCallback(
    (id: string, raw: string) => {
      const content = normalizeEol(raw)
      /*
        ⚠️ **问一句「视图现在显示的是不是这个文件」** ——
          切标签是「先改 `activeId`（render 时）→ 再由 effect 换视图」⇒
          ⇒ 中间有一个窗口，视图还显示着**上一个**文件 ⇒
          ⇒ 这时候往视图里写内容 ⇒ **写错文件了** ✗✗
          ⇒ ⇒ 显示着 ⇒ 走编辑器（屏幕立刻刷新，撤销历史也不乱）；
          ⇒ 不显示着 ⇒ 直接换掉仓库里的状态（切过去的时候会带上）✓
      */
      if (codeRef.current?.isShowing(id)) {
        // ⚠️ **不进撤销历史** —— 这不是用户的编辑（`addToHistory: false`）✓
        codeRef.current.setDoc(content)
      } else {
        docStore.replaceDoc(id, content)
      }
      // 磁盘上现在就是这份内容 ⇒ 不脏了
      docStore.markSaved(id, content)
      updateFile(id, { eol: detectEol(raw), dirty: false })
    },
    [docStore, updateFile],
  )

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
        const hadUnsaved = docStore.isDirty(file.id)
        void window.jhyyIde.file.read(e.path).then((raw) => {
          applyDiskContent(file.id, raw)
          if (hadUnsaved) {
            // ⚠️ **这是「数据丢了」** —— 不是程序行为 ⇒ 值得说一声 ✓
            setStatus({
              text: `Claude 改了 ${nameOf(e.path)}，这个文件里未保存的修改被覆盖了`,
              kind: 'bad',
              tag: 'claude-overwrite',
            })
          }
        })
        return
      }
      setExternalChange((prev) => (prev === e.path ? prev : e.path))
    })
  }, [applyDiskContent, docStore])

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
    const path = externalChange
    const raw = await window.jhyyIde.file.read(path)
    const file = filesRef.current.find((f) => f.path === path)
    if (file) applyDiskContent(file.id, raw)
    setExternalChange(null)
  }, [applyDiskContent, externalChange])

  /** 打开（或者切到）一个文件。 */
  const openFile = useCallback(async () => {
    const opened = await window.jhyyIde.file.openDialog()
    if (!opened) return
    const eol = detectEol(opened.content)
    const content = normalizeEol(opened.content)
    // 已经开着就别再开一个标签 —— 直接切过去
    const existing = filesRef.current.find((f) => f.path === opened.path)
    if (existing) {
      setActiveId(existing.id)
      setDiagnostics([])
      setStatus(undefined)
      return
    }
    const id = opened.path
    // ⚠️ **块树懒建** —— 打开时**不**解析源码 ⇒ 大文件打开是 O(1) ✓
    const large = isLargeFile(opened.content.length, settings.largeFileThreshold)
    docStore.open(id, makeEditorState(id, content), content, large, opened.path)
    setFiles((prev) => [
      ...prev,
      {
        id,
        path: opened.path,
        name: nameOf(opened.path),
        dirty: false,
        blocks: EMPTY_BLOCKS,
        eol,
        bytes: opened.content.length,
        large,
      },
    ])
    setActiveId(id)
    setDiagnostics([])
    // ⚠️ **清掉上一条错误消息** —— 换文件了 ⇒ 上个文件的问题不该还挂着 ✓
    //    （不然「先打开一个 .jhyy 文件」会一直挂在状态栏上 ✗）
    setStatus(undefined)

    setHistory((h) => {
      if (h.stack[h.index] === opened.path) return h
      const stack = [...h.stack.slice(0, h.index + 1), opened.path]
      return { stack, index: stack.length - 1 }
    })
    void window.jhyyIde.file.watch(dirnameOf(opened.path))
  }, [docStore, makeEditorState, settings.largeFileThreshold])

  /** 新建文件 —— 真的建一个未保存的缓冲区。 */
  const newFile = useCallback(() => {
    untitledCounter.current += 1
    const id = `untitled:${untitledCounter.current}`
    /*
      ⚠️ **未命名的新文件一上来就是「脏」的** ——
      它还没存到磁盘上 ⇒ 关掉就没了 ⇒ 标签上得有那个小圆点 ✓
      （VS Code 也是这样）
    */
    docStore.open(id, makeEditorState(id, NEW_FILE_TEMPLATE), '', false, null, true)
    setFiles((prev) => [
      ...prev,
      {
        id,
        path: null,
        name: `未命名-${untitledCounter.current}.jhyy`,
        dirty: true,
        // ⚠️ **块树懒建** —— 切到块视图时才建 ✓
        blocks: EMPTY_BLOCKS,
        eol: '\n',
        bytes: NEW_FILE_TEMPLATE.length,
        large: false,
      },
    ])
    setActiveId(id)
    setDiagnostics([])
    // ⚠️ **清掉上一条错误消息** —— 换文件了 ⇒ 上个文件的错误不该还挂着 ✓
    setStatus(undefined)
  }, [docStore, makeEditorState])

  /** 切到另一个标签页。 */
  const switchFile = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return
      setActiveId(id)
      setDiagnostics([])
      // ⚠️ **清掉上一条错误消息** ✓
      setStatus(undefined)
      setExternalChange(null)
      // 正在块视图里切文件 ⇒ 那个文件的块可能是旧的，得按新源码重建
      if (centerViewRef.current === 'blocks') {
        const file = filesRef.current.find((f) => f.id === id)
        const bytes = file?.bytes ?? 0
        /*
          ⚠️ **新文件不适合块视图 ⇒ 回文本视图** ——
            否则块视图会显示**上一个文件**的块（配着新文件的名字）⇒ 骗人 ✗
        */
        if (!blockViewAllowed(bytes)) {
          setCenterView('code')
          setStatus({
            text: `这个文件对拖块视图来说太大了（${formatBytes(bytes)}）—— 已切回文本视图`,
            kind: 'bad',
            tag: 'large-file',
          })
          return
        }
        if (docStore.blocksStale(id)) rebuildBlocks(id)
      }
    },
    [docStore, rebuildBlocks],
  )

  /** 关掉一个标签页。 */
  const closeFile = useCallback(
    (id: string) => {
      const idx = filesRef.current.findIndex((f) => f.id === id)
      if (idx === -1) return
      const next = filesRef.current.filter((f) => f.id !== id)
      // ⚠️ **连同它的撤销历史一起扔掉** —— VS Code 关标签页也是这样 ✓
      docStore.delete(id)
      setFiles(next)
      if (id === activeIdRef.current) {
        // 关掉当前标签 ⇒ 落到隔壁那个
        setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null)
      }
    },
    [docStore],
  )

  const saveAs = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    const path = await window.jhyyIde.file.saveDialog(file.name)
    if (!path) return
    const text = docStore.text(id)
    await window.jhyyIde.file.write(path, toEol(text, file.eol))
    /*
      ⚠️ **id 不变** —— 以前「另存为」会把 id 换成路径 ⇒
      ⇒ 那样的话仓库里的键也变了 ⇒ 而「文档变了」那个回调闭包里存的是**旧 id**
      ⇒ ⇒ 之后打字就找不到条目了 ⇒ **改动全丢** ✗✗
      ⇒ ⇒ 现在 **id 永远不变**（只是 `path` 变了）⇒
      ⇒ 「打开同一个文件别多出一个标签」靠**按 path 认**（`openFile` 里查 path）✓
    */
    docStore.setPath(id, path)
    docStore.markSaved(id, text)
    updateFile(id, { path, name: nameOf(path), dirty: false })
    void window.jhyyIde.file.watch(dirnameOf(path))
  }, [docStore, updateFile])

  const saveFile = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    if (!file.path) {
      await saveAs()
      return
    }
    // ⚠️ 存盘时**还原原来的行尾** —— 编辑器里统一是 LF，
    // 不还原的话每保存一次就把用户的 CRLF 文件改成 LF。
    const text = docStore.text(id)
    await window.jhyyIde.file.write(file.path, toEol(text, file.eol))
    docStore.markSaved(id, text)
    if (file.dirty) updateFile(id, { dirty: false })
  }, [docStore, saveAs, updateFile])

  /** 块视图改了 → 重新生成源码 → 写回文本视图。 */
  const onBlockChange = useCallback(
    (tree: BlockTree[]) => {
      const id = activeIdRef.current
      if (!id) return
      const current = docStore.text(id)
      const generated = blocksToSource(tree)
      /*
        ⚠️⚠️ **这次回写会改坏用户的代码 ⇒ 不许回写** ——
        块视图**会替换用户编辑器里的内容** ⇒
        块树丢掉的那些东西（泛型参数、turbofish、`#[inline]` 属性、
        源码本身有语法错误时那一堆碎片……）就**从用户的文件里消失了** ✗✗

        ⇒ 判据：**新块树打印出来 == 当前源码打印出来吗**（`isLosslessRewrite`）⇒
          不等 ⇒ **宁可不回写**，也不能把用户的代码改坏 ✓
          （用户可以回文本视图改；这条状态栏消息告诉他为什么没生效）

        ⚠️ **比的是「打印器」的输出**，不是原始文本 —— 原始文本的缩进
        跟打印器不一定一样 ⇒ 拿原始文本比会误判 ✓
      */
      if (!isLosslessRewrite(current, generated)) {
        setStatus({
          text: '这个文件里有块视图表达不了的内容（或源码有语法错误），块编辑不会写回 —— 请在文本视图里改',
          kind: 'bad',
          tag: 'blocks',
        })
        return
      }
      /*
        ⚠️ **回写走编辑器**（`replaceDoc`）⇒ 是一次**真事务** ⇒
        ⇒ 用户能 Ctrl+Z 撤掉块编辑 ✓
        ⇒ ⇒ 「文档变了」那个回调会触发 ⇒ 仓库里的内容、脏标记自动跟上 ✓
        ⇒ ⇒ **不要**在这里再手动改 `source`（已经没有那个字段了）
      */
      codeRef.current?.replaceDoc(generated)
      updateFile(id, { blocks: tree })
      // 块是**最新的** ⇒ 块视图不再过期（版本号跟上）
      docStore.setBlocksVersion(id, docStore.version(id))
      scheduleDiagnostics(id)
    },
    [docStore, scheduleDiagnostics, updateFile],
  )

  /**
   * 切到块视图 —— 如果块过期了就用当前源码重建。
   *
   * 重建时机很讲究：
   * - **切到块视图时**重建（最自然，且不会打断正在进行的拖拽）
   * - 块**可见着的时候绝不重建** —— 那会把光标底下的块换掉，拖拽直接失效
   */
  const showBlocks = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const file = filesRef.current.find((f) => f.id === id)
    const bytes = file?.bytes ?? 0
    /*
      ⚠️⚠️ **大文件模式 ⇒ 不给拖块视图** ——
        解析一份几 MB 的源码 + 反编译成几千个块 ⇒ Blockly 直接趴窝 ✗
        ⇒ ⇒ 明确告诉用户为什么没有（别让人以为是 IDE 坏了）✓
    */
    if (docStore.isLarge(id)) {
      setStatus({
        text: `这个文件太大（${formatBytes(bytes)}），拖块视图不处理它 —— 已关掉：${LARGE_FILE_DISABLED_FEATURES.join('、')}`,
        kind: 'bad',
        tag: 'large-file',
      })
      return
    }
    /*
      ⚠️ **块视图有自己的硬上限** ——
        每改一次块都要走 4 趟全文件 ⇒ 拖一个块的时候每个鼠标移动都触发一次 ⇒
        ⇒ 185 KB 的文件一次就要 100–250 ms ⇒ **拖起来是幻灯片** ✗✗
        ⇒ ⇒ 超过上限就不给块视图（拖块是给初学者/小程序的 ⇒ 够用了）✓
    */
    if (!blockViewAllowed(bytes)) {
      setStatus({
        text: `这个文件对拖块视图来说太大了（${formatBytes(bytes)}）—— 块视图最多处理 ${formatBytes(MAX_BLOCK_VIEW_BYTES)} 以内的文件`,
        kind: 'bad',
        tag: 'large-file',
      })
      return
    }
    // ⚠️ **第一次进块视图才挂 Blockly** ——
    //   Blockly 的工作区建起来不便宜（建工具箱、注入 SVG …）⇒
    //   ⇒ 一直在文本视图里用的人**根本不该付这个钱** ✓
    setBlocksMounted(true)
    if (docStore.blocksStale(id)) rebuildBlocks(id)
    setCenterView('blocks')
  }, [docStore, rebuildBlocks])

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

  /**
   * 程序的输出：**自己攒行 + 批量刷**。
   *
   * ⚠️ 程序的 stdout 是**无缓冲**的（编译器 runtime 里
   * `setvbuf(stdout, NULL, _IONBF, 0)`）⇒
   * - 一句提示会被拆成好几个片段送过来（「请输入一」/「个数」/「字: 」）
   *   ⇒ 得攒到换行符才当一行 ✓
   * - 没换行的那段（提示语）单独留着，显示成最后一行 ✓
   * - 打印多的程序会有成千上万个片段 ⇒ 不批量刷的话 React 被拖死 ✓
   */
  /** 待刷的完整行 */
  const progOutBufRef = useRef<OutputLine[]>([])
  /** 还没换行的那一段 */
  const progOutTailRef = useRef<OutputLine | null>(null)
  /** 批量刷的定时器 */
  const progOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 把攒着的程序输出刷进输出面板。 */
  const flushProgramOutput = useCallback(() => {
    progOutTimerRef.current = null
    const lines = progOutBufRef.current
    progOutBufRef.current = []
    if (lines.length > 0) pushOutput(lines)
  }, [pushOutput])

  /** 收一段程序输出。 */
  const pushProgramOutput = useCallback(
    (kind: 'stdout' | 'stderr', text: string) => {
      if (!text) return
      const prev = progOutTailRef.current
      /*
        ⚠️ stdout 和 stderr **别拼到同一行**里 ——
        上一段尾巴是 stdout、这次来的是 stderr ⇒ 尾巴自成一行，
        新的从新行开始（混在一行里没法看）。
      */
      const sameStream = prev !== null && prev.kind === kind
      const base = sameStream ? prev.text : ''
      const { lines, tail } = accumulateOutput(base, text)
      if (prev !== null && !sameStream) progOutBufRef.current.push(prev)
      for (const l of lines) progOutBufRef.current.push({ kind, text: l })
      progOutTailRef.current = tail.length > 0 ? { kind, text: tail } : null
      if (!progOutTimerRef.current) {
        progOutTimerRef.current = setTimeout(() => flushProgramOutput(), 50)
      }
    },
    [flushProgramOutput],
  )

  // 程序的实时输出（边跑边推）—— 跟 VS Code 的任务终端一样。
  //
  // ⚠️ **程序输出现在一段一段的，而且一段可能只是半行** ——
  //
  // 程序的 stdout 现在是**无缓冲**的（编译器 runtime 里
  // `setvbuf(stdout, NULL, _IONBF, 0)`）⇒ 一句提示会被拆成好几个片段送过来
  // （实测「请输入一个数字: 」= 「请输入一」/「个数」/「字: 」三截）。
  //
  // ⇒ 两件事得自己做：
  // 1. **自己攒行** —— 攒到换行符才当一行；没换行的那段（提示语就是这种）
  //    单独留着、显示成最后一行 ✓（不然用户看不到「请输入一个数字：」）。
  // 2. **批量刷** —— 无缓冲 ⇒ 打印多的程序会产生成千上万个片段 ⇒ 每个片段
  //    都 setState 一次 ⇒ React 被拖死 ⇒ 攒一批（50ms）再刷 ✓。
  useEffect(() => {
    return window.jhyyIde.jhyy.onOutput((e) => {
      pushProgramOutput(e.stream === 'stderr' ? 'stderr' : 'stdout', e.text)
    })
  }, [pushProgramOutput])

  const doCompile = useCallback(
    async (noLink: boolean) => {
      const path = filePathRef.current
      if (!path) {
        // ⚠️ **没路径** ⇒ 未命名的新文件 ⇒ 编译/运行要的是磁盘上的文件 ⇒
        //    先保存 ⇒ 提示要说清楚（别让用户以为 IDE 坏了）
        setStatus({ text: '先保存这个文件（编译/运行的是磁盘上的文件）', kind: 'bad', tag: 'file' })
        return
      }
      if (dirty) await saveFile()
      // 「检查」⇒ 弹底部面板并切到问题页
      setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'problems' }))
      try {
        const result = await window.jhyyIde.jhyy.compile({ file: path, noLink })
        setDiagnostics(result.diagnostics)
        pushOutput(result.raw.map((text) => ({ kind: 'compiler' as const, text })))
        // ⚠️ **只报「出错」** —— 编译成功是**正常的** ⇒ 不该占着状态栏
        //    （用户明说状态栏不要程序行为）⇒ 诊断在**问题面板**里 ✓
        if (!result.ok) {
          setStatus({
            text: `编译失败（${result.durationMs}ms）`,
            kind: 'bad',
            tag: 'compile',
            /*
              ⚠️ **后台检查能不能把它撤掉** ——
                后台是 `--no-link` ⇒ 它**看得见源码错误**、**看不见链接错误** ⇒
                ⇒ 只有「确实有源码诊断」的那种才让后台撤 ✓
            */
            clearsWhenDiagnosticsClean: result.diagnostics.some((d) => d.severity === 'error'),
          })
        } else {
          /*
            ⚠️⚠️ **编译成功了 ⇒ 上一条「编译失败」必须撤掉** ——
              用户报过：「一次编译失败就一直留着了」✗
              ⇒ 状态栏那条消息得**跟着问题的存亡**走 ✓
          */
          clearStatusByTag('compile')
        }
      } catch (err) {
        setStatus({
          text: `编译失败：${err instanceof Error ? err.message : String(err)}`,
          kind: 'bad',
          tag: 'compile',
          // ⚠️ **编译器压根没跑起来** ⇒ 后台检查也验证不了 ⇒ 不让后台撤 ✓
          clearsWhenDiagnosticsClean: false,
        })
      }
    },
    [clearStatusByTag, dirty, pushOutput, saveFile],
  )

  const doRun = useCallback(async () => {
    const path = filePathRef.current
    if (!path) {
      // ⚠️ **没路径** ⇒ 未命名的新文件 ⇒ 先保存 ✓
      setStatus({ text: '先保存这个文件（编译/运行的是磁盘上的文件）', kind: 'bad', tag: 'file' })
      return
    }
    if (dirty) await saveFile()

    // 「运行」⇒ 弹底部面板并切到**终端**页（VS Code 那样：程序的输出就在终端里）
    setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'terminal' }))
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
      // 程序跑完了 ⇒ 把攒着的输出（含「还没换行的那段」）立刻刷进面板
      flushProgramOutput()
      /*
        ⚠️⚠️ **只报「出错」** —— 「运行中…」「退出码 42」「已中断」这些
          **程序行为**都**不显示**（用户明说状态栏戏太多）⇒
          运行状态在**终端页签**上（转圈 / ✓ / ✗）✓

        ⚠️⚠️ **而且那条消息得跟着问题的存亡走** ——
          用户报过：「一次编译失败就一直留着了」✗
          ⇒ ⇒ **这次跑得好好的 ⇒ 把上一条撤掉** ✓
      */
      const terminalClosed = result.terminalClosed
      let failure: Status | undefined
      /*
        ⚠️⚠️ **「终端死了」要排在最前面** ——
          不然「程序没跑起来」会被误报成「编译失败，未运行」
          （其实是被关掉的终端害的）✗
      */
      if (!terminalClosed) {
        if (result.truncated) {
          // 程序在疯狂打印 ⇒ IDE 已经把它杀了（不然机器会被撑爆）
          failure = { text: '程序输出过多，已终止', kind: 'bad', tag: 'run' }
        } else if (result.timedOut) {
          // ⚠️ **超时杀的，不是「中断」** —— 杀 ConPTY 也会让程序带着
          //    0xC000013A 退出 ⇒ 不分开报的话，用户看到的还是「程序已中断」
          //    ⇒ 像是程序自己断的（其实是 IDE 超时杀的）✗
          // ⚠️ **编译那一步也可能超时**（「运行」现在在活 shell 里跑 ⇒
          //    编译是我们自己发的一条命令 ⇒ 它卡住了也得有个说法）✓
          failure = {
            text: result.ran ? '程序超时，已终止' : '编译超时，已终止',
            kind: 'bad',
            tag: 'run',
          }
        } else if (!result.ran) {
          failure = {
            text: '编译失败，未运行',
            kind: 'bad',
            tag: 'compile',
            /*
              ⚠️ **要让后台诊断能撤掉它** ——
              用户改完代码、后台检查说「没错了」⇒ 状态栏还挂着「编译失败，未运行」
              就是**骗人** ✗（这正是 `state/status.ts` 那个模块要消灭的现象）
              ⇒ 跟「检查」那条失败消息一个口径 ✓
            */
            clearsWhenDiagnosticsClean: result.diagnostics.some((d) => d.severity === 'error'),
          }
        } else if (result.crashed) {
          failure = {
            text: `程序崩溃：${result.crashName}（退出码 ${result.exitCode}）`,
            kind: 'bad',
            tag: 'run',
          }
        }
      } else {
        // ⚠️ **终端（shell）在跑的过程中死了** ⇒ 收不到「命令跑完」
        //    ⇒ **什么都不说** —— 用户自己把终端关掉的 ⇒ 他知道 ✓
        //    ⇒ 状态在**终端页签**上（✗）⇒ 状态栏不报 ✓（用户明说不要程序行为）
        //    ⇒ ⇒ **也别撤上一条**（不知道成没成 ⇒ 别乱动）✓
      }
      if (failure) {
        setStatus(failure)
      } else if (!terminalClosed) {
        // ⚠️ **这次跑得好好的 ⇒ 上一条「编译失败 / 运行失败」撤掉** ✓
        clearStatusByTag('compile', 'run')
      }
      // ⚠️⚠️ **退出码不是「对错」的判据** ——
      //    JHYY 的入口是 `fn main_jhyy() -> i32`，**它的返回值就是进程退出码**
      //    （语言仓库 `compiler/runtime/runtime.c`：`return main_jhyy(argc, argv);`）
      //    ⇒ 返回什么**由程序自己决定** ⇒ ⇒ **非 0 不等于出错** ✗
      //    （一致性门的语料里连 `// EXPECT-EXIT: 42` 都拿它当断言用！）
      // ⇒ ⇒ 所以**不能用红/绿区分**（用户明说：「退出码本身就不该是 0」）⇒
      // ⇒ ⇒ 一律**中性**，而且**根本不显示**（状态栏不要程序行为）✓
      //    真正的「出事」是上面那几条：编译失败 / 超时 / 输出过多 / **崩溃**
      //    （崩溃是 NTSTATUS，跟退出码是两码事）✓
    } catch (err) {
      /*
        ⚠️⚠️ **别把错误吞了** ——
        以前这个 `try` 只有 `finally` 没有 `catch` ⇒ IPC 一 reject
        （终端起不来、广播到已销毁的窗口 …）⇒ 异常**逃出去**
        ⇒ 状态栏永远停在「运行中…」⇒ **用户什么都不知道** ✗
        （用户报过：「点了运行没反应，也不报错」）
      */
      setStatus({
        text: `运行失败：${err instanceof Error ? err.message : String(err)}`,
        kind: 'bad',
        tag: 'run',
      })
    }
  }, [clearStatusByTag, dirty, flushProgramOutput, pushOutput, saveFile])

  const stop = useCallback(async () => {
    await window.jhyyIde.jhyy.stop()
    flushProgramOutput()
    // ⚠️ **不用 setBusy(false)** —— `busy` 是**从各终端的状态推出来的**
    //    （主进程是唯一真相）⇒ 主进程收场时报状态 ⇒ 这里不用管 ✓
  }, [flushProgramOutput])

  /*
    ⚠️⚠️ **下面这几个回调必须包一层 `useCallback`** ——
      标签条 / 聊天面板都加了 `React.memo` ⇒
      ⇒ 回调**每次渲染都是新函数**的话 ⇒ `memo` 比不出来 ⇒ **白加** ✗
      ⇒ ⇒ 包一层 ⇒ 引用稳定 ⇒ `memo` 才拦得住重渲染 ✓
  */
  const onTabRun = useCallback(() => void doRun(), [doRun])
  const onTabCheck = useCallback(() => void doCompile(true), [doCompile])
  const onTabStop = useCallback(() => void stop(), [stop])
  const onReloadExternal = useCallback(() => void reloadFromDisk(), [reloadFromDisk])

  // ── 布局开关 ────────────────────────────────────────────────
  const togglePanel = useCallback(() => {
    setLayout((l) => ({ ...l, panelOpen: !l.panelOpen }))
  }, [])

  /**
   * 新开一个终端（VS Code：Ctrl+Shift+`）。
   *
   * ⚠️ **开完把面板切到「终端」页签** —— 不然用户按了快捷键看不到反应 ✗
   */
  const newTerminal = useCallback(() => {
    void window.jhyyIde.terminal.create().then(() => {
      setLayout((l) => ({ ...l, panelOpen: true, panelTab: 'terminal' }))
    })
  }, [])

  const showPanelTab = useCallback((tab: PanelTab) => {
    setLayout((l) => ({ ...l, panelOpen: true, panelTab: tab }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setLayout((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))
  }, [])

  /**
   * **聚焦聊天**（`Ctrl+Alt+I`）—— 打开侧栏**并**把光标放进输入框。
   *
   * ⚠️ 以前这条命令挂的是 `toggleSidebar` ⇒ 侧栏开着的时候按它反而**把它关掉**
   *    （命令名是「聚焦聊天」，干的事是「切换侧栏」）✗
   */
  const focusChat = useCallback(() => {
    // ⚠️ **侧栏开着就保持开着** —— 聚焦不是切换 ✓
    setLayout((l) => ({ ...l, sidebarOpen: true }))
    // ⚠️ 侧栏刚打开 ⇒ 输入框还没渲染出来 ⇒ 用一个「请求号」让 effect 在
    //    渲染**之后**再聚焦 ✓
    setChatFocusTick((n) => n + 1)
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
        setHistory((h) => ({ ...h, index: target }))
        // ⚠️ **按 path 找那个文件** —— 它的 id 未必是 path
        //   （未命名的新文件另存为之后，id 还是 `untitled:N`）✓
        const file = filesRef.current.find((f) => f.path === path)
        if (file) {
          applyDiskContent(file.id, raw)
          setActiveId(file.id)
        }
        void window.jhyyIde.file.watch(dirnameOf(path))
      } catch (err) {
        // ⚠️ **打不开文件** —— 这是「出错」⇒ 值得说一声 ✓
        setStatus({
          text: `打不开 ${path}：${err instanceof Error ? err.message : String(err)}`,
          kind: 'bad',
          tag: 'file',
        })
      }
    },
    [applyDiskContent, history],
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
    openSettings: () => setSettingsOpen(true),
    toggleBlocks,
    togglePanel,
    showPanelTab,
    newTerminal,
    toggleSidebar,
    focusChat,
    toggleStatusBar,
    editor: () => codeRef.current,
    hasFile: () => activeIdRef.current !== null,
    hasPath: () => filePathRef.current !== null,
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
        // ⚠️ **脏标记是「状态」** —— 不是每次 render 拿全文比一次
        //   （那是一次 O(n) 的全文比较 ⇒ 打字卡）✓
        dirty: f.dirty,
        // ⚠️ **大文件模式** —— 标签上标出来（用户得知道少了几样功能）✓
        large: f.large,
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
            onRun={onTabRun}
            onCheck={onTabCheck}
            onStop={onTabStop}
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

            ⚠️⚠️ **但块视图是「懒挂载」的** ——
              Blockly 的工作区建起来不便宜（注入 SVG、建工具箱、注册块定义 …）⇒
              ⇒ **只在第一次切到块视图的时候才挂** ⇒
              ⇒ 一直在文本视图里用的人**一分钱都不付** ✓
              （挂上之后就一直留着 —— 缩放/平移/块的位置才保得住）
          */}
          <div className="editor-surface">
            <div
              className="pane-cell"
              data-hidden={centerView === 'blocks'}
              inert={centerView === 'blocks'}
            >
              <CodePane
                ref={codeRef}
                fileId={activeId}
                store={docStore}
                diagnostics={diagnostics}
                fontFamily={settings.editorFontFamily}
                fontSize={settings.editorFontSize}
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
              {blocksMounted && (
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
              )}
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
            cwd={terminalCwd}
            shellStates={shellStates}
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            onSelectTerminal={(id) => {
              setActiveTerminalId(id)
              window.jhyyIde.terminal.select(id)
            }}
            onCreateTerminal={() => {
              void window.jhyyIde.terminal.create()
            }}
            onCloseTerminal={(id) => {
              void window.jhyyIde.terminal.close(id)
            }}
          />
        </div>

        <SecondarySidebar
          ref={chatRef}
          open={layout.sidebarOpen}
          width={layout.sidebarWidth}
          onWidthChange={(w) => setLayout((l) => ({ ...l, sidebarWidth: w }))}
          filePath={filePath}
          fileName={active?.name ?? null}
          cwd={filePath ? dirnameOf(filePath) : lastPathDirRef.current}
          externalChange={externalChange}
          onReload={onReloadExternal}
          readOnly={chatReadOnly}
          onReadOnlyChange={setChatReadOnly}
          getSource={getClaudeSource}
        />
      </div>

      {layout.statusBarVisible && (
        <StatusBar
          diagnostics={diagnostics}
          toolchain={toolchain}
          ptyBackend={ptyBackend}
          message={status}
          view={centerView}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

