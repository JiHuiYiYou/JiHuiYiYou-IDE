/**
 * 评测任务构建 —— 从语言仓库的回归语料里长出「一道题」。
 *
 * ## 一道题长什么样
 *
 * 语料里有一段**能编译、行为正确**的 JHYY 代码（带 EXPECT 判据）。
 * 我们按某个反直觉规则把它**改坏一处** ⇒ 得到一段编译不过的代码。
 * 题目 = 「把这段代码修好」。
 *
 * 判据（硬）：修好后 **编译通过** 且 **stdout / 退出码跟原文件一致**
 * ⇒ 「把出错那行删掉」蒙混不过（行为会变）。
 *
 * ## 为什么要「真编译验证」
 *
 * 变异是按模式匹配施加的，**不一定都能真的弄坏代码** —— 比如某个文件里
 * 恰好没有可变异的地方，或者变异后的代码碰巧还能编过。
 * ⇒ 构建时逐个**真编译一遍**：原文件必须过、变异后必须挂。
 * 挂不上的直接丢弃。**这是任务集质量的保证，不能省。**
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { compileFile, runFile } from '../../src/main/compiler/runner'
import {
  collectJhyyFiles,
  examplesDir,
  findCompiler,
  findLangRepo,
  isLibraryFile,
  readDirectives,
} from '../../tests/helpers/repo'
import { MUTATIONS, type BreakKind } from './mutations'

/** 一道评测题。 */
export interface EvalTask {
  /** 任务 id（评测报告按它分组） */
  id: string
  /**
   * 任务语言 —— `jhyy`（默认）/ `c`（**对照组**：同一个算法用大众语言实现）。
   *
   * ⚠️ C 对照组的语料来自语言仓 `bench/difftest.py` 的随机程序生成器 ——
   *   同一个 AST 生成 C 和 JHYY 两个实现 ⇒ **严格配对**。
   */
  lang?: 'jhyy' | 'c'
  /**
   * 配对组 id（`变异/种子`）—— **同一个 AST 的 C 与 JHYY 两个实现共用**。
   * ⇒ 用来做「同一道题、两种语言」的严格对照。
   */
  pairId?: string
  /** 用的是哪个变异 */
  mutationId: string
  /** 变异对应的规则引用（规范章节号） */
  rule: string
  /** 破坏方式 */
  kind: BreakKind
  /** 规则的人读描述 */
  title: string
  /** 语料源文件的绝对路径 */
  sourceFile: string
  /** 变异后的代码 —— 交给模型修的就是它 */
  broken: string
  /** 修好后期望的退出码（来自原文件的 EXPECT 指令） */
  expectExit?: number
  /** 修好后期望 stdout 包含的子串（来自 EXPECT-OUT 指令） */
  expectOut?: string
  /**
   * **坏版本**跑出来的实际 stdout（只有行为变异题有）。
   *
   * ⚠️ 为什么要它：行为变异题**能编译**，只说「编译不过」⇒ 模型编译一次发现过了
   *   ⇒ 认为没问题 ⇒ **交卷不改**（实测 C 侧整类题全挂）。
   *   ⇒ prompt 必须说「能编译但输出不对」并把**实际输出 + 期望输出**都给出来。
   */
  actualStdout?: string
  /**
   * 原文件的**精确 stdout** —— 判据的主依据。
   *
   * ⚠️ 为什么不能只靠退出码：`expectExit: 0` 的任务（很多）光看退出码判不住 ——
   * 模型把整个函数体重写成 `return 0;` 也能退出 0 ⇒ 白送分。
   * 逐字比对 stdout 才堵得住「删代码 / 重写成空壳」。
   */
  expectStdout?: string
  /** 变异后编译器报的第一条错（写进 prompt 当线索） */
  breakError?: string
  /** 工作区里要放哪些文件（相对语料根目录） */
  workspace: string[]
}

/** 构建时被丢弃的候选（带原因）—— 报告里要能看到，否则「为什么少了几道题」没人知道。 */
export interface SkippedCandidate {
  file: string
  mutationId: string
  reason: string
}

/** 构建结果。 */
export interface BuiltTasks {
  tasks: EvalTask[]
  skipped: SkippedCandidate[]
}

/** 构建选项。 */
export interface BuildOptions {
  /** 每个变异最多出几道题 */
  perMutation?: number
  /** 总共最多几道题 */
  total?: number
}

/**
 * 收集一个文件的工作区依赖（`import X;` 指向的同目录 .jhyy，递归）。
 *
 * 语料里 `import_test.jhyy` 依赖同目录的 `mylib.jhyy` —— 工作区少了它就编不过，
 * 而那个失败跟我们要测的东西无关 ⇒ 会污染判据。
 */
function collectWorkspace(root: string, target: string): string[] {
  const files = new Set<string>([target])
  const queue = [target]
  while (queue.length > 0) {
    const cur = queue.pop()!
    const src = readFileSync(join(root, cur), 'utf8')
    for (const m of src.matchAll(/^\s*import\s+([\w:]+)\s*;/gm)) {
      const mod = m[1].split('::').pop()!
      // 先找同目录，再逐层往上找
      let dir = dirname(cur)
      let found: string | null = null
      for (let i = 0; i < 4 && !found; i++) {
        const candidate = join(dir, `${mod}.jhyy`)
        if (existsSync(join(root, candidate))) found = candidate
        else dir = dirname(dir)
      }
      if (found && !files.has(found)) {
        files.add(found)
        queue.push(found)
      }
    }
  }
  return [...files].sort()
}

/** 一道题能不能当题：语料文件必须带断言、不能是 SKIP/XFAIL、不能是库文件。 */
function usableAsTask(src: string): { ok: boolean; reason?: string } {
  const d = readDirectives(src)
  if (d.skip) return { ok: false, reason: 'SKIP' }
  if (d.xfail) return { ok: false, reason: 'XFAIL' }
  if (d.expectError) return { ok: false, reason: 'EXPECT-ERROR（本来就是要编译失败）' }
  if (isLibraryFile(src)) return { ok: false, reason: '库文件（没有入口）' }
  if (d.expectExit === undefined && d.expectOut === undefined) {
    return { ok: false, reason: '没有 EXPECT / EXPECT-OUT 判据（修好后无从比对行为）' }
  }
  return { ok: true }
}

/** 编译一次，返回是否成功 + 第一条错误。 */
async function tryCompile(
  exePath: string,
  file: string,
  outBase: string,
): Promise<{ ok: boolean; firstError?: string }> {
  const res = await compileFile({ exePath, file, noLink: false, timeoutMs: 30_000, outBase })
  if (res.ok) return { ok: true }
  const first = res.diagnostics.find((d) => d.severity === 'error')
  if (first) return { ok: false, firstError: first.message }
  // ⚠️ 没有 error 级诊断 ⇒ 失败发生在**链接期**（比如入口写成 `fn main` ⇒
  // gcc 报 `undefined reference to 'main'`）。这时 `raw` 里全是编译器的
  // 进度噪声（`[1] imports start` 之类）⇒ 过滤掉再取最后几行。
  const meaningful = res.raw.filter((l) => l.trim() && !/^\[\d/.test(l.trim()))
  return { ok: false, firstError: meaningful.slice(-3).join(' | ') || '编译失败（无诊断）' }
}

/**
 * 构建任务集。
 *
 * ⚠️ 会**真编译**每个候选（原文件 + 变异体）⇒ 慢（每个 ~2-3 s）。
 * 构建一次，把结果存成 JSON 就行 —— 别每次评测都重建。
 */
export async function buildTasks(opts: BuildOptions = {}): Promise<BuiltTasks> {
  const perMutation = opts.perMutation ?? 8
  const totalCap = opts.total ?? 40

  const root = examplesDir()
  const exePath = findCompiler()
  if (!root || !exePath) {
    throw new Error('找不到语言仓库语料或编译器 —— 评测需要 JiHuiYiYou 仓（兄弟目录）。')
  }

  const tasks: EvalTask[] = []
  const skipped: SkippedCandidate[] = []
  const perMutCount = new Map<string, number>()

  const all = collectJhyyFiles(root).filter((f) => !f.endsWith('.exe'))

  // ⚠️ **顺序要紧：先过滤，再采样。**
  // 反过来（先采样再过滤）的话，样本里大半是 EXPECT-ERROR / SKIP / 库文件
  // —— 实测 12 个样本只剩 1 个能用 ⇒ 任务集从 16 道塌到 5 道。
  const usableFiles = all.filter((f) => {
    const src = readFileSync(f, 'utf8')
    return usableAsTask(src).ok
  })

  for (const mutation of MUTATIONS) {
    // ⚠️ **别按 readdir 顺序取前 N 个** —— 那是字母序最靠前的一批（`abi_test`、
    // `agg_eq_*`…），任务集会长得一模一样，测不到语料的多样性。
    // ⇒ **均匀采样**：把候选按名字排序后按步长跨着取。
    const applicable = usableFiles.filter((f) => mutation.appliesTo(readFileSync(f, 'utf8')))
    // ⚠️ 采样池给得宽一点（40）：`apply()` 返回 null 几乎不花钱（不编译），
    // 只有真正变异出东西的候选才会走编译 ⇒ 池子宽一点几乎不增加成本，
    // 但能捞到稀有形态的语料（比如只有 match_range.jhyy 有字面量区间）。
    const candidates = spread(applicable, 40)
    for (const file of candidates) {
      if ((perMutCount.get(mutation.id) ?? 0) >= perMutation) break
      if (tasks.length >= totalCap) break

      const rel = relative(root, file).replace(/\\/g, '/')
      const src = readFileSync(file, 'utf8')

      const broken = mutation.apply(src)
      if (!broken || broken === src) continue

      // ── 原文件先过一遍 ────────────────────────────────────
      // 原文件必须**能过能跑** —— 否则这道题没有「正确答案」可言。
      const origCheck = await tryCompile(exePath, file, `eval_orig_${tasks.length}`)
      if (!origCheck.ok) {
        skipped.push({ file: rel, mutationId: mutation.id, reason: `原文件自己就编不过：${origCheck.firstError}` })
        continue
      }
      // ⚠️ **原文件也要在「临时工作区」里跑** —— 跟判分时**同条件**。
      //   有些语料打印的**地址依赖二进制布局**（实测 `arena_test` 打印
      //   `p1=-968043984`）⇒ 在语料目录跑和在临时工作区跑**地址不一样**
      //   ⇒ 在语料目录跑两遍是「稳定」的，骗过了检测。
      //   ⇒ 复制到临时工作区再跑，地址照样每次变（进程级 ASLR）
      //   ⇒ 稳定性检测才抓得住。
      const scratch = mkdtempSync(join(tmpdir(), 'jhyy-build-'))
      const origInScratch = join(scratch, rel)
      mkdirSync(dirname(origInScratch), { recursive: true })
      for (const dep of collectWorkspace(root, rel)) {
        const dest = join(scratch, dep)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(join(root, dep), dest)
      }
      const origRun = await runFile({
        exePath,
        file: origInScratch,
        timeoutMs: 20_000,
        cwd: findLangRepo() ?? dirname(file),
        env: readDirectives(src).setenv,
        // ⚠️ stdin 接空设备（立刻 EOF）—— 跟回归 harness 同口径（见 grader 的注释）
        stdinPipe: false,
      })

      // ⚠️ **输出稳定性检测 —— 跑两遍比。**
      //   有些语料会打印**堆指针地址**（实测 `arena_test` 打印 `p1=-968043984`
      //   ⇒ 每次跑都不一样）⇒ 逐字比对**天然不稳定** ⇒ 模型改对了也会被判失败。
      //   有些语料是**随机游戏**（实测 `dungeon_game` 的期望输出是「最终金币：0」
      //   ⇒ 两次跑金币数不一样）⇒ 连 EXPECT-OUT 都不可信。
      //
      //   ⇒ 三档：
      //     ① 两次 stdout **完全一样** ⇒ 逐字比（最强判据）
      //     ② 不一样，但 **EXPECT-OUT 子串在两次里都出现** ⇒ 只用子串判
      //     ③ 子串也不稳定 / 没有子串 ⇒ **这道题判不了** ⇒ 丢弃
      const origRun2 = await runFile({
        exePath,
        file: origInScratch,
        timeoutMs: 20_000,
        cwd: findLangRepo() ?? dirname(file),
        env: readDirectives(src).setenv,
        // ⚠️ stdin 接空设备（立刻 EOF）—— 跟回归 harness 同口径（见 grader 的注释）
        stdinPipe: false,
      })
      rmSync(scratch, { recursive: true, force: true })

      if (!origRun.ok || !origRun.ran) {
        const why =
          origRun.diagnostics.find((d) => d.severity === 'error')?.message ??
          `退出码 ${origRun.exitCode}`
        skipped.push({ file: rel, mutationId: mutation.id, reason: `原文件跑不起来：${why}` })
        continue
      }

      const stdoutStable = origRun2.programStdout === origRun.programStdout
      const expectOut = readDirectives(src).expectOut
      const expectOutStable =
        expectOut !== undefined &&
        origRun.programStdout.includes(expectOut) &&
        origRun2.programStdout.includes(expectOut)
      if (!stdoutStable && !expectOutStable) {
        skipped.push({
          file: rel,
          mutationId: mutation.id,
          reason: '原文件输出不稳定（两次跑不一样），EXPECT-OUT 也不稳 ⇒ 判不了',
        })
        continue
      }

      // ── 变异体必须**真的坏掉** ────────────────────────────
      // 两种坏法不一样，验法也不一样：
      //   compile-break  ⇒ 必须编译不过
      //   behavior-break ⇒ 必须还能编译，但**行为变了**（stdout 不同）
      const brokenPath = join(dirname(file), `.eval-broken-${basename(file)}`)
      writeFileSync(brokenPath, broken, 'utf8')
      // ⚠️ **变异文件要活到所有检查做完** —— 行为变异还得跑它一遍
      // （之前在 finally 里就删了 ⇒ runFile 拿到的是不存在的文件 ⇒
      //   行为变异类任务全被判成「跑不起来」⇒ 一道都产不出来）
      let brokenCheck: { ok: boolean; firstError?: string } = { ok: false }
      try {
        brokenCheck = await tryCompile(exePath, brokenPath, `eval_broken_${tasks.length}`)

        if (mutation.kind === 'compile-break') {
          if (brokenCheck.ok) {
            skipped.push({ file: rel, mutationId: mutation.id, reason: '变异后仍然能编译（没真坏掉）' })
            continue
          }
        } else {
          // behavior-break：必须还能编译，且跑出来跟原文件**不一样**
          if (!brokenCheck.ok) {
            skipped.push({
              file: rel,
              mutationId: mutation.id,
              reason: `行为变异却编译不过了：${brokenCheck.firstError}`,
            })
            continue
          }
          const brokenRun = await runFile({
            exePath,
            file: brokenPath,
            timeoutMs: 20_000,
            cwd: findLangRepo() ?? dirname(file),
            env: readDirectives(src).setenv,
          })
          if (!brokenRun.ok || !brokenRun.ran) {
            skipped.push({ file: rel, mutationId: mutation.id, reason: '行为变异后跑不起来' })
            continue
          }
          const sameOut = brokenRun.programStdout === origRun.programStdout
          const sameExit = (brokenRun.exitCode ?? 0) === (origRun.exitCode ?? 0)
          if (sameOut && sameExit) {
            skipped.push({ file: rel, mutationId: mutation.id, reason: '变异后行为跟原来一样（没真坏掉）' })
            continue
          }
        }
      } finally {
        // ⚠️ **变异文件要活到所有检查做完** —— 行为变异还得跑它一遍
        // （之前在 compile 完就删了 ⇒ runFile 拿到不存在的文件 ⇒
        //   行为变异类任务全被判成「跑不起来」⇒ 一道都产不出来）
        try {
          unlinkSync(brokenPath)
        } catch {
          /* 清理失败不致命 */
        }
      }

      const d = readDirectives(src)
      tasks.push({
        id: `${mutation.id}/${rel.replace(/\.jhyy$/, '')}`,
        mutationId: mutation.id,
        rule: mutation.rule,
        kind: mutation.kind,
        title: mutation.title,
        sourceFile: file,
        broken,
        expectExit: d.expectExit,
        expectOut: d.expectOut,
        expectStdout: stdoutStable ? origRun.programStdout : undefined,
        breakError: brokenCheck.firstError,
        workspace: collectWorkspace(root, rel),
      })
      perMutCount.set(mutation.id, (perMutCount.get(mutation.id) ?? 0) + 1)
    }
  }

  return { tasks, skipped }
}

/**
 * 均匀采样：把候选按路径排序，按步长跨着取 `count` 个。
 *
 * ⚠️ 目的是**打散选择偏差** —— 语料按 readdir 排出来是字母序，
 * 直接取前 N 个 ⇒ 任务全是 `a` 开头的文件，测不到多样性。
 */
function spread(files: string[], count: number): string[] {
  const sorted = [...files].sort()
  if (sorted.length <= count) return sorted
  const step = sorted.length / count
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(sorted[Math.floor(i * step)])
  return out
}

/** 语料根目录（构建任务时要用）。 */
export function corpusRoot(): string {
  const root = examplesDir()
  if (!root) throw new Error('找不到语言仓库语料目录。')
  return resolve(root)
}
