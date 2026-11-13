/**
 * 知识包注入探针 —— 证明「知识包真的进了模型上下文」。
 *
 *     npx vite-node scripts/jhyy-knowledge-probe.ts [--with-pack] [--without-pack]
 *
 * ## 为什么需要它
 *
 * 「文件写了、代码接了」≠「模型看到了」。中间隔着 CLI 的 flag、system prompt 的
 * 烤死时机、还有 provider 那一层 —— **必须有一个能观测到结果的探针**。
 *
 * ## 两个检查
 *
 * **① 标记串**：在提示文件末尾追加一个唯一的标记串，问模型「上下文里有没有它」。
 *    ⇒ 这一条证明**文件通道**通了，且内容真的进了上下文。
 *
 * **② fmt 的公开 API**：知识包的 stdlib 表来自**源码的 `// API:` 块**（4 个函数），
 *    而**规范 §15 那张表**多列了 3 个内部 helper（`ptr_add` / `digit_char` /
 *    `hex_char`）⇒ 两个来源的答案**不一样** ⇒ 答哪个就知道模型读的是哪份。
 *
 *    ⚠️ 这一条**不是铁证** —— 模型也可能自己去查规范。真正的铁证是①；
 *    ② 是「知识包里的内容模型能用」的旁证。
 *
 * ## 成本
 *
 * 每个臂一次 `claude -p` ⇒ 约 $0.2–0.3。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { locateClaude } from '../src/main/claude/locate'
import { buildResidentKnowledge } from '../src/main/claude/jhyy-rules'

const MARKER = 'JHYYPACK-MARKER-7742'

/** 跑一次 claude -p，返回回答文本。 */
function ask(exe: string, prompt: string, cwd: string, promptFile?: string): Promise<string> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      prompt,
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--output-format',
      'json',
    ]
    if (promptFile) args.push('--append-system-prompt-file', promptFile)
    const child = spawn(exe, args, { cwd, env: process.env, windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += String(c)))
    child.on('close', () => {
      let answer = ''
      for (const line of out.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const ev = JSON.parse(t)
          if (ev.type === 'result') answer = ev.result ?? ''
        } catch {
          /* 半行 JSON */
        }
      }
      resolve(answer)
    })
  })
}

async function main() {
  const withPack = !process.argv.includes('--without-pack')
  const exe = (await locateClaude())?.path
  if (!exe) {
    console.error('✗ 找不到 claude')
    process.exit(1)
  }
  const cwd = mkdtempSync(join(tmpdir(), 'jhyy-probe-'))

  // 提示文件：知识包（可选）+ 标记串
  let promptFile: string | undefined
  if (withPack) {
    const knowledge = buildResidentKnowledge()
    console.log(`知识包：${knowledge.length} 字符`)
    promptFile = join(cwd, 'prompt.md')
    writeFileSync(promptFile, `${knowledge}\n\n标记：${MARKER}\n`, 'utf8')
  }

  // ① 标记串
  const markerAnswer = await ask(
    exe,
    `你的上下文里如果有一个形如 ${MARKER} 的标记串，原样复述它；没有就只回答 NONE。只输出这一行。`,
    cwd,
    promptFile,
  )
  const markerOk = markerAnswer.includes(MARKER)
  console.log(`\n① 标记串：${markerOk ? '✓ 进了模型上下文' : '✗ 没进'}`)
  console.log(`   回答：${markerAnswer.trim().slice(0, 160)}`)

  // ② fmt 的公开 API
  const apiAnswer = await ask(
    exe,
    'JHYY 标准库的 fmt 模块，**公开 API** 有哪几个函数？只列函数名，一行一个，不要解释。',
    cwd,
    promptFile,
  )
  const hasPackOnly = /fmt_hex_u32/.test(apiAnswer)
  const hasSpecOnly = /digit_char|hex_char|ptr_add/.test(apiAnswer)
  console.log(`\n② fmt 公开 API：`)
  console.log(`   ${apiAnswer.trim().slice(0, 300)}`)
  console.log(
    `   判定：${hasPackOnly ? '含 fmt_hex_u32（知识包口径 ✓）' : '没含 fmt_hex_u32'}` +
      `${hasSpecOnly ? ' · 也含内部 helper（可能读了规范那张表）' : ''}`,
  )

  console.log(`\n===== 结论 =====`)
  console.log(`臂：${withPack ? '带知识包' : '不带知识包'}`)
  console.log(`标记串通道：${markerOk ? '通' : '不通'}`)
  process.exit(markerOk ? 0 : 1)
}

await main()
