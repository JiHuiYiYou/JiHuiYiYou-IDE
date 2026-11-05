import type { TerminalShell } from '@shared/terminal'
import type { PtySession } from './pty'
import { NodePtySession, tryLoadNodePty } from './ptyNode'

/**
 * **pty 宿主**的核心逻辑 —— 跑在一个**独立的 Node 进程**里
 * （Electron 的 `utilityProcess`，见 `ptyHost.ts`）。
 *
 * ## 为什么要有这个进程
 *
 * VS Code 的终端是**三层**的：
 *
 * ```
 * 渲染进程（workbench） ──IPC──▶ 共享进程 ──IPC──▶ pty 宿主进程 ──▶ shell
 * ```
 *
 * 那个「pty 宿主进程」存在的理由有两条，都很硬：
 *
 * 1. **node-pty 崩了不会把 IDE 带走** —— 它是原生模块，段错误就是整个
 *    Electron 进程死 ⇒ 用户的文件、Claude 会话、终端**全丢**。
 *    挪到独立进程里，它崩了只是终端没了，IDE 还活着 ✓
 * 2. **pty 的 I/O 不占主进程的事件循环** —— 主进程还管着编译器、
 *    Claude CLI、文件监听 ⇒ 终端狂打输出时不该把它们一起拖死 ✓
 *
 * ## 这一层为什么单独拆出来
 *
 * 「跟宿主进程说话」的那套协议（请求 / 事件）跟 Electron 没关系 ⇒
 * 抽到这里 ⇒ **能在 Node 里直接单测**（不用起 Electron）✓
 * Electron 那层只剩薄薄一层胶水（`ptyHost.ts`）✓
 */

/** 起一个 pty 要什么。 */
export interface PtyHostSpec {
  /** 用哪个 shell */
  shell: TerminalShell
  /** 起始目录 */
  cwd: string
  /** 初始窗口大小 */
  cols: number
  rows: number
  /**
   * **已经算好的环境变量**。
   *
   * ⚠️ 由主进程算好传进来 —— 因为「登录 shell 的 env」要起一个登录 shell
   *    去导（`shellEnv.ts`），那活儿归主进程干（它还缓存着）✓
   */
  env: Record<string, string>
  /** 起了之后要跑什么（默认 = shell 本身；「运行」按钮传编译产物） */
  command?: { exe: string; args: string[] }
  /**
   * **让 shell 跑这一条命令然后退出**（VS Code 的任务终端模型）。
   *
   * ⚠️⚠️⚠️ **这个字段以前根本没传过来** ⇒ **「运行」按钮在真控制台上是坏的** ——
   *   宿主进程只收到 `shell`/`cwd`/`cols`/`rows`/`command` ⇒
   *   ⇒ `shellCommand` **被丢掉了** ⇒
   *   ⇒ 宿主起的是一个**普通的交互 shell** ⇒
   *   ⇒ **那条命令压根没跑** ⇒ **终端里一点程序输出都没有** ✗
   *   ⇒ 而且**终端永远不退出** ⇒ 「运行中」永远亮着 ✗
   *   ⇒ ⚠️ **只有「pty 宿主进程」这条路坏了** —— 主进程里跑 node-pty 的那条
   *      退路、以及管道兜底**都正常**（它们拿到的是整个 `opts`）⇒
   *      ⇒ **机器上装没装 node-pty 会决定「运行」坏不坏** ⇒ 最坏的一种 ✗
   */
  shellCommand?: string
  /**
   * **别让 shell 加载 profile**（PowerShell 专用）—— 见 `pty.ts` 的说明。
   *
   * ⚠️ **这个决定是在主进程做的**（那儿才有「profile 的 env 导到了没有」）⇒
   *   ⇒ 宿主进程**只是照办** ✓
   */
  noProfile?: boolean
}

/** 渲染进程/主进程 → 宿主进程。 */
export type PtyHostRequest =
  | { t: 'create'; id: number; spec: PtyHostSpec }
  | { t: 'write'; id: number; data: string }
  | { t: 'resize'; id: number; cols: number; rows: number }
  | { t: 'kill'; id: number }

/** 宿主进程 → 渲染进程/主进程。 */
export type PtyHostEvent =
  | { t: 'created'; id: number }
  | { t: 'error'; id: number; error: string }
  | { t: 'data'; id: number; data: string }
  | { t: 'exit'; id: number; code: number | null }

/**
 * 起一个会话的「工厂」—— 宿主进程里真正起 node-pty 的那一步。
 *
 * ⚠️ **做成可注入的** —— 这样单测能塞一个假的进去（不用真起 node-pty：
 *    那个原生模块是按 **Electron 的 ABI** 编的 ⇒ 在纯 Node 里 require
 *    会直接报 ABI 不匹配 ⇒ 测不了）✓
 */
export type PtySpawner = (spec: PtyHostSpec) => PtySession

/**
 * 真的起一个 node-pty 会话（宿主进程里的默认实现）。
 *
 * ⚠️ **node-pty 装不上就抛** ⇒ 上层会把它变成一条 `error` 事件 ⇒
 *    主进程那边看到「起不来」⇒ 退到别的后端 ✓
 */
export function spawnWithNodePty(spec: PtyHostSpec): PtySession {
  const nodePty = tryLoadNodePty()
  if (!nodePty) throw new Error('node-pty 模块没装（可选依赖没装上？）')
  return new NodePtySession(
    {
      shell: spec.shell,
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
      ...(spec.command ? { command: spec.command } : {}),
      // ⚠️⚠️ **「让 shell 跑这条命令然后退出」也得传过去** ——
      //   不传 ⇒ 宿主起的是**普通交互 shell** ⇒ **命令压根没跑** ✗
      ...(spec.shellCommand ? { shellCommand: spec.shellCommand } : {}),
      ...(spec.noProfile ? { noProfile: spec.noProfile } : {}),
    },
    nodePty,
  )
}

/**
 * 宿主进程里的那套逻辑。
 *
 * ⚠️ **不依赖 Electron** ⇒ 能在 Node 里单测 ✓
 */
export class PtyHostCore {
  /** 活着的会话（id → 会话）。 */
  private readonly sessions = new Map<number, PtySession>()
  /** 事件订阅者。 */
  private readonly listeners = new Set<(e: PtyHostEvent) => void>()

  /**
   * @param spawn 起会话的工厂（默认用真的 node-pty；单测塞假的进来）✓
   */
  constructor(private readonly spawn: PtySpawner = spawnWithNodePty) {}

  /** 订阅事件。 */
  onEvent(cb: (e: PtyHostEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 处理一个请求。 */
  handle(req: PtyHostRequest): void {
    switch (req.t) {
      case 'create':
        this.create(req.id, req.spec)
        break
      case 'write':
        this.sessions.get(req.id)?.write(req.data)
        break
      case 'resize':
        this.sessions.get(req.id)?.resize(req.cols, req.rows)
        break
      case 'kill':
        void this.sessions.get(req.id)?.kill()
        break
    }
  }

  /** 起一个真控制台（ConPTY）。 */
  private create(id: number, spec: PtyHostSpec): void {
    try {
      const session = this.spawn(spec)
      session.onData((data) => this.emit({ t: 'data', id, data }))
      session.onExit((code) => {
        this.sessions.delete(id)
        this.emit({ t: 'exit', id, code })
      })
      this.sessions.set(id, session)
      this.emit({ t: 'created', id })
    } catch (err) {
      this.emit({ t: 'error', id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private emit(e: PtyHostEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  /** 宿主进程启动时先干这个：把原生模块**加载进缓存**。 */
  warmUp(): { ok: boolean; error?: string } {
    const nodePty = tryLoadNodePty()
    if (!nodePty) return { ok: false, error: 'node-pty 模块没装（可选依赖没装上？）' }
    try {
      const p = nodePty.spawn('cmd.exe', ['/c', 'exit'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        useConpty: true,
      })
      try {
        p.kill()
      } catch {
        // 已经退了
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
