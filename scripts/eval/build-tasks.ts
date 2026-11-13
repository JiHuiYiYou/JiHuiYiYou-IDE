/**
 * 构建评测任务集并落盘。
 *
 *     npx vite-node scripts/eval/build-tasks.ts [--per-mutation 8] [--total 40]
 *
 * 产物：`eval/tasks.json`（进仓，评测时直接读，不再重建）。
 *
 * ⚠️ 构建会**真编译**每个候选 ⇒ 慢（每个候选 2 次编译，各 ~2-3 s）。
 * 语料一改就要重建 —— 但**评测时不需要重建**，所以这个慢只付一次。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { ideRoot } from '../../tests/helpers/repo'
import { buildTasks } from './tasks'

/** 解析 `--key value` 形式的参数。 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : fallback
}

const perMutation = Number(arg('per-mutation', '8'))
const total = Number(arg('total', '40'))

console.log(`构建任务集（每个变异最多 ${perMutation} 道，总共最多 ${total} 道）…`)
const { tasks, skipped } = await buildTasks({ perMutation, total })

console.log(`\n✓ 任务 ${tasks.length} 道`)
const byMut = new Map<string, number>()
for (const t of tasks) byMut.set(t.mutationId, (byMut.get(t.mutationId) ?? 0) + 1)
for (const [m, n] of [...byMut].sort()) console.log(`  ${m.padEnd(22)} ${n}`)

const reasons = new Map<string, number>()
for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
console.log(`\n丢弃 ${skipped.length} 个候选：`)
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)} × ${r}`)
}

const out = join(ideRoot, 'eval', 'tasks.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify(
    {
      version: 1,
      builtAt: new Date().toISOString(),
      note: '由 scripts/eval/build-tasks.ts 生成 —— 别手改。',
      tasks,
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
console.log(`\n→ ${resolve(out)}`)
