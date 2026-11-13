/**
 * **hook 的端到端验证** —— 真 claude CLI + 真 `--settings` + 真 hook 脚本。
 *
 *     npx vite-node scripts/claude-hook-e2e.ts
 *
 * ## 为什么单独一个脚本
 *
 * `tests/claude/hook.test.ts` 只测了**钩子脚本本身**（喂假 payload ⇒ 看输出）。
 * 但那只证明「脚本逻辑对」，**不证明 CLI 真的会调它**、更不证明「诊断真的进了模型上下文」。
 *
 * ⇒ 这一层要**真起一个 claude 进程**，让它改一个**编译不过**的 `.jhyy`，
 *   然后看两件事：
 *   1. **hook 日志**（`JHY_HOOK_LOG`）有没有条目 ⇒ hook 被真的触发了
 *   2. **模型改完的文件**能不能编译过 ⇒ 模型确实用上了（不管是靠知识还是靠诊断）
 *
 * ## 两个用例，判的是**不同**的事
 *
 * | 用例 | 模型会怎么改 | 预期 |
 * |---|---|---|
 * | ① 入口名写错（`fn main`） | **一次就改对**（它知道入口叫 `main_jhyy`） | hook 触发 ✓、**不注入**（编译过了 ⇒ 无错可注 ⇒ 静默是对的） |
 * | ② 少了 `extern fn printf` 声明 | 大概率要**查规范**才改得出 | hook 触发 ✓、**注入诊断** ✓ |
 *
 * ⚠️ 用例① 的「不注入」**不是失败** —— 那是设计行为（没错误就不注入噪音）。
 *
 * ⚠️ **要花 API 额度**（每个用例一次真实调用，~2 分钟）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildHookSettings } from '../src/main/claude/hooks'
import { locateClaude } from '../src/main/claude/locate'
import { findCompiler, ideRoot } from '../tests/helpers/repo'

const HOOK = resolve(ideRoot, 'scripts', 'jhyy-check-hook.mjs')

/** 测试 marker —— 注入内容里带上它，模型复述出来就证明进了上下文。 */
const MARKER = 'HOOKPROOF-7742'

interface Case {
  name: string
  broken: string
  /** 是否预期「诊断被注入」（成功时也会注入一句确认 ⇒ 总是 true） */
  expectInject: boolean
}

const CASES: Case[] = [
  {
    name: '入口名写错（模型一次就改对 ⇒ 预期注入一句「编译通过」）',
    broken: 'fn main() -> i32 {\n    return 0;\n}\n',
    expectInject: true,
  },
  {
    name: '少了 extern fn printf 声明（模型大概率要查规范 ⇒ 预期注入诊断）',
    broken:
      'fn main_jhyy() -> i32 {\n    printf("%d\\n" as *u8, 42 as i64);\n    return 0;\n}\n',
    expectInject: true,
  },
]

async function main() {
  const claude = await locateClaude()
  const compiler = findCompiler()
  if (!claude || !compiler) {
    console.error('✗ 找不到 claude 或编译器')
    process.exit(1)
  }

  const settings = buildHookSettings({ compilerPath: compiler, scriptPath: HOOK })
  console.log(`settings：${settings}`)
  console.log(`编译器：${compiler}\n`)

  let allOk = true
  /** 有没有哪个用例里模型复述了 marker（= 注入真的进了上下文） */
  let anyMarkerSeen = false

  for (const c of CASES) {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-hook-e2e-'))
    const file = join(dir, 'main.jhyy')
    writeFileSync(file, c.broken, 'utf8')
    const logFile = join(dir, 'hook.log')

    console.log(`\n${'='.repeat(70)}`)
    console.log(`用例：${c.name}`)
    console.log('='.repeat(70))

    const res = spawnSync(
      claude.path,
      [
        '-p',
        '工作目录里的 main.jhyy 编译不过。修好它，让它能编译通过。把修好的代码写回 main.jhyy。' +
          '最后：如果你的上下文里出现过一个形如 HOOKPROOF-xxxx 的标记，原样复述它。',
        '--strict-mcp-config',
        '--permission-mode',
        'acceptEdits',
        '--permission-prompts',
        'none',
        '--allowedTools',
        'Read,Edit,Write,MultiEdit,Glob,Grep,Bash',
        '--settings',
        settings,
        '--output-format',
        'json',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
        env: { ...process.env, JHY_HOOK_LOG: logFile, JHY_HOOK_MARKER: MARKER },
      },
    )

    let answer = ''
    let cost = 0
    for (const line of (res.stdout ?? '').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const ev = JSON.parse(t)
        if (ev.type === 'result') {
          answer = ev.result ?? ''
          cost = ev.total_cost_usd ?? 0
        }
      } catch {
        /* 半行 JSON */
      }
    }

    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const fired = log.includes('TRIGGER')
    // ⚠️ 成功时脚本记 'OK'、失败时记 'INJECT' ⇒ 两者都算「注入了」
    const injected = log.includes('OK') || log.includes('INJECT')
    // **铁证**：模型把注入内容里的 marker 复述出来 ⇒ 它确实进了模型的上下文
    const markerSeen = answer.includes(MARKER)
    const after = readFileSync(file, 'utf8')

    // 模型改完的文件能不能编译（自己判，别信模型的话）
    const compile = spawnSync(compiler, ['compile', file], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    const compiles = compile.status === 0

    console.log(`\n模型回答：${answer.slice(0, 300)}`)
    console.log(`成本 $${cost.toFixed(4)}`)
    console.log(`\nhook 日志：`)
    console.log(
      log
        .split('\n')
        .filter((l) => /TRIGGER|INJECT|COMPILE/.test(l))
        .slice(0, 6)
        .join('\n') || '（空）',
    )
    console.log(`\n改完的文件：\n${after}`)
    console.log(`\n判定：`)
    console.log(`  hook 被触发：${fired ? '✓' : '✗'}`)
    console.log(`  诊断被注入：${injected ? '✓' : '✗'}`)
    console.log(`  改完能编译：${compiles ? '✓' : '✗'}`)
    console.log(`  注入进了模型上下文（模型复述了 marker）：${markerSeen ? '✓' : '✗'}`)

    // ⚠️ **marker 只作全局断言**，不逐用例判 —— 模型「如果出现就复述」是可选的：
    //   它一次就改对时可能压根不理会那段注入（实测：用例①就没复述）。
    //   ⇒ 「注入进了上下文」由**整体**断言：**至少一个用例复述了 marker**。
    const ok = fired && injected && compiles
    if (markerSeen) anyMarkerSeen = true
    if (!ok) allOk = false
    console.log(`  用例通过：${ok ? '✓' : '✗'}`)
  }

  console.log(`
===== 总判定 =====`)
  console.log(`  所有用例都通过：${allOk ? '✓' : '✗'}`)
  console.log(
    `  注入真的进了模型上下文（至少一个用例复述了 marker）：${anyMarkerSeen ? '✓' : '✗'}`,
  )
  process.exit(allOk && anyMarkerSeen ? 0 : 1)
}

await main()
