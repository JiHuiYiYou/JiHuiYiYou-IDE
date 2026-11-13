/**
 * A/B 对比 —— 两个臂的评测结果摆在一起看。
 *
 *     npx vite-node scripts/eval/compare.ts <臂A的jsonl> <臂B的jsonl>
 *
 * ## 输出什么
 *
 * | 指标 | 含义 | 为什么重要 |
 * |---|---|---|
 * | 首次写对 | 模型的**第一版**就通过的比例 | ≈「规则内化了」⇒ 知识包最直接的收益 |
 * | 最终写对 | 最后一次通过的比例 | 护栏（知识包不该让这个退步） |
 * | 平均轮数 | 模型花了多少轮才收敛 | **知识包的主要战场**（少绕几圈） |
 * | 平均成本 | 每次任务花多少钱 | 同上 |
 * | 按变异分组 | 哪条规则上差距最大 | **迭代知识包的抓手** |
 *
 * ## ⚠️ 两条诚实约束（必须随报告一起念）
 *
 * 1. **Claude Code CLI 没有 seed flag** ⇒ 单次结果不可信。
 *    ⇒ A/B 必须 **n≥3 次重复取中位数 + 报离散度**；本脚本按「每任务的中位数」聚合，
 *    并把 `n` 打在表头上 —— **n=1 的对比只能当方向，不能当结论**。
 * 2. **模型会自己变强** ⇒ 「知识包有效」**不能做成硬门**（某天模型自己会了，
 *    阈值断言就误红）。硬门只该断言「评测有区分力」和「知识包自洽」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

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
}

interface TaskStat {
  n: number
  firstRate: number
  finalRate: number
  turns: number
  cost: number
}

/** 读一个 JSONL，按任务聚合（多次重复取中位数）。 */
function load(file: string): Map<string, TaskStat> {
  const byTask = new Map<string, RunRecord[]>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const r = JSON.parse(t) as RunRecord
    const arr = byTask.get(r.taskId) ?? []
    arr.push(r)
    byTask.set(r.taskId, arr)
  }
  const out = new Map<string, TaskStat>()
  for (const [taskId, recs] of byTask) {
    const median = (xs: number[]): number => {
      if (xs.length === 0) return 0
      const s = [...xs].sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
    out.set(taskId, {
      n: recs.length,
      firstRate: median(recs.map((r) => (r.firstPass ? 1 : 0))),
      finalRate: median(recs.map((r) => (r.finalPass ? 1 : 0))),
      turns: median(recs.map((r) => r.usage?.turns ?? 0)),
      cost: median(recs.map((r) => r.usage?.costUsd ?? 0)),
    })
  }
  return out
}

/** 一组臂的汇总。 */
function summarize(byTask: Map<string, TaskStat>): {
  tasks: number
  n: number
  first: number
  final: number
  turns: number
  cost: number
  byMut: Map<string, { first: number; final: number; n: number; tasks: number }>
} {
  let first = 0
  let final = 0
  let turns = 0
  let cost = 0
  let minN = Infinity
  const byMut = new Map<string, { first: number; final: number; n: number; tasks: number }>()
  for (const [taskId, st] of byTask) {
    first += st.firstRate
    final += st.finalRate
    turns += st.turns
    cost += st.cost
    minN = Math.min(minN, st.n)
    const mut = taskId.split('/')[0]
    const e = byMut.get(mut) ?? { first: 0, final: 0, n: 0, tasks: 0 }
    e.first += st.firstRate
    e.final += st.finalRate
    e.n = Math.max(e.n, st.n)
    e.tasks++
    byMut.set(mut, e)
  }
  return {
    tasks: byTask.size,
    n: minN === Infinity ? 0 : minN,
    first,
    final,
    turns,
    cost,
    byMut,
  }
}

function pct(x: number, n: number): string {
  if (n === 0) return '—'
  return `${((x / n) * 100).toFixed(0)}%`
}

function main() {
  const [fileA, fileB] = process.argv.slice(2)
  if (!fileA || !fileB) {
    console.error('用法：npx vite-node scripts/eval/compare.ts <臂A.jsonl> <臂B.jsonl>')
    process.exit(1)
  }
  for (const f of [fileA, fileB]) {
    if (!existsSync(f)) {
      console.error(`✗ 找不到 ${f}`)
      process.exit(1)
    }
  }

  const a = load(fileA)
  const b = load(fileB)
  const sa = summarize(a)
  const sb = summarize(b)

  const nameA = basename(fileA).replace(/\.jsonl$/, '')
  const nameB = basename(fileB).replace(/\.jsonl$/, '')

  console.log(`\n${'='.repeat(72)}`)
  console.log(`A/B 对比：${nameA}  vs  ${nameB}`)
  console.log(`${'='.repeat(72)}\n`)
  console.log(
    `⚠️ Claude Code CLI **没有 seed flag** ⇒ 单次结果不可信。` +
      `\n   每任务重复次数 n = ${sa.n} / ${sb.n}` +
      `${Math.min(sa.n, sb.n) < 3 ? '  ← **低于 3，只能当方向不能当结论**' : ''}`,
  )

  const row = (label: string, va: number, vb: number, fmt: (x: number) => string) => {
    const delta = vb - va
    const sign = delta > 0 ? '+' : ''
    console.log(`  ${label.padEnd(14)} ${fmt(va).padStart(8)} → ${fmt(vb).padStart(8)}   ${sign}${fmt(delta)}`)
  }

  console.log(`\n【总体】`)
  row('首次写对', sa.first, sb.first, (x) => pct(x, sa.tasks))
  row('最终写对', sa.final, sb.final, (x) => pct(x, sa.tasks))
  row('平均轮数', sa.turns, sb.turns, (x) => x.toFixed(1))
  row('总成本', sa.cost, sb.cost, (x) => `$${x.toFixed(2)}`)

  console.log(`\n【按变异分组】（首次写对率）`)
  const muts = [...new Set([...sa.byMut.keys(), ...sb.byMut.keys()])].sort()
  for (const m of muts) {
    const ea = sa.byMut.get(m)
    const eb = sb.byMut.get(m)
    const ta = ea?.tasks ?? 0
    const tb = eb?.tasks ?? 0
    console.log(
      `  ${m.padEnd(24)} ${pct(ea?.first ?? 0, ta).padStart(5)} → ${pct(eb?.first ?? 0, tb).padStart(5)}` +
        `   (${ta}/${tb} 题)`,
    )
  }

  // ── 逐题对比（只看两边都跑了的题）──────────────────────────
  const common = [...a.keys()].filter((t) => b.has(t))
  const regress = common.filter((t) => (b.get(t)!.finalRate < a.get(t)!.finalRate))
  const improve = common.filter((t) => (b.get(t)!.finalRate > a.get(t)!.finalRate))
  const fewerTurns = common.filter((t) => b.get(t)!.turns < a.get(t)!.turns)
  const moreTurns = common.filter((t) => b.get(t)!.turns > a.get(t)!.turns)

  console.log(`\n【逐题（两边都跑的 ${common.length} 题）】`)
  console.log(`  最终写对变好：${improve.length} 题`)
  console.log(`  最终写对变差：${regress.length} 题${regress.length > 0 ? '  ← 查这些' : ''}`)
  console.log(`  轮数变少：${fewerTurns.length} 题 / 轮数变多：${moreTurns.length} 题`)
  if (regress.length > 0) {
    console.log('\n  变差的题：')
    for (const t of regress) console.log(`    - ${t}`)
  }

  console.log(`\n【结论怎么读】`)
  console.log('  · 「首次写对」是知识包最直接的收益（少绕 = 少试错）')
  console.log('  · 「最终写对」不该退步 —— 退了说明知识包把模型带偏了')
  console.log('  · **别把「知识包有效」做成硬门** —— 模型自己会变强，阈值断言迟早误红')
}

main()
