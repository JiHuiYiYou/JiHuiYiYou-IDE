/**
 * Claude Code 集成的冒烟测试。
 *
 * 真起一个 claude 进程、发一句话、看事件流。**会消耗一点 API 额度**，
 * 所以没放在 `npm test` 里 —— 手动跑：
 *
 *     npx vite-node scripts/claude-smoke.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateClaude } from '../src/main/claude/locate'
import { ClaudeSession } from '../src/main/claude/session'
import type { ClaudeEvent } from '../src/shared/claude'

const cwd = mkdtempSync(join(tmpdir(), 'jhyy-claude-smoke-'))

console.log('定位 Claude Code…')
const binary = await locateClaude()
if (!binary) {
  console.error('✗ 找不到 claude 可执行文件')
  process.exit(1)
}
console.log(`✓ ${binary.path}`)
console.log(`  版本：${binary.version ?? '（拿不到）'}`)

const events: ClaudeEvent[] = []
let done = false
let answer = ''

const session = new ClaudeSession({
  cwd,
  appendSystemPrompt: '你在给 JHYY（机会翼游）语言写代码。',
  onEvent: (event) => {
    events.push(event)
    if (event.type === 'delta') answer += event.text
    if (event.type === 'message' && event.message.role === 'assistant') {
      answer = event.message.text ?? answer
    }
    if (event.type === 'status' && event.status.turnComplete) done = true
    if (event.type === 'log') console.log(`  [log] ${event.text}`)
  },
})

console.log(`\n启动会话（cwd=${cwd}）…`)
await session.start(binary.path)

// 等 CLI 起来（它要先做完初始化才会收 stdin 的第一轮）
await new Promise((r) => setTimeout(r, 2500))

console.log('发一句话…')
const sent = session.send('用一句话回答：JHYY 的入口函数叫什么？只回答函数名。')
console.log(sent ? '✓ 已发送' : '✗ 发送失败')

const deadline = Date.now() + 180_000
while (!done && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
}

console.log('\n──── 事件统计 ────')
const counts: Record<string, number> = {}
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
console.log(counts)

const status = events.find((e) => e.type === 'status' && e.status.turnComplete)
console.log('\n──── 结果 ────')
console.log('回答：', answer.trim() || '（空）')
if (status && status.type === 'status') {
  console.log('用量：', status.status.usage)
  console.log('sessionId：', status.status.sessionId)
}

await session.stop()

const ok = answer.trim().length > 0
console.log(ok ? '\n✓ 通过' : '\n✗ 没收到回答')
process.exit(ok ? 0 : 1)
