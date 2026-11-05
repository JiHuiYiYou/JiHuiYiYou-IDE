import { describe, expect, it } from 'vitest'
import {
  clearStatus,
  clearWhenDiagnosticsClean,
  type Status,
} from '../../src/renderer/state/status'

/**
 * **状态栏那条消息必须是「当前的」问题，不是「历史日志」**。
 *
 * ⚠️ **用户报过**：「右下角的状态栏不带更新的，一次编译失败就一直留着了」✗
 *   ⇒ ⇒ **问题解决了就得撤掉** ✓
 *   ⇒ ⇒ 而且**只能撤同一类**（编译成功不该撤掉「块视图只重建了一部分」）✓
 */

/** 一条「编译失败（有源码诊断）」的消息 —— 后台诊断能验证它被修好了。 */
const compileFail: Status = {
  text: '编译失败（123ms）',
  kind: 'bad',
  tag: 'compile',
  clearsWhenDiagnosticsClean: true,
}

/** 一条「链接失败」的消息 —— 后台是 `--no-link` ⇒ 它**看不见** ⇒ 不该被撤。 */
const linkFail: Status = {
  text: '编译失败（456ms）',
  kind: 'bad',
  tag: 'compile',
  clearsWhenDiagnosticsClean: false,
}

describe('状态栏消息的撤除', () => {
  it('⚠️⚠️ **编译成功 ⇒ 上一条「编译失败」必须撤掉**（用户报过「一直留着」）', () => {
    expect(clearStatus(compileFail, 'compile')).toBeUndefined()
  })

  it('运行成功 ⇒ 「编译失败」和「运行失败」都撤掉', () => {
    const runFail: Status = { text: '程序崩溃', kind: 'bad', tag: 'run' }
    expect(clearStatus(runFail, 'compile', 'run')).toBeUndefined()
    expect(clearStatus(compileFail, 'compile', 'run')).toBeUndefined()
  })

  it('⚠️ **只撤同一类** —— 编译成功**不该**撤掉「块视图只重建了一部分」', () => {
    const blocks: Status = {
      text: '源码有语法问题，块视图只重建了能解析的部分（1 处）',
      kind: 'bad',
      tag: 'blocks',
    }
    expect(clearStatus(blocks, 'compile', 'run')).toBe(blocks)
  })

  it('⚠️ **没分类的消息不动** —— 不知道它是什么 ⇒ 别乱撤', () => {
    const unknown: Status = { text: '???', kind: 'bad' }
    expect(clearStatus(unknown, 'compile', 'run')).toBe(unknown)
  })

  it('本来就没有消息 ⇒ 还是没有', () => {
    expect(clearStatus(undefined, 'compile')).toBeUndefined()
  })
})

describe('后台实时诊断 ⇒ 也能撤掉那条「编译失败」', () => {
  it('⚠️⚠️ **用户改完代码、后台说没错了 ⇒ 撤掉**（不然就是骗人）', () => {
    expect(clearWhenDiagnosticsClean(compileFail)).toBeUndefined()
  })

  it('⚠️ **链接失败撤不掉** —— 后台是 `--no-link` ⇒ 它看不见链接错误', () => {
    expect(clearWhenDiagnosticsClean(linkFail)).toBe(linkFail)
  })

  it('别的分类不动（「块视图」「运行失败」）', () => {
    const blocks: Status = { text: '块视图…', kind: 'bad', tag: 'blocks' }
    const runFail: Status = { text: '程序崩溃', kind: 'bad', tag: 'run' }
    expect(clearWhenDiagnosticsClean(blocks)).toBe(blocks)
    expect(clearWhenDiagnosticsClean(runFail)).toBe(runFail)
  })
})
