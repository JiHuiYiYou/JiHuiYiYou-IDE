import { describe, expect, it } from 'vitest'
import type { PtySession } from '../../src/main/pty'
import { PtyHostCore, type PtyHostEvent, type PtyHostSpec } from '../../src/main/ptyHostCore'
import { PtyHost, setPtyHost, type HostProcess } from '../../src/main/ptyHostClient'
import { createPtySession } from '../../src/main/ptyFactory'

/**
 * **pty 宿主进程**的测试。
 *
 * ⚠️ **不真起 node-pty** —— 那个原生模块是按 **Electron 的 ABI** 编的，
 *    在纯 Node 里 `require` 会直接报 ABI 不匹配 ⇒ 起不来 ⇒
 *    ⇒ 这里塞**假的**进去（`PtyHostCore` 的 spawner 是可注入的）✓
 *    测的是「协议对不对」，不是「node-pty 能不能用」。
 */

/** 一个假的 pty 会话。 */
class FakeSession implements PtySession {
  readonly backend = 'node-pty' as const
  readonly echoesInput = true
  readonly lineEnding = '\r' as const
  running = true
  readonly written: string[] = []
  readonly resized: { cols: number; rows: number }[] = []
  killed = false
  private readonly dataCbs: ((d: string) => void)[] = []
  private readonly exitCbs: ((c: number | null) => void)[] = []

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }
  onExit(cb: (c: number | null) => void): void {
    this.exitCbs.push(cb)
  }
  write(d: string): void {
    this.written.push(d)
  }
  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows })
  }
  async kill(): Promise<void> {
    this.killed = true
    this.running = false
  }
  emitData(d: string): void {
    for (const cb of this.dataCbs) cb(d)
  }
  emitExit(code: number | null): void {
    this.running = false
    for (const cb of this.exitCbs) cb(code)
  }
}

/** 一个假的宿主进程。 */
class FakeHostProcess implements HostProcess {
  readonly sent: unknown[] = []
  private readonly msgCbs: ((m: unknown) => void)[] = []
  private readonly exitCbs: ((c: number) => void)[] = []
  postMessage(m: unknown): void {
    this.sent.push(m)
  }
  onMessage(cb: (m: unknown) => void): void {
    this.msgCbs.push(cb)
  }
  onExit(cb: (c: number) => void): void {
    this.exitCbs.push(cb)
  }
  emitMessage(m: unknown): void {
    for (const cb of this.msgCbs) cb(m)
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb(code)
  }
}

const SPEC: PtyHostSpec = {
  shell: 'bash',
  cwd: 'C:/tmp',
  cols: 80,
  rows: 24,
  env: {},
}

describe('pty 宿主的核心逻辑', () => {
  it('起会话 ⇒ 报「起来了」，输出/退出都转成事件', () => {
    const fake = new FakeSession()
    const core = new PtyHostCore(() => fake)
    const events: PtyHostEvent[] = []
    core.onEvent((e) => events.push(e))

    core.handle({ t: 'create', id: 1, spec: SPEC })
    expect(events).toEqual([{ t: 'created', id: 1 }])

    // 写进去 ⇒ 会话收到
    core.handle({ t: 'write', id: 1, data: 'ls\n' })
    expect(fake.written).toEqual(['ls\n'])

    // 改尺寸 ⇒ 会话收到
    core.handle({ t: 'resize', id: 1, cols: 100, rows: 40 })
    expect(fake.resized).toEqual([{ cols: 100, rows: 40 }])

    // 会话吐数据 ⇒ 变成事件
    fake.emitData('hello')
    expect(events).toContainEqual({ t: 'data', id: 1, data: 'hello' })

    // 会话退出 ⇒ 变成事件
    fake.emitExit(3)
    expect(events).toContainEqual({ t: 'exit', id: 1, code: 3 })
  })

  it('起不来 ⇒ 报「错误」（别静悄悄）', () => {
    const core = new PtyHostCore(() => {
      throw new Error('node-pty 模块没装')
    })
    const events: PtyHostEvent[] = []
    core.onEvent((e) => events.push(e))
    core.handle({ t: 'create', id: 7, spec: SPEC })
    expect(events).toEqual([{ t: 'error', id: 7, error: 'node-pty 模块没装' }])
  })

  it('杀掉 ⇒ 会话真的被杀了', async () => {
    const fake = new FakeSession()
    const core = new PtyHostCore(() => fake)
    core.handle({ t: 'create', id: 1, spec: SPEC })
    core.handle({ t: 'kill', id: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.killed).toBe(true)
  })

  /**
   * ⚠️ **「kill 比 create 先到」⇒ 不能起一个没人管的孤儿 shell**。
   *
   * ⚠️ 这在主进程那边**很常见** ——
   *   宿主进程还没 ready 时，创建请求是**先攒着**的 ⇒
   *   用户在等的期间把终端关了 ⇒ **`kill` 先到**、`create` 后到 ⇒
   *   以前 `sessions.get(id)` 是 undefined ⇒ **kill 是个空操作** ⇒
   *   ⇒ 随后 shell 起来了，**没人管它** ✗✗
   */
  it('**kill 先到 ⇒ create 到达时立刻杀掉**（不留孤儿 shell）', async () => {
    const fake = new FakeSession()
    const core = new PtyHostCore(() => fake)
    // ⚠️ **kill 先到**（会话还没起来 ⇒ 宿主不认识它）
    core.handle({ t: 'kill', id: 42 })
    core.handle({ t: 'create', id: 42, spec: SPEC })
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.killed, '孤儿 shell 必须被杀掉').toBe(true)
  })

  it('真起一个 node-pty（ConPTY）⇒ 输出能回来', async () => {
    // ⚠️ **用真的 node-pty** —— 假的那套只验了协议，没验「真能起」
    const core = new PtyHostCore()
    const events: PtyHostEvent[] = []
    core.onEvent((e) => events.push(e))

    core.handle({
      t: 'create',
      id: 1,
      spec: {
        ...SPEC,
        // 起一个「打印一行就退出」的程序
        command: { exe: 'cmd.exe', args: ['/c', 'echo jhyy-host-ok'] },
      },
    })

    const t0 = Date.now()
    while (Date.now() - t0 < 20_000 && !events.some((e) => e.t === 'exit')) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const text = events
      .filter((e): e is Extract<PtyHostEvent, { t: 'data' }> => e.t === 'data')
      .map((e) => e.data)
      .join('')
    expect(text).toContain('jhyy-host-ok')
    expect(events.some((e) => e.t === 'exit')).toBe(true)
  })
})

describe('pty 宿主的客户端', () => {
  it('宿主进程说「准备好了」⇒ 才算可用', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    expect(host.start()).toBe(true)
    // ⚠️ 还没收到 ready ⇒ **不能**用（node-pty 能不能用还不知道）✓
    expect(host.available).toBe(false)

    proc.emitMessage({ t: 'ready', ok: true })
    expect(host.available).toBe(true)
  })

  it('宿主进程说「node-pty 用不了」⇒ 退到别的后端（状态要看得见）', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    proc.emitMessage({ t: 'ready', ok: false, error: 'node-pty 模块没装' })
    expect(host.available).toBe(false)
    expect(host.reason).toBe('node-pty 模块没装')
  })

  it('起会话 ⇒ 请求发给宿主进程，输出/退出转成回调', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    proc.emitMessage({ t: 'ready', ok: true })

    const session = host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    const data: string[] = []
    const exits: (number | null)[] = []
    session.onData((d) => data.push(d))
    session.onExit((c) => exits.push(c))

    // ⚠️ 请求发出去了 ✓
    const req = proc.sent[0] as { t: string; id: number; spec: PtyHostSpec }
    expect(req.t).toBe('create')
    expect(req.spec.shell).toBe('bash')
    expect(req.spec.env).toBeTruthy()

    // 宿主进程发来的数据 ⇒ 回调 ✓
    proc.emitMessage({ t: 'data', id: session.id, data: 'hi' })
    expect(data).toEqual(['hi'])

    // 退出 ⇒ 回调 ✓
    proc.emitMessage({ t: 'exit', id: session.id, code: 7 })
    expect(exits).toEqual([7])
    expect(session.running).toBe(false)
  })

  it('宿主进程崩了 ⇒ 所有会话都收到「退出」（别让终端卡在那儿）', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    proc.emitMessage({ t: 'ready', ok: true })
    const session = host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    const exits: (number | null)[] = []
    session.onExit((c) => exits.push(c))

    proc.emitExit(1)
    expect(exits).toEqual([1])
    expect(host.running).toBe(false)
    expect(host.available).toBe(false)
  })

  it('**宿主还没 ready 时建的会话 ⇒ ready 之后请求才发出去**（第一个终端也有隔离）', () => {
    // ⚠️⚠️ **为什么要有这条** ——
    //    `available` 要求宿主**已经报过 ready**（它自己起来 + 加载 node-pty
    //    + 预热一个控制台 ⇒ 好几百毫秒）⇒ **IDE 刚启动时建的第一个终端**
    //    正好落在这个窗口里 ⇒ 以前它会**退回「主进程里跑 node-pty」**
    //    ⇒ **第一个终端没有崩溃隔离**（node-pty 段错误 = 整个 IDE 死）✗
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    // ⚠️ 还没报 ready ⇒ **请求不能发出去**（宿主还没起来 ⇒ postMessage 没人接
    //    ⇒ 请求**静悄悄地丢了** ⇒ 那个终端永远起不来）✗
    expect(host.canCreate).toBe(true)
    const session = host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    expect(proc.sent).toHaveLength(0)

    // ⇒ ready 之后 ⇒ 攒着的请求发出去 ✓
    proc.emitMessage({ t: 'ready', ok: true })
    expect(proc.sent).toHaveLength(1)
    const req = proc.sent[0] as { t: string; id: number }
    expect(req.t).toBe('create')
    expect(req.id).toBe(session.id)
  })

  it('宿主说「node-pty 用不了」⇒ 请求**不能**攒着（否则那个终端永远起不来）', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    proc.emitMessage({ t: 'ready', ok: false, error: 'node-pty 模块没装' })
    expect(host.available).toBe(false)
    // ⚠️ **报过了、说不能用** ⇒ 得退回「主进程里跑 node-pty」⇒ 不能攒着
    expect(host.canCreate).toBe(false)
  })

  /**
   * ⚠️ **在等的期间把终端关掉 ⇒ 不能起一个没人管的孤儿 shell**。
   *
   * ⚠️ 宿主还没 ready 时创建请求是**先攒着**的 ⇒
   *   用户在等的期间把终端关了 ⇒ `kill` 那个 id 宿主**压根不认识**
   *   ⇒ 以前那个 `kill` 是个空操作 ⇒ 而攒着的创建请求**后来照样发出去**
   *   ⇒ **shell 起来了，没人管** ✗✗（用户看不见，但一直占着进程）
   */
  it('**还没发出去的创建请求 ⇒ 会话被关掉后要撤掉**（不留孤儿 shell）', async () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    // ⚠️ 还没 ready ⇒ 创建请求**先攒着**
    const session = host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    expect(proc.sent).toHaveLength(0)

    // ⚠️ **用户在这时候把终端关了**
    await session.kill()

    // ⇒ ready 之后 ⇒ **那个创建请求不能发出去**（不然就起了一个孤儿 shell）✓
    proc.emitMessage({ t: 'ready', ok: true })
    const creates = proc.sent.filter((r) => (r as { t: string }).t === 'create')
    expect(creates, '撤掉的创建请求不能发出去').toHaveLength(0)
  })

  it('宿主崩了 ⇒ `ensureStarted()` 能再起一个（别让后面所有终端都退回主进程）', () => {
    const procs: FakeHostProcess[] = []
    const host = new PtyHost(() => {
      const p = new FakeHostProcess()
      procs.push(p)
      return p
    })
    host.start()
    procs[0].emitMessage({ t: 'ready', ok: true })
    expect(host.available).toBe(true)

    procs[0].emitExit(1)
    expect(host.running).toBe(false)

    // ⇒ 能自愈 ✓（不然之后所有终端都退回主进程跑 node-pty ⇒ 段错误带走整个 IDE）
    expect(host.ensureStarted()).toBe(true)
    expect(host.running).toBe(true)
    expect(procs).toHaveLength(2)
    // ⚠️⚠️ **重起之后还能用宿主** —— 不然「自愈」是假的
    //    （`readyReported` 不重置 ⇒ `canCreate` 永远 false ⇒ 白起）
    expect(host.canCreate).toBe(true)
    host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    // ⇒ 请求先攒着（新宿主还没报 ready）⇒
    expect(procs[1].sent).toHaveLength(0)
    procs[1].emitMessage({ t: 'ready', ok: true })
    expect(procs[1].sent).toHaveLength(1)
  })

  it('宿主崩了 ⇒ 攒着的「起会话」请求要丢掉（别凭空起一堆没人管的 shell）', () => {
    const procs: FakeHostProcess[] = []
    const host = new PtyHost(() => {
      const p = new FakeHostProcess()
      procs.push(p)
      return p
    })
    host.start()
    // 攒一个（宿主还没 ready）
    host.create({ shell: 'bash', cwd: 'C:/tmp', cols: 80, rows: 24 })
    expect(procs[0].sent).toHaveLength(0)

    // ⇒ 宿主崩了 ⇒ 那个会话也死了 ⇒ 攒着的请求不能发给**新**宿主
    procs[0].emitExit(1)
    host.ensureStarted()
    procs[1].emitMessage({ t: 'ready', ok: true })
    expect(procs[1].sent).toHaveLength(0)
  })
})

/**
 * **「让 shell 跑这一条命令然后退出」必须一路传到宿主进程**。
 *
 * ⚠️⚠️⚠️ **以前根本没传** ⇒ **「运行」按钮在真控制台上是坏的** ——
 *   `ptyFactory` 起宿主会话时只传了 `shell`/`cwd`/`cols`/`rows`/`command`
 *   ⇒ `shellCommand` **被丢掉了** ⇒
 *   ⇒ 宿主起的是一个**普通的交互 shell** ⇒
 *   ⇒ **那条命令压根没跑** ⇒ **终端里一点程序输出都没有**（用户报过）✗
 *   ⇒ 而且**终端永远不退出** ⇒ 「运行中」永远亮着 ✗
 *
 * ⚠️ **只有这条路会坏** —— 主进程里跑 node-pty 的退路、以及管道兜底
 *    **都正常**（它们拿到的是整个 `opts`）⇒
 *    ⇒ **机器上装没装 node-pty 会决定「运行」坏不坏** ⇒ 最坏的一种 ✗
 */
describe('「运行」的命令要传到 pty 宿主进程去', () => {
  it('**宿主进程必须收到 `shellCommand`**', () => {
    const proc = new FakeHostProcess()
    const host = new PtyHost(() => proc)
    host.start()
    proc.emitMessage({ t: 'ready', ok: true })
    setPtyHost(host)
    try {
      createPtySession({
        shell: 'powershell',
        cwd: 'C:/tmp',
        cols: 80,
        rows: 24,
        shellCommand: 'echo hello-from-task',
      })
      const req = proc.sent[0] as { t: string; spec: PtyHostSpec }
      expect(req.t).toBe('create')
      expect(req.spec.shellCommand).toBe('echo hello-from-task')
    } finally {
      setPtyHost(null)
    }
  })

  it('**宿主进程的核心也要把它交给 node-pty**', () => {
    const seen: PtyHostSpec[] = []
    const core = new PtyHostCore((spec) => {
      seen.push(spec)
      return new FakeSession()
    })
    core.handle({
      t: 'create',
      id: 1,
      spec: { ...SPEC, shellCommand: 'echo hello-from-task' },
    })
    expect(seen[0]?.shellCommand).toBe('echo hello-from-task')
  })

  it('**真起一个 node-pty ⇒ 那条命令真的跑了**（以前压根没跑）', async () => {
    // ⚠️⚠️ **这是「运行」按钮走的那条路** ——
    //   「pty 宿主进程」是**首选后端** ⇒ 它以前收不到 `shellCommand`
    //   ⇒ ⇒ 起的是**普通交互 shell** ⇒ **命令压根没跑** ⇒
    //   ⇒ **终端里一点程序输出都没有**（用户报过）✗
    const core = new PtyHostCore()
    const events: PtyHostEvent[] = []
    core.onEvent((e) => events.push(e))

    core.handle({
      t: 'create',
      id: 1,
      spec: {
        ...SPEC,
        shell: 'bash',
        // ⚠️ **bash 的 `-c` 模式**：命令是**启动参数** ⇒ 跑完就退出 ✓
        shellCommand: 'echo jhyy-host-task-ok',
      },
    })

    const t0 = Date.now()
    while (Date.now() - t0 < 20_000 && !events.some((e) => e.t === 'exit')) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const text = events
      .filter((e): e is Extract<PtyHostEvent, { t: 'data' }> => e.t === 'data')
      .map((e) => e.data)
      .join('')
    expect(text).toContain('jhyy-host-task-ok')
    // ⚠️ **而且终端得自己退出**（跑完就退 ⇒ 「运行」能收场）✓
    expect(events.some((e) => e.t === 'exit')).toBe(true)
  })
})
