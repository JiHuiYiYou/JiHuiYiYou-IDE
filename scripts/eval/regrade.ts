/**
 * 离线重判 —— 用**当前的判分器**重判一次已经跑过的评测。
 *
 *     npx vite-node scripts/eval/regrade.ts <旧的.jsonl> [<新的.jsonl>]
 *
 * ## 为什么需要它
 *
 * 评测一次要花 ~$8 / ~1 小时（32 道题 × 一臂）。但**判分器本身会改**
 * （实测：有些语料会打印堆指针地址 ⇒ 逐字比对天然不稳定 ⇒ 得改用 EXPECT-OUT 判）。
 *
 * ⇒ 判分器一改，如果重跑 ⇒ 又要花一次钱。
 * ⇒ **但每次运行的每一版源码都存下来了**（`versionSources`）⇒
 *   **离线重判就行 ⇒ 零 API 成本**。
 *
 * ## 它做什么
 *
 * 1. 读**当前**的 `eval/tasks.json`（判据的真相源：期望 stdout / 退出码）
 * 2. 读旧的 JSONL（每条记录带 `versionSources`）
 * 3. 把每一版源码重新落盘、重新编译、重新运行、重新判分
 * 4. 算出新的首过 / 最终通过，写出新的 JSONL
 *
 * ⚠️ **只重判「模型写的版本」** —— 版本 0 是**坏版本**（题目本身），
 *    它的编译失败是**题目设计**，不是模型失败 ⇒ 重判时跳过它，
 *    只判版本 1..n ⇒ 首过/最终的语义跟原 harness 一致。
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { findCompiler, findLangRepo, ideRoot } from '../../tests/helpers/repo'
import { grade } from './grader'
import type { EvalTask } from './tasks'

interface RunRecord {
  taskId: string
  arm: string
  repeat: number
  mutationId: string
  rule: string
  firstPass: boolean
  finalPass: boolean
  versions: number
  usedCompiler: boolean
  reason?: string
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; turns?: number }
  grades: { passed: boolean; reason?: string }[]
  versionSources?: string[]
}

async function main() {
  const [src, dstArg] = process.argv.slice(2)
  if (!src) {
    console.error('用法：npx vite-node scripts/eval/regrade.ts <旧的.jsonl> [<新的.jsonl>]')
    process.exit(1)
  }
  const dst = dstArg ?? join(ideRoot, 'eval', 'out', `regraded-${basename(src)}`)

  const tasksFile = join(ideRoot, 'eval', 'tasks.json')
  const taskFile = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: EvalTask[] }
  const taskById = new Map(taskFile.tasks.map((t) => [t.id, t]))

  // ⚠️ 产物名标签（见下面 outBase 处的说明）
  const outTag = Date.now().toString(36) + process.pid.toString(36)

  const exePath = findCompiler()
  if (!exePath) {
    console.error('✗ 找不到编译器')
    process.exit(1)
  }
  const cwd = findLangRepo() ?? process.cwd()
  const corpusRoot = join(cwd, 'compiler', 'tests', 'examples')

  const records: RunRecord[] = []
  for (const line of readFileSync(src, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    records.push(JSON.parse(t) as RunRecord)
  }

  const out: RunRecord[] = []
  let changed = 0

  for (const rec of records) {
    const task = taskById.get(rec.taskId)
    if (!task) {
      console.warn(`⚠ 任务不在当前任务集里，跳过：${rec.taskId}`)
      continue
    }
    const versions = rec.versionSources ?? []
    // 版本 0 是**坏版本**（题目）⇒ 只判 1..n
    const modelVersions = versions.slice(1)
    if (modelVersions.length === 0) {
      out.push(rec)
      continue
    }

    // ⚠️ **必须复刻 harness 的工作区** —— 只把源文件丢到一个空目录里编译是不行的：
    //   语料会 `import mylib;` 之类的**同目录依赖** ⇒ 缺了就编不过
    //   （实测：不带工作区 ⇒ 4 个 import 用例全变成「编译失败（无诊断）」）
    const scratch = mkdtempSync(join(tmpdir(), 'jhyy-regrade-'))
    const rel = rec.taskId.split('/').slice(1).join('/') + '.jhyy'
    for (const dep of task.workspace) {
      const dest = join(scratch, dep)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(corpusRoot, dep), dest)
    }
    const tmp = join(scratch, rel)
    mkdirSync(dirname(tmp), { recursive: true })

    const grades: { passed: boolean; reason?: string }[] = []
    let firstPass = false
    let finalPass = false
    for (let i = 0; i < modelVersions.length; i++) {
      writeFileSync(tmp, modelVersions[i], 'utf8')
      const g = await grade({
        task,
        file: tmp,
        exePath,
        cwd,
        // ⚠️ **产物名带本次运行的唯一标签** —— `compileFile()` 写进**共享的**
        //   work 目录 ⇒ 跟正在跑的评测**并发**会撞名 ⇒ 互相覆盖
        //   ⇒ 判分拿到的是对方的产物（实测踩过）。
        outBase: `regrade_${outTag}_${rec.taskId.replace(/[^\w]/g, '_')}_${i}`,
      })
      grades.push({ passed: g.passed, reason: g.reason })
      if (g.passed) firstPass = true
      if (g.passed && i === modelVersions.length - 1) finalPass = true
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* 删不掉就算了（Windows 上刚跑完的 exe 可能还占着） */
    }

    const before = `${rec.firstPass}/${rec.finalPass}`
    const after = `${firstPass}/${finalPass}`
    if (before !== after) {
      changed++
      console.log(`  变了：${rec.taskId.padEnd(38)} ${before} → ${after}`)
    }

    out.push({
      ...rec,
      firstPass,
      finalPass,
      grades,
      reason: grades.find((g) => !g.passed)?.reason,
    })
  }

  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const first = out.filter((r) => r.firstPass).length
  const final = out.filter((r) => r.finalPass).length
  console.log(`\n重判 ${out.length} 条，其中 ${changed} 条结论变了`)
  console.log(`首过 ${first}/${out.length} · 最终 ${final}/${out.length}`)
  console.log(`→ ${dst}`)
}

await main()
