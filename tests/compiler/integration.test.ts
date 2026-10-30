import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { locateJhyy } from '../../src/main/compiler/locate'
import { compileFile, runFile } from '../../src/main/compiler/runner'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'jhyy-ide-test-'))

let exePath: string

beforeAll(async () => {
  const toolchain = await locateJhyy(repoRoot)
  if (!toolchain.available) {
    throw new Error(`找不到 jhyy 编译器：\n${toolchain.error ?? ''}`)
  }
  exePath = toolchain.exePath
})

function writeSource(name: string, body: string): string {
  const path = join(scratch, name)
  writeFileSync(path, body, 'utf8')
  return path
}

describe('编译器链路', () => {
  it('编译并运行一个正确的程序', async () => {
    const file = writeSource(
      'hello.jhyy',
      ['extern fn printf(fmt: *u8, val: i32) -> i32;', '', 'fn main_jhyy() -> i32 {', '    printf("hi\\n", 42);', '    0', '}', ''].join('\n'),
    )

    const result = await runFile({ exePath, file })

    expect(result.ok).toBe(true)
    expect(result.ran).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.programStdout).toContain('hi')
    expect(result.crashed).toBe(false)
  })

  it('程序的返回值就是退出码', async () => {
    const file = writeSource('exitcode.jhyy', 'fn main_jhyy() -> i32 {\n    42\n}\n')
    const result = await runFile({ exePath, file })
    expect(result.exitCode).toBe(42)
    // 非零退出码不等于崩溃
    expect(result.crashed).toBe(false)
  })

  it('类型错误被报成带位置的诊断', async () => {
    const file = writeSource(
      'badtype.jhyy',
      ['fn main_jhyy() -> i32 {', '    let x: i32 = "not an int";', '    x', '}', ''].join('\n'),
    )

    const result = await compileFile({ exePath, file, noLink: true })

    expect(result.ok).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    const d = result.diagnostics[0]
    expect(d.file).toContain('badtype.jhyy')
    expect(d.line).toBe(2)
    expect(d.severity).toBe('error')
    expect(d.message.length).toBeGreaterThan(0)
  })

  it('解析错误也带行列', async () => {
    const file = writeSource('parseerr.jhyy', 'fn main_jhyy() -> i32 {\n    let = 3;\n}\n')
    const result = await compileFile({ exePath, file, noLink: true })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0].line).toBeGreaterThan(0)
  })

  it('编译产物不落在源文件旁边', async () => {
    const file = writeSource('artifacts.jhyy', 'fn main_jhyy() -> i32 {\n    0\n}\n')
    await compileFile({ exePath, file })
    // scratch 目录里除了源文件不该多出 .exe / .s
    const { readdirSync } = await import('node:fs')
    const produced = readdirSync(scratch).filter((f) => f.endsWith('.exe') || f.endsWith('.s'))
    expect(produced).toEqual([])
  })

  /**
   * 程序的 stdin 得是**一根管道**，而且外面能往里写。
   *
   * ⚠️ 以前 stdin 接到的是**空设备** ⇒ 读 stdin 的程序立刻拿到 EOF ⇒
   * `scanf` 直接返回、程序跑过去了（用户报过「scanf 是坏的，
   * 他根本就不会让我读，直接就跳到后面了」）。
   */
  it('程序的 stdin 能收到输入（scanf 能读）', async () => {
    const file = writeSource(
      'scanfin.jhyy',
      [
        'extern fn scanf(fmt: *u8, val: *i32) -> i32;',
        'extern fn printf(fmt: *u8, val: i32) -> i32;',
        '',
        'fn main_jhyy() -> i32 {',
        '    let mut n: i32 = 0;',
        '    scanf("%d", &n);',
        '    printf("got %d\\n", n);',
        '    0',
        '}',
        '',
      ].join('\n'),
    )

    let fed = false
    const result = await runFile({
      exePath,
      file,
      timeoutMs: 20_000,
      onProgramStart: (writeStdin) => {
        // 程序刚起来 ⇒ 喂一行进去（模拟用户在终端里敲字）
        setTimeout(() => {
          writeStdin('42\n')
          fed = true
        }, 300)
      },
    })

    expect(fed, '程序启动后应该拿到写 stdin 的能力').toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.programStdout).toContain('got 42')
  })
})
