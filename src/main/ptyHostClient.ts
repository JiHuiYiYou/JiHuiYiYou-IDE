import { join } from 'node:path'
import type { PtySession } from './pty'
import type { PtyHostEvent, PtyHostRequest, PtyHostSpec } from './ptyHostCore'
import { buildTerminalEnv } from './ptyNode'

/**
 * **pty 宿主进程**的客户端（主进程这一侧）。
 *
 * ## 它管什么
 *
 * - 把「起一个真控制台」的请求发给宿主进程（`ptyHost.ts`）
 * - 把宿主进程发回来的输出/退出事件转成 `PtySession` 的回调
 *
 * ## 为什么宿主进程起不来也不致命
 *
 * 宿主进程只是个**隔离层** —— 它起不来就退回「主进程里直接跑 node-pty」
 * （`ptyFactory.ts` 负责挑）⇒ 用户最多是「没有隔离」，
 * 终端还是能用 ✓（VS Code 那边的 pty 宿主起不来也是这么退的）。
 *
 * ## 为什么要把「怎么起进程」注入进来
 *
 * 这个模块**不能 import electron** —— 它被 `ptyFactory` 引进来的，而
 * `ptyFactory` 被测试引进来的 ⇒ 纯 Node 的测试环境里没有 electron ⇒
 * ⇒ 「起进程」这一步做成接口，由主进程（那边有 electron）塞进来 ✓
 */

/** 宿主进程对外的样子（跟 Electron 解耦 ⇒ 能单测）。 */
export interface HostProcess {
  /** 发消息给宿主进程。 */
  postMessage(message: unknown): void
  /** 宿主进程发来的消息。 */
  onMessage(cb: (message: unknown) => void): void
  /** 宿主进程退出了。 */
  onExit(cb: (code: number) => void): void
}

/** 怎么把宿主进程起起来。 */
export type HostForker = (scriptPath: string) => HostProcess

/** 宿主进程发回来的「我准备好了」。 */
interface HostReady {
  t: 'ready'
  ok: boolean
  error?: string
}

/** 主进程这一侧的一个会话（真控制台跑在宿主进程里）。 */
class HostPtySession implements PtySession {
  /** 这是真控制台（ConPTY）。 */
  readonly backend = 'node-pty' as const
  /** 真控制台**自己会回显** ⇒ IDE 不要再回显一遍（否则每个字出现两次）。 */
  readonly echoesInput = true
  /** 控制台的行编辑把 `\r`（回车键）当提交 ⇒ 行尾用 `\r`（**不能 `\r\n`**）。 */
  readonly lineEnding = '\r' as const

  private exited = false
  private readonly dataListeners: ((data: string) => void)[] = []
  private readonly exitListeners: ((code: number | null) => void)[] = []
  /**
   * **订阅之前**就到了的事件（数据 / 退出）。
   *
   * ⚠️ 宿主进程是**异步**回话的 ⇒ 理论上第一个事件可能比订阅早到
   *    ⇒ 先存着，等有人订阅了再倒出来 ✓
   */
  private pending: PtyHostEvent[] = []

  constructor(
    private readonly host: PtyHost,
    readonly id: number,
  ) {}

  get running(): boolean {
    return !this.exited
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb)
    this.flushPending()
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb)
    this.flushPending()
  }

  write(data: string): void {
    if (this.exited) return
    this.host.send({ t: 'write', id: this.id, data })
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    this.host.send({ t: 'resize', id: this.id, cols, rows })
  }

  async kill(): Promise<void> {
    if (this.exited) return
    this.exited = true
    this.host.send({ t: 'kill', id: this.id })
  }

  /** 宿主进程那边来了一个事件。 */
  handle(e: PtyHostEvent): void {
    if (e.t === 'data') {
      if (this.dataListeners.length === 0) {
        this.pending.push(e)
        return
      }
      for (const cb of this.dataListeners) cb(e.data)
      return
    }
    if (e.t === 'exit') {
      this.exited = true
      if (this.exitListeners.length === 0) {
        this.pending.push(e)
        return
      }
      for (const cb of this.exitListeners) cb(e.code)
      return
    }
    if (e.t === 'error') {
      // ⚠️ 起不来 ⇒ 当成「进程退出了」，把原因带给上层
      this.exited = true
      for (const cb of this.exitListeners) cb(null)
    }
  }

  /** 把订阅之前攒着的事件倒出来。 */
  private flushPending(): void {
    if (this.pending.length === 0) return
    const list = this.pending
    this.pending = []
    for (const e of list) this.handle(e)
  }
}

/**
 * 宿主进程的管理者。
 *
 * ⚠️ **整个 IDE 只起一个** —— VS Code 也是（一个 pty 宿主管所有终端）✓
 */
export class PtyHost {
  private child: HostProcess | null = null
  private nextId = 1
  private readonly sessions = new Map<number, HostPtySession>()
  /**
   * **宿主还没 ready 时攒着的「起会话」请求**。
   *
   * ⚠️⚠️ **为什么要有它** ——
   *    `available` 要求宿主已经报过 `{t:'ready', ok:true}`（那要它自己起来、
   *    加载 node-pty、预热一个控制台 ⇒ 好几百毫秒）。
   *    ⇒ **IDE 刚启动时建的第一个终端**正好落在这个窗口里
   *    ⇒ 以前它会**退回「主进程里直接跑 node-pty」**
   *    ⇒ **第一个终端没有崩溃隔离**（node-pty 段错误 = 整个 IDE 死）✗
   *    ⇒ 现在先攒着，ready 之后统一发出去 ⇒ **从第一个终端起就有隔离** ✓
   */
  private readonly pendingCreates: { id: number; spec: PtyHostSpec }[] = []
  /**
   * node-pty 在**宿主进程**里能不能用（宿主进程启动时的自检结果）。
   *
   * ⚠️ 宿主进程是**另一个进程** ⇒ 主进程里 `require('node-pty')` 能不能成功
   *    **不代表**宿主进程里也能 ⇒ 得宿主进程自己报 ✓
   */
  nodePtyOk = false
  /** 宿主进程为什么不行（退到管道版时给用户看）。 */
  reason: string | undefined
  /**
   * **宿主报过 ready 了吗？**
   *
   * ⚠️ **为什么要有它** —— 「还没报 ready」⇒ 只是**还没准备好**
   *    （请求可以先攒着，ready 之后发出去 ✓）；
   *    「报过了、说不能用」⇒ node-pty 在那儿**真的不行**
   *    ⇒ 得退回「主进程里跑 node-pty」⇒ **不能攒着**（那样永远起不来）✗
   */
  private readyReported = false

  constructor(private readonly fork: HostForker) {}

  /** 起宿主进程（幂等）。 */
  start(): boolean {
    if (this.child) return true
    try {
      const path = join(__dirname, 'ptyHost.js')
      const child = this.fork(path)
      this.child = child
      // ⚠️ **新起的宿主 ⇒ 「ready 还没报过」** ——
      //    不重置的话 ⇒ `canCreate` 永远是 false ⇒ 崩过之后**再也用不了宿主**
      //    ⇒ 所有终端都退回主进程跑 node-pty ⇒ 段错误会带走整个 IDE ✗
      this.nodePtyOk = false
      this.readyReported = false
      child.onMessage((message) => this.handleMessage(message))
      child.onExit((code) => {
        // ⚠️ 宿主进程死了 ⇒ 所有会话都完了 ⇒ 通知上层（终端会显示「进程已退出」）
        this.child = null
        this.nodePtyOk = false
        this.reason = `pty 宿主进程退出了（代码 ${code}）`
        for (const s of this.sessions.values()) s.handle({ t: 'exit', id: s.id, code })
        this.sessions.clear()
        // ⚠️ **攒着的「起会话」请求也得丢掉** ——
        //    那些会话已经跟着宿主一起死了 ⇒ 之后发给**新**宿主的话
        //    会凭空起一堆没人管的 shell ✗
        this.pendingCreates.length = 0
      })
      return true
    } catch (err) {
      this.child = null
      this.nodePtyOk = false
      this.readyReported = true
      this.reason = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /**
   * **保证宿主进程在**（不在就重新起一个）。
   *
   * ⚠️ **为什么要有它** —— 宿主进程崩了以后 `child = null`
   *    ⇒ `available` 永远 false ⇒ 之后所有终端都退回「主进程里跑 node-pty」
   *    ⇒ **段错误会把整个 IDE 带走**（那正是宿主进程要隔离的东西）✗
   *    ⇒ 崩过之后能自愈 ✓
   */
  ensureStarted(): boolean {
    if (this.child) return true
    return this.start()
  }

  /** 宿主进程可用吗？（node-pty 在那儿能用） */
  get available(): boolean {
    return this.child !== null && this.nodePtyOk
  }

  /**
   * **能不能把「起会话」的请求交给宿主**？
   *
   * ⚠️ **「还没报 ready」也算能** —— 请求会**先攒着**，
   *    ready 之后统一发出去 ⇒ **IDE 刚启动时的第一个终端也有隔离** ✓
   * ⚠️ **「报过了、说 node-pty 不行」⇒ 不能** ⇒ 得退回主进程 ✓
   */
  get canCreate(): boolean {
    if (this.child === null) return false
    return !this.readyReported || this.nodePtyOk
  }

  /** 宿主进程**活着**吗？（不管 node-pty 能不能用） */
  get running(): boolean {
    return this.child !== null
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const m = message as HostReady | PtyHostEvent
    if (m.t === 'ready') {
      this.nodePtyOk = m.ok
      this.readyReported = true
      this.reason = m.error
      // ⚠️ **宿主 ready 了 ⇒ 把攒着的「起会话」请求发出去**
      //    （不然 IDE 刚启动时建的第一个终端就永远起不来）✓
      if (m.ok) this.flushPendingCreates()
      return
    }
    const ev = m as PtyHostEvent
    // ⚠️ **没有对应会话的错误也要报出来** —— 宿主进程的 stdout 未必透得到主进程
    //    ⇒ 不打日志的话就是「静悄悄地什么都不发生」（用户就只看到终端没反应）✗
    const session = this.sessions.get(ev.id)
    if (!session) {
      if (ev.t === 'error') console.error(`[pty] 宿主进程报错：${ev.error}`)
      return
    }
    session.handle(ev)
  }

  /** 发一个请求给宿主进程。 */
  send(req: PtyHostRequest): void {
    try {
      this.child?.postMessage(req)
    } catch (err) {
      /*
        ⚠️⚠️ **`postMessage` 会因为「克隆不了」而抛** ——

        最典型的就是 **`process.env`**：它是**特殊对象**（不是普通对象）⇒
        结构化克隆**克隆不了** ⇒ `postMessage` 直接抛
        「An object could not be cloned.」（实测踩过：请求根本没发出去，
        终端就「没反应」）⇒

        ⇒ 凡是发给宿主进程的东西，都得先**摊平成普通对象** ✓
        ⇒ 这里**别把错误吞掉** —— 吞掉的话就是「静悄悄地什么都不发生」✗
      */
      console.error(
        `[pty] 发请求给宿主进程失败（${req.t}）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 起一个真控制台（跑在宿主进程里）。
   *
   * @param spec 起什么、怎么起
   */
  create(spec: Omit<PtyHostSpec, 'env'>): HostPtySession {
    const id = this.nextId++
    const session = new HostPtySession(this, id)
    this.sessions.set(id, session)
    const fullSpec: PtyHostSpec = {
      ...spec,
      // ⚠️ env 由**主进程**算好（登录 shell 那份 —— 见 `buildTerminalEnv`）⇒
      //    宿主进程不用再起一个登录 shell 去导 ✓
      // ⚠️ **摊平成普通对象** —— `process.env` 那种特殊对象**克隆不了**
      //    ⇒ `postMessage` 会抛「An object could not be cloned.」✓
      env: { ...buildTerminalEnv(spec.shell) },
    }
    /*
      ⚠️⚠️ **宿主还没 ready ⇒ 先攒着** ——
        现在发过去的话，宿主进程还没起来 ⇒ `postMessage` 没人接 ⇒
        请求**静悄悄地丢了** ⇒ 那个终端永远起不来（连提示符都没有）✗
        ⇒ 等它报 ready 再发 ✓
    */
    if (!this.available) {
      this.pendingCreates.push({ id, spec: fullSpec })
      return session
    }
    this.send({ t: 'create', id, spec: fullSpec })
    return session
  }

  /** **把攒着的「起会话」请求发出去**（宿主 ready 之后）。 */
  private flushPendingCreates(): void {
    if (this.pendingCreates.length === 0) return
    const pending = this.pendingCreates.splice(0, this.pendingCreates.length)
    for (const p of pending) this.send({ t: 'create', id: p.id, spec: p.spec })
  }
}

/** 整个 IDE 就这一个宿主进程（主进程启动时塞进来）。 */
let theHost: PtyHost | null = null

/** 主进程启动时调用：把宿主进程装上。 */
export function setPtyHost(host: PtyHost | null): void {
  theHost = host
}

/** 拿到宿主进程（没有就是 null ⇒ 退回「主进程里直接跑 node-pty」）。 */
export function ensurePtyHost(): PtyHost | null {
  return theHost
}
