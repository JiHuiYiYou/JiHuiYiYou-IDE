import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalShell,
  TerminalStateEvent,
} from '@shared/terminal'
import { TerminalSession } from './terminal'

/**
 * **终端登记表** —— 管着**多个**终端（VS Code 的模型）。
 *
 * ## 为什么要多个
 *
 * VS Code 的行为（用户点名要的）：
 * 1. 终端**可以开新的、也可以关掉的**
 * 2. **「运行」用当前那个终端**；一个都没有的话 ⇒ **新开一个**
 * 3. 反复运行 ⇒ **复用同一个**（不每次都开新的）
 *
 * ⇒ 以前 IDE 只有**一个** `terminalSession` ⇒ 只能开一个、也不能关 ✓
 * ⇒ 现在这里管着一张表 ⇒ 上面的行为都自然有了 ✓
 *
 * ## 每个终端都是独立的
 *
 * - 自己的 shell 进程（真控制台）
 * - 自己的 scrollback（渲染进程那边一个 xterm 实例）
 * - 自己的背压序号、自己的退出码、自己的当前目录
 */
export class TerminalRegistry {
  /** 活着的终端（id → 会话）。 */
  private readonly sessions = new Map<number, TerminalSession>()
  /** 终端的顺序（列表里按这个排）。 */
  private order: number[] = []
  /** 当前那个（VS Code 叫 active terminal）。 */
  private activeId: number | null = null
  private nextId = 1
  /**
   * 「跑东西」用的那些一次性终端（**按用途分**）。
   *
   * ⚠️ **为什么按用途分** —— 「检查」和「运行」是**两件事**
   *   （VS Code 里也是两个不同的 task ⇒ 两个不同的终端）⇒
   *   共用一个的话 ⇒ 点「检查」会把「运行」的输出冲掉 ✗
   */
  private readonly runTerminals = new Map<string, number>()

  constructor(
    private readonly shell: TerminalShell,
    private readonly hooks: {
      /** 有终端的输出 */
      onData: (e: TerminalDataEvent) => void
      /** 有终端退出了 */
      onExit: (e: TerminalExitEvent) => void
      /** 有终端的状态变了 */
      onState: (e: TerminalStateEvent) => void
      /** **终端列表变了**（开/关/换）⇒ 渲染进程要重画列表 */
      onListChanged: () => void
      /**
       * **某个终端被「重启」了**（复用 ⇒ shell 重启 ⇒ 屏幕要清空）✓
       *
       * ⚠️ VS Code 复用终端时会 `clearBuffer()`（`terminalTaskSystem.ts:1614`）✓
       */
      onRestart?: (terminalId: number) => void
      /**
       * 起一个终端会话（默认用真的）—— **单测塞假的进来**，
       * 免得每个测试都去起一个真 shell ✓
       */
      createSession?: (id: number, cwd: string) => TerminalSession
    },
  ) {}

  /** 终端列表（按创建顺序）。 */
  list(): TerminalInfo[] {
    return this.order.map((id) => {
      const s = this.sessions.get(id)
      return {
        id,
        // ⚠️ **有 label 就用 label** —— 一次性终端（「运行」/「检查」）⇒
        //    用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
        //    （CLAUDE.md：终端退化必须是「看得见」的）✓
        name: s?.label ?? terminalName(s?.currentShell ?? this.shell),
        shell: s?.currentShell ?? this.shell,
        cwd: s?.shellState.cwd ?? null,
      }
    })
  }

  /** 当前那个终端（没有就是 null）。 */
  active(): TerminalSession | null {
    if (this.activeId === null) return null
    return this.sessions.get(this.activeId) ?? null
  }

  /** 当前那个终端的 id。 */
  get activeTerminalId(): number | null {
    return this.activeId
  }

  /** 按 id 拿一个终端。 */
  get(id: number): TerminalSession | null {
    return this.sessions.get(id) ?? null
  }

  /**
   * **开一个新的终端**。
   *
   * ⚠️ `TerminalSession` 的构造函数**就会把 shell 起起来** ⇒
   *    所以「开终端」= 「起一个 shell 进程」✓（VS Code 也这样）
   *
   * @param opts `shellCommand` = **让 shell 跑这条命令然后退出**（VS Code 的
   *   任务终端模型：「运行」按钮走的就是这条）⇒ **一次性终端** ⇒
   *   跑完它自己退出 ⇒ **自动从列表里消失**（用户选的：跑完自动消失）✓
   */
  create(
    cwd?: string,
    opts: {
      shellCommand?: string
      initialText?: string
      shell?: TerminalShell
      /** 这是不是「跑程序用的一次性终端」？ */
      oneShot?: boolean
      /**
       * **终端在列表里显示的名字**（不给 = 用 shell 的名字）✓
       *
       * ⚠️ **一次性终端用它**（「运行」/「检查」）⇒
       *    用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
       */
      label?: string
    } = {},
  ): TerminalSession {
    const id = this.nextId++
    const shell = opts.shell ?? this.shell
    const session = this.hooks.createSession
      ? this.hooks.createSession(id, cwd ?? process.cwd())
      : new TerminalSession({
          id,
          shell,
          cwd: cwd ?? process.cwd(),
          ...(opts.shellCommand ? { shellCommand: opts.shellCommand } : {}),
          ...(opts.initialText ? { initialText: opts.initialText } : {}),
          ...(opts.label ? { label: opts.label } : {}),
          onData: (e) => this.hooks.onData({ ...e, terminalId: id }),
          onExit: (e) => {
            this.hooks.onExit({ ...e, terminalId: id })
            // ⚠️ **一次性终端退出后**留在列表里**（VS Code 的 task 终端就是这样：
            //   跑完不关 ⇒ 输出能看 ⇒ 下次跑**复用它** ⇒ `terminalTaskSystem.ts:985`）✓
            //   ⇒ 普通的交互终端退出 ⇒ 从表里去掉（用户自己 `exit` 了）✓
            if (!opts.oneShot) this.remove(id)
          },
          onState: (state) => this.hooks.onState({ terminalId: id, state }),
        })
    this.sessions.set(id, session)
    this.order.push(id)
    this.activeId = id
    this.hooks.onListChanged()
    return session
  }

  /**
   * **拿「跑程序」用的那个一次性终端**（VS Code 的 task 终端）。
   *
   * ⚠️⚠️ **同一个终端反复用** —— VS Code 的 `reuseTerminal`：
   *   跑完那条命令，**shell 就退出了** ⇒ 下次跑要**把 shell 重启一遍**
   *   （命令还是**启动参数** ⇒ 一条流、一个提示符 ✓）
   *   ⇒ VS Code：`terminalInstance.ts:1902` ✓
   *   ⇒ 好处：**终端列表不会越攒越多** ✓ 而且**反复运行不新开** ✓
   */
  runTerminal(
    kind: 'run' | 'check',
    opts: {
      shellCommand: string
      initialText?: string
      cwd: string
      shell: TerminalShell
    },
  ): TerminalSession {
    const existingId = this.runTerminals.get(kind)
    const existing = existingId === undefined ? undefined : this.sessions.get(existingId)
    /*
      ⚠️⚠️ **这个终端的名字 = 用途名**（「运行」/「检查」）——
        ⇒ 用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
        （CLAUDE.md 的规矩：终端退化必须是「看得见」的）✓
    */
    const label = kind === 'run' ? '运行' : '检查'
    if (existing) {
      // ⚠️ **旧的那个已经退出了**（命令跑完 shell 就退出）⇒ 重启它 ✓
      existing.restart(opts.shellCommand, opts.initialText)
      existing.label = label
      this.activeId = existing.id
      this.hooks.onListChanged()
      this.hooks.onRestart?.(existing.id)
      return existing
    }
    const session = this.create(opts.cwd, {
      shellCommand: opts.shellCommand,
      ...(opts.initialText ? { initialText: opts.initialText } : {}),
      shell: opts.shell,
      oneShot: true,
      label,
    })
    this.runTerminals.set(kind, session.id)
    return session
  }

  /**
   * 拿到当前那个终端；**一个都没有就新开一个**。
   *
   * ⚠️ 这就是「没有终端时运行程序会开一个新的」那条 ✓
   */
  activeOrCreate(cwd?: string): TerminalSession {
    const a = this.active()
    if (a && a.running) return a
    return this.create(cwd)
  }

  /** 关掉一个终端（杀它的 shell）。 */
  close(id: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.remove(id)
    void s.kill()
  }

  /** 从表里去掉一个（不一定杀它）。 */
  private remove(id: number): void {
    if (!this.sessions.delete(id)) return
    for (const [kind, tid] of this.runTerminals) {
      if (tid === id) this.runTerminals.delete(kind)
    }
    this.order = this.order.filter((x) => x !== id)
    if (this.activeId === id) {
      // ⚠️ 关掉当前那个 ⇒ 换成**最后剩下的那个**（VS Code 的行为）✓
      this.activeId = this.order.length > 0 ? this.order[this.order.length - 1] : null
    }
    this.hooks.onListChanged()
  }

  /** 切换当前终端。 */
  setActive(id: number): void {
    if (!this.sessions.has(id)) return
    this.activeId = id
    this.hooks.onListChanged()
  }

  /**
   * 某个终端的窗口尺寸变了。
   *
   * ⚠️ **只改这一个** —— 每个终端的 xterm 尺寸**各是各的**
   *    （隐藏着的那个尺寸还是老的）⇒ 把前台的尺寸套到所有终端上 ⇒
   *    它们的 shell 按错的宽度折行 ⇒ TUI 全花 ✗
   */
  resize(terminalId: number, cols: number, rows: number): void {
    this.sessions.get(terminalId)?.resize(cols, rows)
  }

  /** 全关掉（IDE 退出时）。 */
  async killAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    this.order = []
    this.activeId = null
    await Promise.all(all.map((s) => s.kill()))
  }
}

/** 终端在列表里显示的名字（VS Code 那样：bash / PowerShell）。 */
export function terminalName(shell: TerminalShell): string {
  switch (shell) {
    case 'powershell':
      return 'PowerShell'
    case 'cmd':
      return 'cmd'
    case 'bash':
    default:
      return 'bash'
  }
}
