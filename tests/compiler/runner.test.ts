import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileContents, isControlCExit, ntstatusName } from '../../src/main/compiler/runner'
import { listCandidates, probeJhyy } from '../../src/main/compiler/locate'

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

/**
 * **后台实时诊断：编的是「编辑器里现在这段」，不是磁盘上的旧文件。**
 *
 * ⚠️ 以前后台诊断直接编磁盘上那份 ⇒ **边打字边不报错**（用户改错了都看不见）✗
 *    而且诊断的行/列是**旧版本**的 ⇒ 波浪线落在错的行上 ✗
 */
describe('compileContents（编「编辑器里现在这段」）', () => {
  /** 找一个能用的编译器；找不到就跳过。 */
  async function findCompiler(): Promise<string | null> {
    for (const candidate of listCandidates(process.cwd())) {
      const probe = await probeJhyy(candidate.exePath)
      if (probe.ok) return candidate.exePath
    }
    return null
  }

  it('**编的是给的那段内容**，诊断的行号对着它，文件名换回用户的文件', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const dir = mkdtempSync(join(tmpdir(), 'jhyy-contents-'))
    mkdirSync(join(dir, 'compiler', 'build', 'obj'), { recursive: true })
    const src = join(dir, 'a.jhyy')
    // ⚠️ **磁盘上是一份好的**（模拟「上次存盘时是对的」）
    writeFileSync(src, 'fn main_jhyy() -> i32 { 0 }\n', 'utf8')

    const result = await compileContents({
      exePath: compiler,
      file: src,
      // ⚠️ **给的内容有语法错误**（模拟「用户刚敲错了一行」）
      contents: 'fn main_jhyy() -> i32 {\n    let x: i32 = "oops"\n    0\n}\n',
      noLink: true,
      timeoutMs: 60_000,
    })

    expect(result.ok, '有语法错误 ⇒ 编译不通过').toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    const d = result.diagnostics[0]
    /*
      ⚠️ **行号必须对着「给的那段内容」** ——
        磁盘上那份只有 **1 行** ⇒ 报在第 1 行就说明**编的是旧文件** ✗
        （编译器把「缺分号」的错报在**下一个 token** 那一行 ⇒ 这里是第 3 行 ✓）
    */
    expect(d.line).toBeGreaterThan(1)
    // ⚠️ **文件名换回用户的文件**（不然「问题」面板里点路径跳不过去）✓
    expect(d.file).toBe(src)
    // ⚠️ **临时文件编完就删** —— 不留垃圾在用户的项目目录里 ✓
    expect(existsSync(join(dir, '.jhyy-ide-diag-a'))).toBe(false)
  })

  it('**本地模块的 import 照样能解析**（临时文件放在源文件旁边）', async () => {
    const compiler = await findCompiler()
    if (!compiler) return

    const dir = mkdtempSync(join(tmpdir(), 'jhyy-contents2-'))
    mkdirSync(join(dir, 'compiler', 'build', 'obj'), { recursive: true })
    // ⚠️ **本地模块**（不是标准库）⇒ 编译器先在**主文件旁边**找它
    writeFileSync(join(dir, 'mymod.jhyy'), 'fn helper() -> i32 {\n    42\n}\n', 'utf8')
    const src = join(dir, 'a.jhyy')
    writeFileSync(src, 'import mymod;\nfn main_jhyy() -> i32 { helper() }\n', 'utf8')

    const result = await compileContents({
      exePath: compiler,
      file: src,
      contents: 'import mymod;\nfn main_jhyy() -> i32 { helper() }\n',
      noLink: true,
      timeoutMs: 60_000,
    })
    // ⚠️ **不能报「cannot open import」** —— 那是**假诊断** ✗
    expect(result.stderr).not.toMatch(/cannot open import/i)
    expect(result.ok).toBe(true)
  })
})
