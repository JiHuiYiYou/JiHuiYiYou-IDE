/**
 * PostToolUse 钩子的单测 —— **模型写完 `.jhyy` ⇒ 自动编译 ⇒ 诊断回灌**。
 *
 * ## 它守什么
 *
 * 1. **改了 `.jhyy` 且编译不过** ⇒ 输出 `additionalContext`（带真实诊断）
 * 2. **改了 `.jhyy` 但编译过了** ⇒ **不出声**（不注入噪音 = 不浪费上下文）
 * 3. **改了别的文件** ⇒ 不出声
 * 4. **任何情况都 exit 0**（钩子绝不能阻断会话）
 *
 * ⚠️ 需要真实编译器（语言仓的兄弟目录）⇒ 找不到就跳过。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findCompiler, ideRoot } from '../helpers/repo'

const HOOK = resolve(ideRoot, 'scripts', 'jhyy-check-hook.mjs')
const COMPILER = findCompiler()

/** 跑一次钩子，喂一个 payload，返回 { stdout, status }。 */
function runHook(payload: unknown): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, [HOOK, COMPILER ?? ''], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  return { stdout: res.stdout ?? '', status: res.status }
}

/** 一个编译不过的 JHYY 文件（入口名写错）。 */
const BROKEN = 'fn main() -> i32 {\n    return 0;\n}\n'
/** 一个能编译的。 */
const OK = 'fn main_jhyy() -> i32 {\n    return 0;\n}\n'

describe('PostToolUse 钩子', () => {
  it.skipIf(!COMPILER)('改了编译不过的 .jhyy ⇒ 把诊断注入上下文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-hook-'))
    const file = join(dir, 'broken.jhyy')
    writeFileSync(file, BROKEN, 'utf8')

    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: file },
    })

    expect(status).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('编译')
    expect(ctx).toContain(file)
    // 真实诊断（入口名写错 ⇒ 链接期失败 ⇒ 至少要有可读的错误信息）
    expect(ctx.length).toBeGreaterThan(10)
  })

  it.skipIf(!COMPILER)('改了能编译的 .jhyy ⇒ 说一句「编译通过了」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-hook-'))
    const file = join(dir, 'ok.jhyy')
    writeFileSync(file, OK, 'utf8')

    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: file },
    })

    expect(status).toBe(0)
    // ⚠️ **成功时也注入** —— 两个理由：
    //   ① 「注入真的进了模型上下文」这件事**每次**都可观测（否则模型一次就改对时
    //      注入路径根本测不到 ⇒ e2e 判不出来）
    //   ② **省一轮** —— 模型改完就知道编译过了 ⇒ 不用自己再编译一次确认
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(out.hookSpecificOutput?.additionalContext).toContain('编译通过')
    expect(out.tool_response?.success).toBe(true)
  })

  it('改了非 .jhyy 文件 ⇒ 不出声', () => {
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: join(tmpdir(), 'notes.md') },
    })
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('')
  })

  it('不是写文件的工具 ⇒ 不出声', () => {
    const { stdout, status } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: 'x.jhyy' },
    })
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('')
  })

  it('垃圾输入 ⇒ 仍然 exit 0（绝不能阻断会话）', () => {
    const res = spawnSync(process.execPath, [HOOK, COMPILER ?? ''], {
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    expect(res.status).toBe(0)
  })
})
