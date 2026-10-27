import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from '../../src/lang/parser'
import { print } from '../../src/lang/printer'
import { compileFile } from '../../src/main/compiler/runner'
import {
  collectJhyyFiles,
  examplesDir,
  findCompiler,
  isLibraryFile,
  readDirectives,
} from '../helpers/repo'

/**
 * 档 1 —— 真实编译器往返。
 *
 * 流程：IDE 解析 → IDE 打印 → **真实 jhyy.exe** 编译 → 校验诊断。
 *
 * 用 `--no-link`（只编译不链接）—— parse/sema 错误都在 codegen 之前报，
 * 链接对"打印出来的代码编译器认不认"没有额外信息，却要花 6 秒。
 * 完整的"编译 + 运行 + 比对 EXPECT"在 run.test.ts 里（慢，需要显式开启）。
 */

const langRepo = examplesDir()
const compilerExe = findCompiler()

if (!langRepo || !compilerExe) {
  throw new Error(
    '找不到语言仓库或编译器 —— 一致性测试需要 JiHuiYiYou 仓库（兄弟目录）。',
  )
}

let scratch: string

// 注意：文件列表在**模块加载时**算好（`it.each` 需要收集期就有数据），
// beforeAll 只负责把 examples 树复制到临时目录。
const files = collectJhyyFiles(langRepo)

beforeAll(() => {
  // 把整个 examples 树复制一份 —— 这样 `import` 的兄弟文件也能解析，
  // 而且不污染语言仓库
  scratch = mkdtempSync(join(tmpdir(), 'jhyy-conformance-'))
  cpSync(langRepo, scratch, { recursive: true })
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('IDE 解析器与真实编译器的一致性', () => {
  it('示例语料非空', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it.each(files.map((f) => [relative(langRepo, f), f] as const))(
    '%s — 解析 → 打印 → 真实编译器接受',
    async (relPath, origPath) => {
      const src = readFileSync(origPath, 'utf8')
      const directives = readDirectives(src)

      if (directives.skip) return
      // 库文件（没有入口函数）单独编译时的失败不代表 IDE 打印的代码有问题
      // —— 语言仓库的 harness 也是自动跳过它们的
      if (isLibraryFile(src)) return

      // ── 1. IDE 解析 ──
      const parsed = parse(src)
      if (parsed.errors.length > 0) {
        // 期望编译报错的用例：IDE 也拒绝了源码 —— 符合预期（IDE 的措辞可以
        // 和编译器不同，这里只关心"两边都认为这是非法代码"）
        if (directives.expectError) return
        const first = parsed.errors[0]
        throw new Error(
          `IDE 解析失败：${first.message}（${relPath}:${first.line}:${first.col}）\n` +
            `共 ${parsed.errors.length} 个错误`,
        )
      }

      // ── 2. IDE 打印 ──
      if (!parsed.module) throw new Error('解析出来没有 module')
      const printed = print(parsed.module)

      // 打印结果必须还能被 IDE 自己解析（往返自洽）
      const reparsed = parse(printed)
      if (reparsed.errors.length > 0) {
        const first = reparsed.errors[0]
        throw new Error(
          `打印结果不能被 IDE 自己重新解析：${first.message}（行 ${first.line}）\n` +
            `---- 打印结果 ----\n${printed}`,
        )
      }

      // ── 3. 真实编译器 ──
      // 写到临时副本的同一相对路径，让 import 仍然解析到同一批兄弟文件
      const printedPath = join(scratch, relPath)
      mkdirSync(dirname(printedPath), { recursive: true })
      writeFileSync(printedPath, printed, 'utf8')

      const result = await compileFile({
        exePath: compilerExe,
        file: printedPath,
        noLink: true,
        outBase: `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })

      if (directives.expectError) {
        // EXPECT-ERROR：编译必须失败，且 stderr 含该关键词
        if (result.ok) {
          throw new Error(
            `期望编译失败（EXPECT-ERROR: "${directives.expectError}"），但编译成功了。\n` +
              `---- 打印结果 ----\n${printed}`,
          )
        }
        const all = `${result.stderr}\n${result.raw.join('\n')}`
        if (!all.includes(directives.expectError)) {
          throw new Error(
            `编译确实失败了，但诊断里没有关键词 "${directives.expectError}"。\n` +
              `---- 编译器输出 ----\n${all}\n---- 打印结果 ----\n${printed}`,
          )
        }
        return
      }

      if (!result.ok) {
        throw new Error(
          `编译器拒绝了 IDE 打印出来的代码：\n` +
            `---- 编译器输出 ----\n${result.stderr}\n${result.raw.join('\n')}\n` +
            `---- 打印结果 ----\n${printed}`,
        )
      }
    },
    120_000,
  )
})
