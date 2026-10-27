import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** IDE 仓库根目录。 */
export const ideRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * 找语言仓库（JiHuiYiYou）。
 * IDE 仓库和语言仓库通常是兄弟目录：`coding/JiHuiYiYou-IDE` 和 `coding/JiHuiYiYou`。
 */
export function findLangRepo(): string | null {
  let dir = ideRoot
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'JiHuiYiYou')
    if (existsSync(join(candidate, 'compiler', 'src0', 'main.jhyy'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 编译器的可执行文件。 */
export function findCompiler(): string | null {
  const repo = findLangRepo()
  if (!repo) return null
  const dev = join(repo, 'compiler', 'build', 'bin', 'jhyy.exe')
  if (existsSync(dev)) return dev
  const installed = 'C:\\Program Files\\JHYY\\bin\\jhyy.exe'
  if (existsSync(installed)) return installed
  return null
}

/** 语言仓库的示例语料目录。 */
export function examplesDir(): string | null {
  const repo = findLangRepo()
  if (!repo) return null
  const dir = join(repo, 'compiler', 'tests', 'examples')
  return existsSync(dir) ? dir : null
}

/** 递归收集所有 .jhyy 文件。 */
export function collectJhyyFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectJhyyFiles(full))
    } else if (entry.endsWith('.jhyy')) {
      out.push(full)
    }
  }
  return out.sort()
}

/**
 * 取一行里**第一个不在字符串字面量中的 `//` 之后**的文本。
 * 必须跳过字符串：`let s = "// EXPECT: 42";` 这种不该被判成一条指令。
 */
function commentTail(line: string): string {
  let inStr: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\' && i + 1 < line.length) {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") {
      inStr = c
      continue
    }
    if (c === '/' && line[i + 1] === '/') return line.slice(i + 2)
  }
  return ''
}

/**
 * 只保留「注释部分就是一条指令」的行。
 *
 * 不能直接在全文里搜 —— 那样**散文里提到一个指令就会凭空生成一条断言**
 * （语言仓库实测踩过：注释里写「此前是 `//EXPECT:42`」，结果那条真的成了断言）。
 * 规则跟语言仓库的 `scripts/dev/audit_test_assertions.py:directive_source` 一致：
 * 取该行第一个不在字符串里的 `//` 之后的文本，去掉空白后必须以指令关键字开头。
 */
function directiveSource(raw: string): string {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const tail = commentTail(line)
    if (tail && /^\s*(EXPECT|EXPECT-ERROR|EXPECT-OUT|XFAIL|SKIP|SKIP-QBE|SETENV)/.test(tail)) {
      out.push(`//${tail}`)
    }
  }
  return out.join('\n')
}

/** 测试指令（对齐 mcp-jhyy/jhyy_regress.py 的正则 + 独立成行规则）。 */
export interface Directives {
  /** `// EXPECT: 42` —— 期望退出码 */
  expectExit?: number
  /** `// EXPECT-OUT: "substr"` —— 期望 stdout 含该子串 */
  expectOut?: string
  /** `// EXPECT-ERROR: "kw"` —— 期望编译失败且 stderr 含该关键词 */
  expectError?: string
  /** `// XFAIL: reason` —— 预期失败 */
  xfail: boolean
  /** `// SKIP: reason` —— 跳过 */
  skip: boolean
  skipReason?: string
}

export function readDirectives(src: string): Directives {
  // ⚠️ 只看「独立成行的指令」—— 见 directive_source 的说明
  const text = directiveSource(src)
  const m = text.match(/\/\/\s*EXPECT(?:ECT)?\s*[:=]\s*(\d+)/)
  const mErr = text.match(/\/\/\s*EXPECT-ERROR\s*[:=]\s*"([^"]+)"/)
  const mOut = text.match(/\/\/\s*EXPECT-OUT\s*[:=]\s*"([^"]+)"/)
  const mSkip = text.match(/\/\/\s*SKIP\s*[:=]\s*(.*)/)
  const mXfail = text.match(/\/\/\s*XFAIL\s*[:=]\s*(.*)/)

  return {
    expectExit: m ? Number(m[1]) : undefined,
    expectOut: mOut ? mOut[1] : undefined,
    expectError: mErr ? mErr[1] : undefined,
    xfail: Boolean(mXfail),
    skip: Boolean(mSkip),
    skipReason: mSkip?.[1]?.trim(),
  }
}

/**
 * 剥掉注释 —— 只看代码结构时用。
 * 否则注释里提到 `fn main_jhyy` 会让一个没有 main 的文件被当成可跑测试。
 */
export function stripComments(src: string): string {
  let out = ''
  let inStr: string | null = null
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inBlock) {
      if (c === '*' && src[i + 1] === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < src.length) {
        out += src[++i]
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") {
      inStr = c
      out += c
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * 这个文件是不是"库文件"（没有入口函数）？
 *
 * 语言仓库的 harness 会**自动跳过**没有入口的库文件 —— 它们是给别的文件
 * `import` 的。IDE 的一致性测试要跟这个规则一致：库文件单独编译时的失败
 * （比如 import 成环）不代表 IDE 打印的代码有问题。
 */
export function isLibraryFile(src: string): boolean {
  // ⚠️ 用**剥掉注释**的源码判定 —— 否则注释里提到 `fn main_jhyy` 会误判
  const code = stripComments(src)
  const hasMain = /^\s*fn\s+main_jhyy\s*\(/m.test(code)
  const hasNoStdMain = /^\s*fn\s+main\s*\(/m.test(code)
  return !hasMain && !hasNoStdMain
}
