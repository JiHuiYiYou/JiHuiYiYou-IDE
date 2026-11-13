/**
 * 轮数归因分析 —— **「模型的时间到底花在哪儿了」**。
 *
 *     npx vite-node scripts/eval/analyze-turns.ts <某个run的.jsonl> [...]
 *
 * ## 为什么需要它
 *
 * 「平均 17.7 轮」这个数字**本身没有用** —— 它不告诉你该优化什么。
 * ⇒ 要把每次工具调用**归类**（编译 / 改代码 / 查规范 / 探索 / …），
 *   再看**哪一类占了多少**、以及**它们发生在第一次编译成功之前还是之后**。
 *
 * ## 三个关键切分
 *
 * | 切分 | 含义 | 对应的优化 |
 * |---|---|---|
 * | **试错开销** | 第一次编译成功**之前**的工具调用 | 知识够不够 ⇒ 能不能少试错 |
 * | **过度验证开销** | 第一次编译成功**之后**的工具调用 | 任务边界清不清 ⇒ 是不是在做没必要的自证 |
 * | **空转开销** | 工具调用**失败**了（isError） | 权限/路径/命令给得对不对 |
 *
 * ## 重要前提
 *
 * 一次 Claude Code 的「轮」≈ 一次工具调用（工具结果会开新一轮）。
 * 脚本会把 `usage.num_turns` 和实际工具调用数**并排打出来** —— 对不上就说明
 * 这个近似不成立，结论要打折。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { classifyTool } from './trajectory'

interface TrajectoryEntry {
  tool: string
  kind: string
  what: string
  result?: string
  isError?: boolean
  isCompile?: boolean
  compileOk?: boolean
}

interface RunRecord {
  taskId: string
  arm: string
  mutationId: string
  firstPass: boolean
  finalPass: boolean
  usage?: { turns?: number; costUsd?: number; inputTokens?: number; outputTokens?: number }
  trajectory?: TrajectoryEntry[]
}

const KIND_LABEL: Record<string, string> = {
  compile: '编译',
  'mcp:check': 'MCP编译检查',
  'mcp:run': 'MCP跑程序',
  edit: '改代码',
  read: '读文件',
  explore: '探索(ls/grep/find)',
  run: '跑程序',
  'find-tool': '**找工具**(ToolSearch)',
  'mcp:spec': '查规范',
  'mcp:ledger': '查台账',
  'mcp:other': '其它MCP',
  subagent: '派子代理',
  other: '其它',
}

/** 大类归并 —— 「轮数花在哪种活上」。 */
const GROUP: Record<string, string> = {
  compile: '验证',
  'mcp:check': '验证',
  'mcp:run': '验证',
  run: '验证',
  edit: '改代码',
  'mcp:spec': '查资料',
  'mcp:ledger': '查资料',
  'mcp:other': '查资料',
  read: '读/探索',
  explore: '读/探索',
  'find-tool': '**找工具**',
  subagent: '其它',
  other: '其它',
}

function load(file: string): RunRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord)
}

function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('用法：npx vite-node scripts/eval/analyze-turns.ts <run.jsonl> [...]')
    process.exit(1)
  }

  for (const file of files) {
    const recs = load(file)
    const withTraj = recs.filter((r) => r.trajectory && r.trajectory.length > 0)
    console.log(`\n${'='.repeat(76)}`)
    console.log(`轮数归因：${basename(file).replace(/\.jsonl$/, '')}`)
    console.log(`${'='.repeat(76)}\n`)

    if (withTraj.length === 0) {
      console.log('⚠ 这个 run 没有轨迹数据（跑之前没有开轨迹落盘）⇒ 换个新的 run。')
      continue
    }

    // ── 工具调用总数 vs CLI 报的轮数 ─────────────────────────
    const calls = withTraj.reduce((a, r) => a + (r.trajectory!.length), 0)
    const turns = withTraj.reduce((a, r) => a + (r.usage?.turns ?? 0), 0)
    console.log(
      `有轨迹的题：${withTraj.length} / ${recs.length}` +
        `　工具调用总数 ${calls}　CLI 报的总轮数 ${turns}` +
        `　比值 ${(calls / Math.max(turns, 1)).toFixed(2)}` +
        `　（≈1 说明「一轮 ≈ 一次工具调用」这个近似成立）`,
    )

    // ── 按归类统计 ──────────────────────────────────────────
    // ⚠️ **离线重新归类** —— 落盘时的 `kind` 可能是**旧规则**算的
    //   （分类规则改过好几次）⇒ 用工具名现算 ⇒ 老 run 也能用新规则分析。
    const hist = new Map<string, number>()
    const failed = new Map<string, number>()
    let totalFailed = 0
    for (const r of withTraj) {
      for (const raw of r.trajectory!) {
        const kind = classifyTool(raw.tool, raw.what ?? '')
        hist.set(kind, (hist.get(kind) ?? 0) + 1)
        if (raw.isError) {
          failed.set(kind, (failed.get(kind) ?? 0) + 1)
          totalFailed++
        }
      }
    }
    console.log(`\n【工具调用归类】`)
    console.log(`  ${'归类'.padEnd(18)} {'次数'.padStart(6)} {'占比'.padStart(7)} {'其中失败'.padStart(8)}`)
    for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1])) {
      const f = failed.get(k) ?? 0
      console.log(
        `  ${(KIND_LABEL[k] ?? k).padEnd(18)} ${String(n).padStart(6)} ` +
          `${((n / calls) * 100).toFixed(1).padStart(6)}% ${String(f).padStart(8)}`,
      )
    }
    console.log(`  ${'合计'.padEnd(18)} ${String(calls).padStart(6)} ${'100.0%'.padStart(7)} ${String(totalFailed).padStart(8)}`)

    // ── 大类归并 ────────────────────────────────────────────
    const groups = new Map<string, number>()
    for (const r of withTraj) {
      for (const raw of r.trajectory!) {
        const g = GROUP[classifyTool(raw.tool, raw.what ?? '')] ?? '其它'
        groups.set(g, (groups.get(g) ?? 0) + 1)
      }
    }
    console.log(`\n【轮数花在哪种活上】（大类归并）`)
    for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${g.padEnd(18)} ${String(n).padStart(6)}  ${((n / calls) * 100).toFixed(1).padStart(6)}%`)
    }

    // ── 试错开销 vs 过度验证开销 ─────────────────────────────
    // 两种切分：
    //   严格 = 第一次**编译成功**（要 tool_result；旧 run 没有就退化成近似）
    //   近似 = 第一次**编译尝试**
    const strictBefore: number[] = []
    const strictAfter: number[] = []
    const approxBefore: number[] = []
    const approxAfter: number[] = []
    let noCompile = 0
    let noStrict = 0
    for (const r of withTraj) {
      const tr = r.trajectory!
      const strictIdx = tr.findIndex((t) => t.isCompile && t.compileOk === true)
      const approxIdx = tr.findIndex((t) => classifyTool(t.tool, t.what ?? '') === 'compile' || classifyTool(t.tool, t.what ?? '') === 'mcp:check')
      if (approxIdx < 0) {
        noCompile++
        continue
      }
      approxBefore.push(approxIdx)
      approxAfter.push(tr.length - approxIdx - 1)
      if (strictIdx >= 0) {
        strictBefore.push(strictIdx)
        strictAfter.push(tr.length - strictIdx - 1)
      } else {
        noStrict++
      }
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
    console.log(`\n【试错开销 vs 过度验证开销】`)
    console.log(
      `  近似切分（第一次**编译尝试**之前 / 之后）：` +
        `${avg(approxBefore).toFixed(1)} / ${avg(approxAfter).toFixed(1)}`,
    )
    if (strictBefore.length > 0) {
      console.log(
        `  严格切分（第一次**编译成功**之前 / 之后）：` +
          `${avg(strictBefore).toFixed(1)} / ${avg(strictAfter).toFixed(1)}`,
      )
    } else {
      console.log(`  严格切分：数据不足（${noStrict} 道题没识别出编译成功 ⇒ 这个 run 没存 tool_result）`)
    }
    console.log(`  从头到尾**没编译过**的题：${noCompile} 道`)

    // ── 失败调用的分布（哪些工具白费）────────────────────────
    if (totalFailed > 0) {
      console.log(`\n【空转（工具调用失败）】共 ${totalFailed} 次`)
      for (const [k, n] of [...failed].sort((a, b) => b[1] - a[1])) {
        if (n === 0) continue
        console.log(`  ${(KIND_LABEL[k] ?? k).padEnd(18)} ${n} 次`)
      }
    }

    // ── 轮数最多的题 + 它的序列 ─────────────────────────────
    const top = [...withTraj].sort(
      (a, b) => (b.usage?.turns ?? 0) - (a.usage?.turns ?? 0),
    ).slice(0, 5)
    console.log(`\n【轮数最多的 5 题】`)
    for (const r of top) {
      console.log(`\n  ${r.taskId}  （${r.usage?.turns ?? 0} 轮 / ${r.trajectory!.length} 次调用）`)
      const seq = r.trajectory!.map((t) => KIND_LABEL[classifyTool(t.tool, t.what ?? '')] ?? t.kind)
      console.log(`    ${seq.join(' → ')}`)
    }
  }
}

main()
