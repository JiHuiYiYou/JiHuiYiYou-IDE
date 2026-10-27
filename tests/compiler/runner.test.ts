import { describe, expect, it } from 'vitest'
import { ntstatusName } from '../../src/main/compiler/runner'

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
})
