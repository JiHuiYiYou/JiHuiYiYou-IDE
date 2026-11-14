/**
 * PostToolUse 钩子的单测 —— **模型写完 `.jhyy` ⇒ 自动编译 ⇒ 诊断回灌**。
 *
 * ## 它守什么
 *
 * 1. **改了 `.jhyy` 且编译不过** ⇒ 输出 `additionalContext`（带真实诊断）
 * 2. **改了 `.jhyy` 但编译过了** ⇒ 说一句「编译通过了（不代表输出对）」
 * 3. **改了别的文件** ⇒ 不出声
 * 4. **任何情况都 exit 0**（钩子绝不能阻断会话）
 *
 * ## ⚠️ 守住的那个真 bug（2026-11-13 挖到的）
 *
 * 入口写成 `fn main`（该是 `fn main_jhyy`）⇒ **链接期**才失败
 * ⇒ 编译器 stderr 里**没有** `file:line:col: error:` 形态的诊断
 * ⇒ 老版 hook 用「有没有结构化诊断」判断成功 ⇒ **注入「✓ 编译通过了」**
 * ⇒ **模型以为做完了 ⇒ 交了一份链接不过的代码**。
 *
 * ⇒ 现在用**退出码**判断 ⇒ 加一条专门的回归门：
 * **链接不过时，绝不能出现「编译通过」四个字**。
 *
 * ⚠️ 需要真实编译器（语言仓的兄弟目录）⇒ 找不到就跳过。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { errorFixPath } from '../../src/main/claude/jhyy-rules'
import { findCompiler, ideRoot } from '../helpers/repo'

const HOOK = resolve(ideRoot, 'scripts', 'jhyy-check-hook.mjs')
const COMPILER = findCompiler()
const FIX_TABLE = errorFixPath()

/** 跑一次钩子，喂一个 payload，返回 { stdout, status }。 */
function runHook(payload: unknown): { stdout: string; status: number | null } {
  const args = [HOOK, COMPILER ?? '']
  if (FIX_TABLE) args.push(FIX_TABLE)
  const res = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'C:/msys64/usr/bin/bash.exe' },
  })
  return { stdout: res.stdout ?? '', status: res.status }
}

/** 入口名写错 ⇒ **链接期**失败（没有结构化诊断）。 */
const BROKEN = 'fn main() -> i32 {\n    return 0;\n}\n'
/** 少声明 `printf` ⇒ **语义期**失败（有结构化诊断）。 */
const BROKEN_SEMA = [
  'extern fn printf(fmt: *u8, val: i32) -> i32;',
  '',
  'fn main_jhyy() -> i32 {',
  '    printf("hi\\n" as *u8, not_declared);',
  '    return 0;',
  '}',
].join('\n')
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
    expect(ctx.length).toBeGreaterThan(10)
  })

  // ⚠️ **这条守的是 2026-11-13 挖到的真 bug**
  it.skipIf(!COMPILER)('链接期失败 ⇒ **绝不能**说「编译通过」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-hook-'))
    const file = join(dir, 'link-broken.jhyy')
    writeFileSync(file, BROKEN, 'utf8')

    const { stdout } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: file },
    })

    const out = JSON.parse(stdout)
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    // ⚠️ 老版 hook 走的是「没有结构化诊断 ⇒ 编译通过了」⇒ 这条断言当时**抓不住**
    expect(ctx).not.toContain('编译通过')
    expect(ctx).toContain('链接不过')
    // 链接失败 ⇒ 得给出**针对性提示**（入口函数名）
    expect(ctx).toContain('main_jhyy')
  })

  it.skipIf(!COMPILER)('诊断里**顺带带上「怎么改」**（模型不用多调一次工具）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-hook-'))
    const file = join(dir, 'sema-broken.jhyy')
    writeFileSync(file, BROKEN_SEMA, 'utf8')

    const { stdout } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: file },
    })

    const out = JSON.parse(stdout)
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('undefined variable')
    if (FIX_TABLE) {
      // ⚠️ 有速查表 ⇒ 必须带上修法
      expect(ctx).toMatch(/怎么改|什么意思|见 /)
    }
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
    // ⚠️ **「编译过了」不等于「做对了」** —— 评测实测：`mask-change`
    //   （**能编译、但输出不对**）那类题上，老版的「✓ 编译通过了」
    //   让模型以为做完了 ⇒ 加一句免责。
    expect(out.hookSpecificOutput?.additionalContext).toContain('不代表输出对')
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
