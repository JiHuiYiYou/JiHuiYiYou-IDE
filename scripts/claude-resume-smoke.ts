/**
 * 「历史会话」的冒烟测试 —— 测的是**恢复**（resume）这条路径。
 *
 * 跟 `claude-smoke.ts` 的区别：那个只测「能不能聊起来」，这个测
 * 「关掉之后能不能捡回来」，也就是 IDE 右上角「历史会话」下拉里点一下
 * 到底会发生什么。
 *
 * 测四件事：
 *   1. 起会话 → 发一句话 → 拿到 sessionId
 *   2. 关掉（EOF）→ 磁盘上真的有那个会话文件吗
 *   3. **同一个 cwd** 恢复 ⇒ CLI 会把旧对话重放出来吗
 *   4. **换一个 cwd** 恢复 ⇒ 会失败吗（IDE 现在就是拿「当前打开的文件」
 *      的目录去恢复的，不一定是当初那个会话的目录）
 *
 * **会消耗一点 API 额度**（只有第 1 步发的那句话算数）。
 *
 *     npx vite-node scripts/claude-resume-smoke.ts
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateClaude } from '../src/main/claude/locate'
import { ClaudeSession } from '../src/main/claude/session'
import type { ClaudeEvent } from '../src/shared/claude'

const binary = await locateClaude()
if (!binary) {
  console.error('✗ 找不到 claude 可执行文件')
  process.exit(1)
}
console.log(`✓ claude：${binary.path}`)

const cwd = mkdtempSync(join(tmpdir(), 'jhyy-resume-smoke-'))
const otherCwd = mkdtempSync(join(tmpdir(), 'jhyy-resume-other-'))
console.log(`✓ 会话目录：${cwd}`)
console.log(`✓ 另一个目录：${otherCwd}`)

/** 跑一个会话，收集事件。`onEvent` 会被 CLI 的每一条事件调用。 */
function makeSession(dir: string, resumeSessionId?: string) {
  const events: ClaudeEvent[] = []
  const logs: string[] = []
  const session = new ClaudeSession({
    cwd: dir,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    appendSystemPrompt: '你在给 JHYY（机会翼游）语言写代码。',
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'log') logs.push(event.text)
    },
  })
  return { session, events, logs }
}

/** 等一个条件成立。 */
async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/** 把事件流压成一行行摘要（好看出「重放」了什么）。 */
function summarize(events: ClaudeEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type === 'status') {
      out.push(`status  state=${e.status.state} sessionId=${e.status.sessionId ?? '-'}`)
    } else if (e.type === 'message') {
      const m = e.message
      if (m.role === 'assistant') {
        const parts: string[] = []
        if (m.text) parts.push(`text=${JSON.stringify(m.text.slice(0, 60))}`)
        if (m.thinking) parts.push(`thinking(${m.thinking.length} 字)`)
        if (m.toolUses?.length) parts.push(`tools=${m.toolUses.map((t) => t.name).join(',')}`)
        out.push(`assistant ${parts.join(' ')}`)
      } else if (m.toolResult) {
        out.push(`tool_result ${m.toolResult.toolUseId}`)
      } else {
        out.push('user （没有 toolResult 的 user 消息）')
      }
    } else if (e.type === 'delta') {
      out.push(`delta ${JSON.stringify(e.text.slice(0, 40))}`)
    }
  }
  return out
}

// ── 1. 起会话，发一句话 ───────────────────────────────────────
console.log('\n【1】起会话，发一句话')
const first = makeSession(cwd)
await first.session.start(binary.path)
await new Promise((r) => setTimeout(r, 2500))
const sent = first.session.send('只回答四个字：恢复测试')
console.log(`  发送：${sent ? '✓' : '✗'}`)
const turnDone = await until(
  () =>
    first.events.some(
      (e) => e.type === 'status' && e.status.turnComplete,
    ),
  180_000,
)
console.log(`  本轮结束：${turnDone ? '✓' : '✗（超时）'}`)
const sessionId = first.session.currentSessionId
console.log(`  sessionId：${sessionId ?? '（没有！）'}`)

// ── 2. 关掉，看磁盘上有没有会话文件 ───────────────────────────
console.log('\n【2】关掉会话（EOF）')
await first.session.stop()
await new Promise((r) => setTimeout(r, 800))

const projectsDir = join(process.env.USERPROFILE ?? '', '.claude', 'projects')
/** cwd → CLI 用的那个目录名（非字母数字全换成 -）。 */
function slug(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}
const sessionFile = join(projectsDir, slug(cwd), `${sessionId}.jsonl`)
console.log(`  预期会话文件：${sessionFile}`)
console.log(`  存在：${existsSync(sessionFile) ? '✓' : '✗'}`)
if (existsSync(sessionFile)) {
  const dir = join(projectsDir, slug(cwd))
  console.log(`  该目录下的会话：${readdirSync(dir).filter((f) => f.endsWith('.jsonl')).join(', ')}`)
}

// ── 3. 同一个 cwd 恢复 ───────────────────────────────────────
console.log('\n【3】同一个 cwd 恢复（点历史会话下拉里那条）')
const resumed = makeSession(cwd, sessionId)
await resumed.session.start(binary.path)
// 恢复后 CLI 会先把旧对话重放出来 —— 给它点时间
await new Promise((r) => setTimeout(r, 4000))
const summary = summarize(resumed.events)
console.log(`  事件数：${resumed.events.length}`)
for (const line of summary) console.log(`    ${line}`)
const replayedUser = resumed.events.some(
  (e) => e.type === 'message' && e.message.role === 'user' && !e.message.toolResult,
)
const replayedAssistant = resumed.events.some(
  (e) => e.type === 'message' && e.message.role === 'assistant',
)
console.log(`  重放了用户消息：${replayedUser ? '✓' : '✗'}`)
console.log(`  重放了助手消息：${replayedAssistant ? '✓' : '✗'}`)
if (resumed.logs.length) {
  console.log('  stderr 日志：')
  for (const l of resumed.logs.slice(0, 10)) console.log(`    ${l}`)
}
await resumed.session.stop()

// ── 4. 换一个 cwd 恢复 ───────────────────────────────────────
console.log('\n【4】换一个 cwd 恢复（IDE 现在的真实行为：用当前文件的目录）')
const wrong = makeSession(otherCwd, sessionId)
await wrong.session.start(binary.path)
await new Promise((r) => setTimeout(r, 4000))
const wrongSummary = summarize(wrong.events)
console.log(`  事件数：${wrong.events.length}`)
for (const line of wrongSummary) console.log(`    ${line}`)
if (wrong.logs.length) {
  console.log('  stderr 日志：')
  for (const l of wrong.logs.slice(0, 10)) console.log(`    ${l}`)
}
await wrong.session.stop()

console.log('\n──── 结论 ────')
console.log(`sessionId 能拿到：${sessionId ? '✓' : '✗'}`)
console.log(`会话文件落盘：${existsSync(sessionFile) ? '✓' : '✗'}`)
console.log(`恢复会重放旧对话：${replayedUser || replayedAssistant ? '✓' : '✗（不会重放）'}`)
console.log(`换 cwd 恢复能成功：${wrongSummary.some((l) => l.startsWith('assistant')) ? '✓' : '✗'}`)
