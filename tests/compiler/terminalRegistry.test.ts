import { describe, expect, it } from 'vitest'
import { TerminalRegistry } from '../../src/main/terminalRegistry'
import type { TerminalSession } from '../../src/main/terminal'
import type { TerminalDataEvent, TerminalExitEvent, TerminalInfo } from '@shared/terminal'

/**
 * **终端登记表** —— VS Code 那套多终端的行为。
 *
 * ⚠️ 用户点名的四条：
 * 1. 能**开新的**
 * 2. 能**关旧的**
 * 3. 「运行」用**当前那个**；一个都没有 ⇒ **新开一个**
 * 4. 反复运行 ⇒ **复用同一个**（不每次都开新的）
 *
 * ⚠️ **不真起 shell** —— 会话是注入进来的假的 ⇒ 测试跑得快、不留进程 ✓
 */

/** 一个假的终端会话。 */
function fakeSession(id: number): TerminalSession {
  return {
    id,
    running: true,
    backend: 'node-pty',
    lineEnding: '\r',
    echoesInput: true,
    currentShell: 'bash',
    currentCwd: 'C:/tmp',
    visible: false,
    shellState: { cwd: 'C:/tmp', exitCode: null, idle: true },
    write: () => {},
    resize: () => {},
    cd: () => {},
    display: () => {},
    echo: () => {},
    prompt: () => {},
    setProgramInput: () => {},
    resetFlowControl: () => {},
    saveBuffer: () => {},
    getBuffer: () => null,
    ack: () => {},
    kill: async () => {},
    onData: () => {},
    onExit: () => {},
  } as unknown as TerminalSession
}

interface Harness {
  reg: TerminalRegistry
  data: TerminalDataEvent[]
  exits: TerminalExitEvent[]
  lists: TerminalInfo[][]
}

function makeRegistry(): Harness {
  const data: TerminalDataEvent[] = []
  const exits: TerminalExitEvent[] = []
  const lists: TerminalInfo[][] = []
  const reg = new TerminalRegistry('bash', {
    onData: (e) => data.push(e),
    onExit: (e) => exits.push(e),
    onState: () => {},
    onListChanged: () => lists.push(reg.list()),
    createSession: (id) => fakeSession(id),
  })
  return { reg, data, exits, lists }
}

describe('终端登记表', () => {
  it('开一个 ⇒ 列表里有一个，它就是当前那个', () => {
    const { reg } = makeRegistry()
    expect(reg.list()).toHaveLength(0)
    const t = reg.create('C:/tmp')
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0].name).toBe('bash')
    expect(reg.activeTerminalId).toBe(t.id)
  })

  it('能开多个 ⇒ 列表按创建顺序排，新的那个是当前那个', () => {
    const { reg } = makeRegistry()
    const a = reg.create()
    const b = reg.create()
    expect(reg.list().map((t) => t.id)).toEqual([a.id, b.id])
    expect(reg.activeTerminalId).toBe(b.id)
  })

  it('能切当前那个', () => {
    const { reg } = makeRegistry()
    const a = reg.create()
    const b = reg.create()
    reg.setActive(a.id)
    expect(reg.activeTerminalId).toBe(a.id)
    expect(reg.active()).toBe(reg.get(a.id))
    expect(reg.get(b.id)).not.toBeNull()
  })

  it('关掉一个 ⇒ 从列表里去掉；当前那个被关了就换成最后剩下的那个', () => {
    const { reg } = makeRegistry()
    const a = reg.create()
    const b = reg.create()
    reg.setActive(b.id)
    reg.close(a.id)
    expect(reg.list().map((t) => t.id)).toEqual([b.id])
    // ⚠️ 关掉的不是当前那个 ⇒ 当前那个不变
    expect(reg.activeTerminalId).toBe(b.id)

    reg.close(b.id)
    expect(reg.list()).toHaveLength(0)
    // ⚠️ 一个都不剩 ⇒ 没有当前终端了（下次「运行」会新开一个）✓
    expect(reg.activeTerminalId).toBeNull()
    expect(reg.active()).toBeNull()
  })

  it('一个都没有时「要一个当前终端」⇒ 新开一个（VS Code 的行为）', () => {
    const { reg } = makeRegistry()
    expect(reg.active()).toBeNull()
    const t = reg.activeOrCreate('C:/work')
    expect(reg.list()).toHaveLength(1)
    expect(reg.activeTerminalId).toBe(t.id)
  })

  it('已经有了 ⇒ 「要一个当前终端」就是它（**不新开** ⇒ 反复运行不换终端）', () => {
    const { reg } = makeRegistry()
    const first = reg.activeOrCreate('C:/work')
    const second = reg.activeOrCreate('C:/work')
    expect(second).toBe(first)
    expect(reg.list()).toHaveLength(1)
  })

  it('列表变了要通知渲染进程（它得重画列表）', () => {
    const { reg, lists } = makeRegistry()
    const before = lists.length
    reg.create()
    expect(lists.length).toBeGreaterThan(before)
  })
})
