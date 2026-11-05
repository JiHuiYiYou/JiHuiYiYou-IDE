import { describe, expect, it } from 'vitest'
import { isControlCExit, ntstatusName } from '../../src/main/compiler/runner'

describe('ntstatusName', () => {
  it('认出 Windows 崩溃码', () => {
    expect(ntstatusName(0xc0000005)).toBe('ACCESS_VIOLATION')
    expect(ntstatusName(0xc00000fd)).toBe('STACK_OVERFLOW')
    expect(ntstatusName(0xc0000409)).toBe('STACK_BUFFER_OVERRUN')
  })

  it('普通退出码不算崩溃', () => {
    // fib30.jhyy 正常退出 832040 —— 不是崩溃
    expect(ntstatusName(832040)).toBeUndefined()
    expect(ntstatusName(0)).toBeUndefined()
    expect(ntstatusName(1)).toBeUndefined()
  })

  it('进程没退出时返回 undefined', () => {
    expect(ntstatusName(null)).toBeUndefined()
  })

  it('未收录的 NTSTATUS 也给出可读名字', () => {
    expect(ntstatusName(0xc0000999)).toBe('NTSTATUS_0xC0000999')
  })

  it('Ctrl+C 退出（0xC000013A）有名字 —— 它是**用户打断**，不是崩溃', () => {
    // ⚠️ 真控制台（ConPTY）里按 Ctrl+C 会真的杀掉前台进程 ⇒ 它就带着这个码退出。
    //    以前这码不在表里 ⇒ 显示成「NTSTATUS_0xC000013A」+「程序崩溃」⇒
    //    用户一头雾水（用户报过「程序崩溃：NTSTATUS0xC000013A 是什么鬼」）。
    expect(ntstatusName(0xc000013a)).toBe('CONTROL_C_EXIT')
    // Node 给的可能是**有符号**的 32 位值（-1073741510）⇒ 两种都得认
    expect(ntstatusName(-1073741510)).toBe('CONTROL_C_EXIT')
  })
})

describe('isControlCExit', () => {
  it('只认 Ctrl+C 那个码', () => {
    expect(isControlCExit(0xc000013a)).toBe(true)
    expect(isControlCExit(-1073741510)).toBe(true)
    expect(isControlCExit(0xc0000005)).toBe(false)
    expect(isControlCExit(0)).toBe(false)
    expect(isControlCExit(null)).toBe(false)
  })
})
