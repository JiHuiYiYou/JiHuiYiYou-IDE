/**
 * 诊断：IDE 那套参数下，`--resume` 到底吐了什么。
 *
 * 用**原始** spawn（不走 ClaudeSession）把 stdout/stderr 原样打出来，
 * 顺便跟「少了某个参数」的版本对比。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateClaude } from '../src/main/claude/locate'
import { buildMcpConfig } from '../src/main/claude/mcp'

const binary = await locateClaude()
if (!binary) {
  console.error('✗ 找不到 claude')
  process.exit(1)
}

const cwd = mkdtempSync(join(tmpdir(), 'jhyy-resume-diag-'))
const sessionId = process.argv[2]
if (!sessionId) {
  console.error('用法：vite-node scripts/claude-resume-diag.ts <sessionId>')
  process.exit(1)
}

const mcpConfig = await buildMcpConfig()
console.log(`✓ cwd=${cwd}`)
console.log(`✓ mcp-config=${mcpConfig ? '有' : '无'}`)

const base = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--permission-mode',
  'acceptEdits',
  '--permission-prompts',
  'none',
  '--allowedTools',
  'Read,Edit,Write,MultiEdit,Glob,Grep,Bash,mcp__jhyy',
  '--resume',
  sessionId,
  '--add-dir',
  cwd,
]
if (mcpConfig) base.push('--mcp-config', mcpConfig, '--strict-mcp-config')
base.push('--append-system-prompt', '你在给 JHYY（机会翼游）语言写代码。')

console.log(`\n参数：${base.join(' ')}\n`)
const child = spawn(binary.path, base, {
  cwd,
  windowsHide: true,
  shell: false,
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (c: string) => {
  for (const line of c.split('\n')) {
    if (!line.trim()) continue
    let brief = line
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      brief = `${o.type}${o.subtype ? `/${o.subtype}` : ''}${
        o.message ? ` msg=${JSON.stringify(o.message).slice(0, 120)}` : ''
      }`
    } catch {
      brief = line.slice(0, 200)
    }
    console.log(`  [out] ${brief}`)
  }
})
child.stderr.on('data', (c: string) => {
  for (const line of c.split('\n')) if (line.trim()) console.log(`  [err] ${line.slice(0, 300)}`)
})
child.on('close', (code) => console.log(`  进程退出，退出码 ${code}`))

setTimeout(() => {
  console.log('\n（3 秒，发一句话）')
  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '只回答三个字：接着聊' }] },
  }
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}, 3000)

setTimeout(() => {
  console.log('\n（30 秒到了，关 stdin）')
  child.stdin.end()
  setTimeout(() => child.kill(), 1500)
}, 30_000)
