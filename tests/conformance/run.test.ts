import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from '../../src/lang/parser'
import { print } from '../../src/lang/printer'
import { runFile } from '../../src/main/compiler/runner'
import {
  collectJhyyFiles,
  examplesDir,
  findCompiler,
  findLangRepo,
  isLibraryFile,
  readDirectives,
} from '../helpers/repo'

/**
 * 档 1 完整版 —— 真实编译 + 真实运行 + 比对 EXPECT 指令。
 *
 * 比 examples.test.ts（只编译不运行）多验一层：**打印出来的代码跑出来的行为
 * 跟原始源码一致**。这能抓住"打印结果语义变了但仍能编译"的 bug。
 *
 * 一次完整的编译 + gcc 链接要 ~6 秒，284 个例子要半小时 —— 所以：
 *   · 默认只跑一个代表性子集（每个特性都有覆盖）
 *   · 设 `JHY_CONFORMANCE_FULL=1` 跑全量
 */

const FULL = process.env.JHY_CONFORMANCE_FULL === '1'

const langRepo = examplesDir()
const compilerExe = findCompiler()
/** 语言仓库根目录 —— 程序的工作目录（有些例子用相对路径读写 compiler/build/bin/…） */
const repoRoot = findLangRepo() ?? langRepo ?? process.cwd()

if (!langRepo || !compilerExe) {
  throw new Error('找不到语言仓库或编译器 —— 一致性测试需要 JiHuiYiYou 仓库（兄弟目录）。')
}

const allFiles = collectJhyyFiles(langRepo)

/** 默认子集：每个语言特性挑一个代表。 */
const REPRESENTATIVE = [
  'arith.jhyy',
  'array_test.jhyy',
  'break_continue.jhyy',
  'closures_basic.jhyy',
  'control_flow.jhyy',
  'demo.jhyy',
  'enum_match_unit_variants.jhyy',
  'forloop.jhyy',
  'generics_fn_turbofish_basic.jhyy',
  'generics_struct.jhyy',
  'logical.jhyy',
  'match_range.jhyy',
  'pointer.jhyy',
  'slice_literal.jhyy',
  'struct.jhyy',
  'defer_basic.jhyy',
  // ⚠️ **读 stdin 的例子必须留在子集里** —— 它们的判据取 **EOF 路径**
  //（harness 的 stdin 接空设备 ⇒ `scanf` 立刻拿到 EOF ⇒ 变量保持初值）。
  // 一旦 IDE 改成「接管 stdin 管道」（那是 IDE 跑程序时该有的行为 ——
  // 好让用户在终端里打字喂进去），`scanf` 就会**一直等** ⇒ 程序跑到
  // 超时被杀 ⇒ stdout 空 ⇒ 门红。
  // v0.2.1 的 CI 就是这么红的：`input.jhyy` 和 `dungeon_game.jhyy` 两个例子
  // 挂了 —— 而当时的子集里**一个读 stdin 的例子都没有** ⇒ 默认 `npm test`
  // 全绿、放出去才炸。现在这两个例子进子集 ⇒ 默认跑就能拦住 ✓。
  'input.jhyy',
  'dungeon_game.jhyy',
  'float_cmp.jhyy',
  'chinese.jhyy',
  'ffi_multi.jhyy',
]

const files = FULL
  ? allFiles
  : allFiles.filter((f) => REPRESENTATIVE.includes(relative(langRepo, f).replace(/\\/g, '/')))

let scratch: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'jhyy-conformance-run-'))
  cpSync(langRepo, scratch, { recursive: true })
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('IDE 打印的代码跑起来行为一致', () => {
  it.each(files.map((f) => [relative(langRepo, f), f] as const))(
    '%s',
    async (relPath, origPath) => {
      const src = readFileSync(origPath, 'utf8')
      const directives = readDirectives(src)
      if (directives.skip || directives.xfail) return
      if (isLibraryFile(src)) return

      const parsed = parse(src)

      // 期望编译报错的用例：源码本来就是非法的 —— IDE 解析阶段就拒了也算对。
      // （IDE 解析通过但编译器拒，也是对的 —— 那是 sema 层的错误。）
      if (directives.expectError && parsed.errors.length > 0) return

      expect(parsed.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([])
      expect(parsed.module).not.toBeNull()

      const printed = print(parsed.module!)
      const printedPath = join(scratch, relPath)
      mkdirSync(dirname(printedPath), { recursive: true })
      writeFileSync(printedPath, printed, 'utf8')

      const result = await runFile({
        exePath: compilerExe,
        file: printedPath,
        timeoutMs: 20_000,
        // 跟语言仓库的回归 harness 一样：程序在**仓库根目录**下跑
        // （有些例子用相对路径读写 compiler/build/bin/…）
        cwd: repoRoot,
        // ⚠️ **stdin 接空设备（立刻 EOF）** —— 跟上游 harness 同口径
        // （`mcp-jhyy/jhyy_regress.py:141` 是 `stdin=subprocess.DEVNULL`）。
        //
        // 为什么必须这样：语料的判据就取 **EOF 路径**。
        // `compiler/tests/examples/input.jhyy` 的注释原文 ——
        // 「regress harness 跑测试时 stdin=subprocess.DEVNULL，所以
        //  `scanf("%d", &x)` 恒立刻读到 EOF，返回 EOF(-1) 且**不写** x。
        //  x 保持初值 0 → stdout 必须是 "你输入的是: 0"」。
        //
        // 接管管道（IDE 里跑程序就是那样，好让用户在终端里打字喂进去）的话，
        // `scanf` 会**一直等** ⇒ 程序跑到超时被杀 ⇒ stdout 空 ⇒ 门红。
        // ⇒ IDE 跑程序接管管道；**一致性门必须显式关掉**。
        stdinPipe: false,
        // `// SETENV: KEY=VALUE` —— 注入到编译 + 运行两个 env
        // （跟 mcp-jhyy/jhyy_regress.py:470-471 同口径）
        env: directives.setenv,
      })

      if (directives.expectError) {
        expect(result.ok, `期望编译失败但成功了：${printed}`).toBe(false)
        return
      }

      expect(
        result.ok,
        `编译失败：\n${result.stderr}\n${result.raw.join('\n')}\n---- 打印结果 ----\n${printed}`,
      ).toBe(true)

      if (directives.expectExit !== undefined) {
        // Windows 的进程退出码只保留低 8 位（bash 的 $? 也只读 %al）——
        // 语言仓库的 harness 就是用 `& 0xFF` 比较的。
        const actual = (result.exitCode ?? 0) & 0xff
        expect(
          actual,
          `退出码不对（期望 ${directives.expectExit & 0xff}，实际 ${result.exitCode}）：\n---- 打印结果 ----\n${printed}`,
        ).toBe(directives.expectExit & 0xff)
      }

      if (directives.expectOut !== undefined) {
        expect(
          result.programStdout,
          `stdout 里没有 "${directives.expectOut}"：\n---- 打印结果 ----\n${printed}`,
        ).toContain(directives.expectOut)
      }
    },
    120_000,
  )
})
