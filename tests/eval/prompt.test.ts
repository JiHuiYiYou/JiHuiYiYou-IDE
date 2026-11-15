/**
 * **题目 prompt 的单测** —— 纯逻辑、不花钱、不调 API。
 *
 * 为什么要有这一层（2026-11-15）：
 *   prompt 里的两块「环境契约」是**实测出来的**（判分口径 / 工具链在哪），
 *   而 prompt 是**评测的尺子** ⇒ 改它就是在改尺子 ⇒ 必须能一眼看出改了哪。
 *   ⇒ 两个开关（`--judge-rule` / `--env-contract`）各自独立、默认开、
 *     关掉要能**逐字复现旧 prompt**（否则 A/B 就不是 A/B 了）。
 *
 * ⚠️ 另有一条**更要紧**的不变式：**prompt 绝不能泄露期望输出** ——
 *   「翻译」题把答案给模型 ⇒ 它把答案打印出来就过 ⇒ 那道题就废了。
 */

import { describe, expect, it } from 'vitest'

import { buildPrompt } from '../../scripts/eval/prompt'
import type { EvalTask } from '../../scripts/eval/tasks'

function translateTask(over: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'translate/seed1/jhyy',
    lang: 'jhyy',
    pairId: 'translate/seed1',
    mutationId: 'translate',
    kind: 'translate',
    title: '把 C 程序翻译成 JHYY',
    rule: 'C → JHYY 翻译',
    sourceFile: '',
    specFile: 'translate_seed1_c.c',
    specContent: '#include <stdio.h>\nint main(void){return 0;}\n',
    broken: '',
    expectStdout: '2347996768\n2347996768\n642295773\n',
    actualStdout: undefined,
    breakError: '',
    expectExit: 0,
    ...over,
  } as EvalTask
}

describe('buildPrompt —— 翻译题', () => {
  it('判分口径：默认**开**，说清 stdout / 退出码 / 行尾归一', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'current')
    expect(p).toContain('判分口径')
    expect(p).toContain('stdout')
    expect(p).toContain('行尾')
    expect(p).toContain('退出码')
  })

  it('判分口径：`off` ⇒ 逐字复现旧 prompt（那一块整段消失）', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'current', undefined, { judgeRule: false })
    expect(p).not.toContain('判分口径')
    expect(p).not.toContain('行尾会归一')
  })

  it('环境契约：默认**开**，说清 gcc 在 PATH 上 / 只有 bash / 不用找产物', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'current')
    expect(p).toContain('gcc 就在 PATH 上')
    expect(p).toContain('只有 bash 可用')
    expect(p).toContain('不用')
  })

  it('环境契约：`off` ⇒ 整段消失（两个开关互不影响）', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'current', undefined, { envContract: false })
    expect(p).not.toContain('gcc 就在 PATH 上')
    // ⚠️ 关掉环境契约**不能**顺带关掉判分口径
    expect(p).toContain('判分口径')
  })

  it('⚠️ 不变式：prompt **绝不**含期望输出（泄露了 ⇒ 那道题就废了）', () => {
    const task = translateTask()
    const p = buildPrompt(task, 'main.jhyy', 'current')
    // 期望输出的**每一个**非空行都不许出现在 prompt 里
    for (const line of (task.expectStdout ?? '').split('\n').filter(Boolean)) {
      expect(p).not.toContain(line)
    }
  })

  it('⚠️ 不变式：prompt 不含判分脚本 / golden 的**路径**（点名=把答案位置告诉模型）', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'current')
    expect(p).not.toContain('difftest.py')
    expect(p).not.toContain('golden.json')
  })

  it('tight 风格同样带这两块契约', () => {
    const p = buildPrompt(translateTask(), 'main.jhyy', 'tight')
    expect(p).toContain('判分口径')
    expect(p).toContain('gcc 就在 PATH 上')
  })
})
