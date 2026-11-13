/**
 * **跨语言配对对比** —— 「同样的实现，大众语言 vs 小众语言」。
 *
 *     npx vite-node scripts/eval/compare-langs.ts <C侧.jsonl> <JHYY侧.jsonl>
 *
 * ## 为什么这个对比才有意义
 *
 * 单看「JHYY 要 16 轮、C 要 12 轮」**说明不了任何事** ——
 * 两边的**题目难度**可能就不一样。
 *
 * ⇒ 本仓的 C 对照语料来自语言仓 `bench/difftest.py` 的随机程序生成器：
 * **同一个 AST** 发出 C（`emit_c`）和 JHYY（`emit_jhyy`）**两个实现**，
 * 再对两者施加**平行的变异**（入口名写错 / 少声明 / 格式符错 / 掩码改了）。
 *
 * ⇒ 于是每一对任务是：**同一个算法、同一批数、同一类错、同一份期望输出**，
 *   **只有语言不同** ⇒ 差值可以归因到语言。
 *
 * ## 输出
 *
 * - **逐对**：C 用了多少轮 / 多少次工具调用，JHYY 用了多少
 * - **汇总**：平均轮数、工具调用数、成本，按语言分组
 * - **按变异分组**：哪一类错在两种语言里花的轮数差最多
 */

import { readFileSync } from 'node:fs'

interface RunRecord {
  taskId: string
  firstPass: boolean
  finalPass: boolean
  mutationId: string
  usage?: { turns?: number; costUsd?: number; inputTokens?: number; outputTokens?: number }
  trajectory?: { kind: string; tool: string }[]
}

/** 从任务 id 里抽出配对键（变异 + 种子）。 */
function pairKey(taskId: string): string {
  // C 侧：`c-entry-name/seed1`      JHYY 侧：`entry-name/seed1/jhyy`
  const parts = taskId.split('/')
  const mut = parts[0].replace(/^c-/, '')
  const seed = parts[1] ?? ''
  return `${mut}/${seed}`
}

function load(file: string): Map<string, RunRecord> {
  const out = new Map<string, RunRecord>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const r = JSON.parse(t) as RunRecord
    out.set(pairKey(r.taskId), r)
  }
  return out
}

function calls(r: RunRecord): number {
  return r.trajectory?.length ?? 0
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function main() {
  const [fileC, fileJ] = process.argv.slice(2)
  if (!fileC || !fileJ) {
    console.error('用法：npx vite-node scripts/eval/compare-langs.ts <C侧.jsonl> <JHYY侧.jsonl>')
    process.exit(1)
  }

  const c = load(fileC)
  const j = load(fileJ)
  const common = [...c.keys()].filter((k) => j.has(k))

  console.log(`\n${'='.repeat(76)}`)
  console.log('跨语言配对对比：同一个 AST 的 C 实现 vs JHYY 实现')
  console.log(`${'='.repeat(76)}\n`)
  console.log(`C 侧任务 ${c.size} 道 · JHYY 侧任务 ${j.size} 道 · **可配对 ${common.length} 对**`)

  if (common.length === 0) {
    console.log('\n⚠ 没有可配对的任务 —— 两边的任务 id 对不上。')
    return
  }

  // ── 逐对 ──────────────────────────────────────────────────────
  console.log(`\n【逐对】${'（C 轮数 / JHYY 轮数）'}`)
  const rows = common
    .map((k) => ({
      k,
      cT: c.get(k)!.usage?.turns ?? 0,
      jT: j.get(k)!.usage?.turns ?? 0,
      cC: calls(c.get(k)!),
      jC: calls(j.get(k)!),
      cOk: c.get(k)!.finalPass,
      jOk: j.get(k)!.finalPass,
    }))
    .sort((a, b) => b.jT - b.cT - (b.cT - a.jT))
  for (const r of rows) {
    const delta = r.jT - r.cT
    const mark = r.jOk && r.cOk ? ' ' : '!'
    console.log(
      `${mark}${r.k.padEnd(28)} C=${String(r.cT).padStart(3)}(${String(r.cC).padStart(2)}次)` +
        `  JHYY=${String(r.jT).padStart(3)}(${String(r.jC).padStart(2)}次)` +
        `   Δ${delta > 0 ? '+' : ''}${delta}`,
    )
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  const cT = common.map((k) => c.get(k)!.usage?.turns ?? 0)
  const jT = common.map((k) => j.get(k)!.usage?.turns ?? 0)
  const cC = common.map((k) => calls(c.get(k)!))
  const jC = common.map((k) => calls(j.get(k)!))
  const cCost = common.reduce((a, k) => a + (c.get(k)!.usage?.costUsd ?? 0), 0)
  const jCost = common.reduce((a, k) => a + (j.get(k)!.usage?.costUsd ?? 0), 0)
  const cOk = common.filter((k) => c.get(k)!.finalPass).length
  const jOk = common.filter((k) => j.get(k)!.finalPass).length
  const jWorse = rows.filter((r) => r.jT > r.cT).length
  const jBetter = rows.filter((r) => r.jT < r.cT).length
  const same = rows.filter((r) => r.jT === r.cT).length

  console.log(`\n【汇总】（${common.length} 对）`)
  console.log(`  ${'指标'.padEnd(14)} ${'C'.padStart(8)} ${'JHYY'.padStart(8)}   差`)
  const row = (label: string, a: number, b: number) => {
    const d = b - a
    console.log(
      `  ${label.padEnd(14)} ${a.toFixed(1).padStart(8)} ${b.toFixed(1).padStart(8)}   ` +
        `${d > 0 ? '+' : ''}${d.toFixed(1)}`,
    )
  }
  row('平均轮数', avg(cT), avg(jT))
  row('平均工具调用', avg(cC), avg(jC))
  row('总成本($)', cCost, jCost)
  console.log(`  ${'最终写对'.padEnd(14)} ${String(cOk).padStart(8)} ${String(jOk).padStart(8)}   （共 ${common.length}）`)

  console.log(`\n【逐对方向】JHYY 更费轮 ${jWorse} 对 · 更省轮 ${jBetter} 对 · 持平 ${same} 对`)

  // ── 按变异分组 ──────────────────────────────────────────────────
  const byMut = new Map<string, { c: number[]; j: number[] }>()
  for (const k of common) {
    const mut = k.split('/')[0]
    const e = byMut.get(mut) ?? { c: [], j: [] }
    e.c.push(c.get(k)!.usage?.turns ?? 0)
    e.j.push(j.get(k)!.usage?.turns ?? 0)
    byMut.set(mut, e)
  }
  console.log(`\n【按变异分组】（平均轮数）`)
  for (const [mut, e] of [...byMut].sort()) {
    console.log(`  ${mut.padEnd(18)} C=${avg(e.c).toFixed(1).padStart(5)}  JHYY=${avg(e.j).toFixed(1).padStart(5)}   Δ${(avg(e.j) - avg(e.c)).toFixed(1)}`)
  }
}

main()
