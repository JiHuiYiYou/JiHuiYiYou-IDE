/**
 * 评测 harness —— 「让模型修 JHYY 代码，看它修得对不对」。
 *
 *     npx vite-node scripts/eval/run-eval.ts [--arm baseline] [--tasks 5] [--repeat 1]
 *
 * ## 它干什么
 *
 * 每个任务：
 *   1. 把语料（+ 其 import 依赖）复制到临时工作区，把目标文件换成**变异后的坏版本**
 *   2. 起一个 `claude -p` 会话（**用 IDE 的确切 flag 组合**）让模型修
 *   3. 从事件流里**重建模型改过的每一版**（Write / Edit / MultiEdit 依次重放）
 *   4. 逐版判分：编译 + 运行 + 跟原文件的 stdout/退出码逐字比
 *
 * ## 三个关键设计
 *
 * **① 逐版判分，而不是只看最终版。**
 *   「第一次就写对」和「改了三次才对」是完全不同的能力 ——
 *   前者说明规则内化了，后者说明只靠编译器纠正。评测要能分开看。
 *
 * **② 判据是「编译 + 退出码 + stdout 逐字」。**
 *   光看编译过 ⇒ 「删掉出错那行」也过；光看退出码 ⇒ 「重写成 return 0」也过。
 *
 * **③ 用 IDE 的确切 flag 组合。**
 *   headless 下不给权限 ⇒ 模型的工具调用全被拒 ⇒ 它会一直换工具重试直到超时
 *   （实测踩过：110 s 跑不完）。IDE 传的是 `--permission-mode acceptEdits`
 *   + `--permission-prompts none` + `--allowedTools …`（= 预授权）⇒ 这里照抄。
 *
 * ## 成本
 *
 * 实测一次平凡调用 ≈ $0.085；带工具的真实任务 ≈ $0.27（15 轮）。
 * 16 题 × 1 臂 × 1 次 ≈ $4。**评测要花钱，别在每次提交时跑。**
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { locateClaude } from '../../src/main/claude/locate'
import { buildMcpConfig } from '../../src/main/claude/mcp'
import { jhyyCheatsheet } from '../../src/main/claude/jhyy-rules'
import { findCompiler, findLangRepo, ideRoot } from '../../tests/helpers/repo'
import { grade } from './grader'
import {
  extractCodeFromAnswer,
  parseStream,
  reconstructVersions,
  summarizeToolUse,
  usedCompiler,
  type ToolUseEvent,
  type TrajectoryEntry,
} from './trajectory'
import type { EvalTask } from './tasks'

// ── 参数 ──────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : fallback
}

/** 一个实验臂 = 一组配置。 */
interface Arm {
  name: string
  /** 追加的 system prompt（文本） */
  systemPrompt?: string
  /** 追加的 system prompt（文件）—— 隐藏 flag，走文件避开 argv 长度上限 */
  systemPromptFile?: string
  /** 挂 jhyy MCP */
  useMcp: boolean
}

const ARMS: Record<string, Arm> = {
  // **现状**：IDE 现在给会话的就是这 12 条 + jhyy MCP。
  baseline: { name: 'baseline', systemPrompt: jhyyCheatsheet(), useMcp: true },
  // **知识包取代速查表**（IDE 的新行为）：知识包是从规范生成的 ⇒ 它**包含**
  // 手写速查表的全部内容 ⇒ 两者不叠加，只做取舍（跟 `buildResidentKnowledge()` 一致）。
  knowledge: {
    name: 'knowledge',
    systemPromptFile: knowledgePackPath(),
    useMcp: true,
  },
}

/** 知识包在语言仓里的位置（S2 才生成得到）。 */
function knowledgePackPath(): string | undefined {
  const repo = findLangRepo()
  if (!repo) return undefined
  return join(repo, 'docs', 'generated', 'jhyy-knowledge.md')
}


/** 一次运行的记录（落盘成 JSONL 一行）。 */
interface RunRecord {
  taskId: string
  arm: string
  repeat: number
  mutationId: string
  rule: string
  /** 第一次就写对？ */
  firstPass: boolean
  /** 最后一次写对？ */
  finalPass: boolean
  /** 模型改了几版 */
  versions: number
  /** 有没有真的去编译（调了 Bash 跑编译器） */
  usedCompiler: boolean
  /** 失败原因 */
  reason?: string
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; turns?: number }
  /** 模型的最终回答（截断） */
  answer?: string
  /** 每一版的判分结果 */
  grades: { passed: boolean; reason?: string }[]
  /** 每一版的源码（诊断用 —— 判失败时得能看见模型到底写了什么） */
  versionSources?: string[]
  /**
   * **工具调用轨迹** —— 分析「轮数都花在哪了」用。
   *
   * ⚠️ 没有它就只能看模型的自述（answer），而自述**会漏**（模型不一定 narration
   *   每次工具调用）⇒ 归因必须靠真实轨迹。
   */
  trajectory?: TrajectoryEntry[]
}

// ── 工具 ──────────────────────────────────────────────────────

/** 把任务的工作区搭出来（语料 + 依赖 + 坏版本）。 */
function setupWorkspace(
  task: EvalTask,
  corpusRoot: string,
  cTaskDir: string,
): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-eval-'))
  const paired = Boolean(task.pairId)
  const rel = task.lang === 'c'
    ? 'main.c'
    : paired
      ? 'main.jhyy'
      : task.id.split('/').slice(1).join('/') + '.jhyy'
  // 配对任务 / C 对照组：源文件在 `eval/tasks-paired/`（或 `eval/tasks-c/`）下
  if (task.sourceFile && existsSync(join(cTaskDir, task.sourceFile))) {
    copyFileSync(join(cTaskDir, task.sourceFile), join(dir, rel))
  } else {
    for (const f of task.workspace ?? []) {
      const dest = join(dir, f)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(corpusRoot, f), dest)
    }
  }
  // 目标文件换成坏版本
  const target = join(dir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, task.broken, 'utf8')
  return { dir, rel }
}

/** 题目文本。 */
/**
 * 题目文本 —— **两种风格**（`--prompt-style` 选）。
 *
 * ⚠️ 这不是「哪种风格好」的品味问题，是**归因实验**。
 * 轨迹分析（`scripts/eval/analyze-turns.ts`）在 18 道题上测出：
 *
 * | 大类 | 占比 | 观察 |
 * |---|---|---|
 * | 验证（编译 + 跑程序） | 34% | 修好之后还在反复跑 |
 * | 改代码 | 19% | 每题平均改 **3 次**（只需改 1 处） |
 * | 查资料 | 17% | 查规范 + 查台账 |
 * | 读/探索 | 17% | **读的几乎全是目标文件自己 —— 而 prompt 里已经贴了** |
 * | 找工具（ToolSearch） | 7% | 每次会话开头都要搜才知道有 `jhyy_check` |
 *
 * ⇒ `tight` 风格把**三个**已证实的浪费点一次性堵上：
 *   ① **不贴源码**（模型本来就要 Read 一次 ⇒ 贴着只是让 prompt 每轮多背一份）
 *   ② **收紧范围**（别做额外验证、别改注释、别顺手修别的）
 *   ③ **一次拿到全部诊断**（`jhyy_check` 一次返回全部 ⇒ 别一个错误查一次）
 *
 * ⚠️ **但评测里的 prompt 比真实 IDE 场景「干净」得多** —— 真实场景里用户说的是
 *   「帮我修这个错」，边界是模糊的。⇒ `tight` 的收益**不能直接搬到真实场景**，
 *   它衡量的是「把边界说清楚能省多少轮」。
 */
function buildPrompt(task: EvalTask, rel: string, style: string, compilerPath?: string): string {
  // ── **两种破坏方式要两种措辞** ─────────────────────────────────
  //
  // ⚠️ **实测踩过**：behavior-break（能编译、但输出不对）的题，prompt 写「编译不过」
  //   ⇒ 模型**编译一次发现过了 ⇒ 认为没问题 ⇒ 交卷不改**
  //   （实测 C 侧 wrong-format / mask-change 全是「版本数=1」= 模型根本没写文件）。
  // ⇒ 这类题必须说清「**能编译，但输出不对**」，并把**实际输出和期望输出**都给出来。
  const behavior = task.kind === 'behavior-break'
  const opening = behavior
    ? `工作目录里的 \`${rel}\` **能编译，但输出不对**。`
    : `工作目录里的 \`${rel}\` 编译不过。`
  const outputBlock: string[] = []
  if (behavior && task.actualStdout !== undefined) {
    const head = (x: string) => x.split('\n').slice(0, 4).join('\n')
    outputBlock.push(
      '',
      '它现在的输出是：',
      '```',
      head(task.actualStdout),
      '```',
      '',
      '**期望**的输出是：',
      '```',
      head(task.expectStdout ?? ''),
      '```',
    )
  }

  // ── C 对照组：题目措辞跟 JHYY 侧平行，只是语言换了 ──────────────
  if (task.lang === 'c') {
    if (style === 'tight') {
      return [
        opening + '（自己读这个文件看内容）。',
        '',
        behavior
          ? '把它修好：让它**输出跟期望一致**。'
          : '把它修好：让它能编译通过，而且输出跟原来一致。',
        ...outputBlock,
        `把修好的完整代码写回 \`${rel}\`。`,
        '',
        '**怎么做（照这个来，别绕）**：',
        behavior
          ? '1. 先跑一遍看现在的输出（**跟期望比**，找出不一样的地方）。'
          : '1. 先用 Bash 跑 `gcc -O0 -o main.exe ' + rel + '` 编译 —— 它会打印**全部**错误。',
        '2. **只改错误指出的那一处**。',
        '3. 再跑一次确认输出跟期望一致 ⇒ 收工。',
        '',
        '**范围（重要）**：',
        '- **不要**改注释。',
        '- **不要**做额外验证（不用探测别的边界）。',
        '- **不要**顺手修你发现的其他问题。',
      ].join('\n')
    }
    return [
      opening,
      '',
      '下面是它现在的内容：',
      '',
      '```c',
      task.broken,
      '```',
      ...outputBlock,
      '',
      behavior
        ? '把它修好：让它**输出跟期望一致**。'
        : '把它修好：让它能编译通过，而且输出跟原来一致。',
      `把修好的完整代码写回 \`${rel}\`。`,
      '你可以用编译器验证，改到它通过为止。',
    ].join('\n')
  }

  if (style === 'tight') {
    const base = [
      opening + '（自己读这个文件看内容）。',
      '',
      behavior
        ? '把它修好：让它**输出跟期望一致**。'
        : `把它修好：让它能编译通过，而且行为跟原来一致（退出码 ${task.expectExit}）。`,
      ...outputBlock,
      `把修好的完整代码写回 \`${rel}\`。`,
      '',
      '**怎么做（照这个来，别绕）**：',
      behavior
        ? '1. 先用 `jhyy_run` 跑一遍看现在的输出（**跟期望比**，找出不一样的地方）。'
        : '1. 先用 `jhyy_check` 编译检查 —— 它**一次返回全部诊断**（行:列 + 错误原文）。',
      '2. **只改指出的那一处**。',
      '3. 再验一次确认跟期望一致 ⇒ 收工。',
      '',
      '**范围（重要）**：',
      '- **不要**改注释、文档、断言。',
      '- **不要**做额外验证（不用证明断言非空、不用探测别的边界）。',
      '- **不要**顺手修你发现的其他问题。',
    ]
    if (compilerPath) {
      base.push(
        '',
        `编译命令（**直接用这个，别去找**）：`,
        '```',
        `${compilerPath} compile ${rel} -o ${rel.replace(/\.jhyy$/, '')}.out`,
        '```',
      )
    }
    return base.join('\n')
  }

  return [
    opening,
    '',
    '下面是它现在的内容：',
    '',
    '```jhyy',
    task.broken,
    '```',
    ...outputBlock,
    '',
    behavior
      ? '把它修好：让它**输出跟期望一致**。'
      : `把它修好：让它能编译通过，而且行为跟原来一致（退出码 ${task.expectExit}）。`,
    `把修好的完整代码写回 \`${rel}\`。`,
    '你可以用编译器验证，改到它通过为止。',
  ].join('\n')
}

/** 跑一次 `claude -p`，收事件流。 */
function runClaude(opts: {
  exe: string
  prompt: string
  cwd: string
  arm: Arm
  mcpConfig: string | null
  timeoutMs: number
  /** 覆盖 --allowedTools（实验用：看写全 MCP 工具名能不能免掉 ToolSearch） */
  allowedTools?: string
}): Promise<{
  answer: string
  toolUses: ToolUseEvent[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; turns?: number }
  timedOut: boolean
}> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      opts.prompt,
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      opts.allowedTools ?? 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash,mcp__jhyy',
    ]
    if (opts.arm.useMcp && opts.mcpConfig) {
      args.push('--mcp-config', opts.mcpConfig)
    }
    if (opts.arm.systemPrompt) args.push('--append-system-prompt', opts.arm.systemPrompt)
    if (opts.arm.systemPromptFile && existsSync(opts.arm.systemPromptFile)) {
      args.push('--append-system-prompt-file', opts.arm.systemPromptFile)
    }

    const child = spawn(opts.exe, args, {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
    })

    // ⚠️ **收集整段输出再统一解析** —— 解析逻辑在 trajectory.ts（单一真相源，
    //   可单测）。增量解析会导致「半行 JSON」被丢掉。
    const lines: string[] = []
    let buf = ''
    let usage: RunRecord['usage']
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk) => {
      buf += String(chunk)
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        lines.push(line)
        buf = buf.slice(idx + 1)
        // usage 只在最后一个 `result` 事件里 ⇒ 边收边抓
        if (line.trim().startsWith('{')) {
          try {
            const ev = JSON.parse(line.trim())
            if (ev.type === 'result') {
              usage = {
                inputTokens: ev.usage?.input_tokens,
                outputTokens: ev.usage?.output_tokens,
                costUsd: ev.total_cost_usd,
                turns: ev.num_turns,
              }
            }
          } catch {
            /* 半行 JSON —— 下一轮再试 */
          }
        }
      }
    })
    child.stderr.on('data', () => {
      /* 进度噪声，忽略 */
    })
    child.on('close', () => {
      clearTimeout(timer)
      const traj = parseStream(lines)
      resolve({ answer: traj.answer, toolUses: traj.toolUses, usage, timedOut })
    })
  })
}

// ── 主流程 ────────────────────────────────────────────────────

interface TaskFile {
  version: number
  tasks: EvalTask[]
}

async function main() {
  const armName = arg('arm', 'baseline')!
  const arm = ARMS[armName]
  if (!arm) {
    console.error(`✗ 未知臂：${armName}（可用：${Object.keys(ARMS).join(', ')}）`)
    process.exit(1)
  }
  const limit = Number(arg('tasks', '0'))
  const repeat = Number(arg('repeat', '1'))
  const timeoutSec = Number(arg('timeout', '300'))
  // --prompt-style current|tight ⇒ 题目的措辞风格（归因实验用，见 buildPrompt 的注释）
  const promptStyle = arg('prompt-style', 'current') ?? 'current'
  // --allowed-tools：覆盖工具白名单（实验用）
  const allowedTools = arg('allowed-tools')
  const outDir = arg('out') ?? join(ideRoot, 'eval', 'out')

  // --lang c ⇒ **对照组**：同一个算法用大众语言（C）实现
  const lang = arg('lang', 'jhyy') ?? 'jhyy'
  const tasksFile = join(
    ideRoot,
    'eval',
    lang === 'c' ? 'tasks-c.json' : lang === 'paired' ? 'tasks-paired.json' : 'tasks.json',
  )
  const cTaskDir = join(ideRoot, 'eval', lang === 'paired' ? 'tasks-paired' : 'tasks-c')
  if (!existsSync(tasksFile)) {
    console.error(`✗ 找不到 ${tasksFile} —— 先跑 scripts/eval/build-tasks.ts`)
    process.exit(1)
  }
  const taskFile = JSON.parse(readFileSync(tasksFile, 'utf8')) as TaskFile

  const exePath = findCompiler()
  const corpusRoot = findLangRepo()
    ? join(findLangRepo()!, 'compiler', 'tests', 'examples')
    : null
  const claude = await locateClaude()
  if (!exePath || !corpusRoot || !claude) {
    console.error('✗ 找不到编译器 / 语料 / claude —— 评测需要语言仓库（兄弟目录）和 claude CLI。')
    process.exit(1)
  }

  let tasks = taskFile.tasks
  // --mutations a,b ⇒ 只跑这几种变异（跑全量太贵，先挑着跑）
  const mutFilter = arg('mutations')
  if (mutFilter) {
    const want = new Set(mutFilter.split(',').map((s) => s.trim()))
    tasks = tasks.filter((t) => want.has(t.mutationId))
  }
  // --task-lang jhyy|c ⇒ 只跑某种语言的任务（配对集里两侧同 id ⇒ 只能按语言筛）
  const taskLang = arg('task-lang')
  if (taskLang) tasks = tasks.filter((t) => (t.lang ?? 'jhyy') === taskLang)
  if (limit > 0) tasks = tasks.slice(0, limit)

  console.log(`臂：${arm.name}`)
  console.log(`任务：${tasks.length} 道 × 重复 ${repeat} 次`)
  console.log(`claude：${claude.path}${claude.version ? ` (${claude.version})` : ''}`)
  console.log(`编译器：${exePath}\n`)

  const mcpConfig = arm.useMcp ? await buildMcpConfig() : null
  console.log(mcpConfig ? `MCP：${mcpConfig}` : 'MCP：（未挂）')
  console.log('')

  mkdirSync(outDir, { recursive: true })
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonl = join(outDir, `${runId}-${arm.name}.jsonl`)
  writeFileSync(jsonl, '', 'utf8')

  const records: RunRecord[] = []

  for (const task of tasks) {
    for (let r = 0; r < repeat; r++) {
      const { dir, rel } = setupWorkspace(task, corpusRoot, cTaskDir)
      const targetAbs = join(dir, rel)
      try {
        const res = await runClaude({
          exe: claude.path,
          prompt: buildPrompt(task, rel, promptStyle, promptStyle === 'tight' ? exePath : undefined),
          cwd: dir,
          arm,
          mcpConfig,
          timeoutMs: timeoutSec * 1000,
          allowedTools,
        })

        const versions = reconstructVersions(res.toolUses, targetAbs, task.broken)
        // 模型没写文件、只在对话里贴了代码 ⇒ 也算一版
        if (versions.length === 1) {
          const fromChat = extractCodeFromAnswer(res.answer)
          if (fromChat && fromChat.trim()) versions.push(fromChat)
        }
        // ⚠️ **磁盘上的最终内容才是权威** —— 事件流重放可能漏（模型用 Edit /
        // MultiEdit 改的、或者路径写法怪）⇒ 最后一版以磁盘为准。
        try {
          const onDisk = readFileSync(targetAbs, 'utf8')
          if (versions[versions.length - 1] !== onDisk) versions.push(onDisk)
        } catch {
          /* 读不到就当没这版 */
        }

        const grades: RunRecord['grades'] = []
        let firstPass = false
        let finalPass = false
        for (let i = 0; i < versions.length; i++) {
          const isLast = i === versions.length - 1
          writeFileSync(targetAbs, versions[i], 'utf8')
          const g = await grade({
            task,
            file: targetAbs,
            exePath,
            cwd: findLangRepo() ?? dir,
            outBase: `eval_${arm.name}_${tasks.indexOf(task)}_${r}_${i}`,
          })
          grades.push({ passed: g.passed, reason: g.reason })
          if (g.passed && !firstPass) firstPass = true
          if (g.passed && isLast) finalPass = true
        }

        const rec: RunRecord = {
          taskId: task.id,
          arm: arm.name,
          repeat: r,
          mutationId: task.mutationId,
          rule: task.rule,
          firstPass,
          finalPass,
          versions: versions.length,
          usedCompiler: usedCompiler(res.toolUses),
          reason: grades.find((g) => !g.passed)?.reason,
          usage: res.usage,
          answer: res.answer.slice(0, 600),
          grades,
          versionSources: versions,
          trajectory: res.toolUses.map(summarizeToolUse),
        }
        records.push(rec)
        writeFileSync(jsonl, JSON.stringify(rec) + '\n', { flag: 'a', encoding: 'utf8' })

        const mark = finalPass ? '✓' : firstPass ? '~' : '✗'
        console.log(
          `${mark} ${task.id.padEnd(42)} 首过=${firstPass ? 'Y' : 'n'} ` +
            `最终=${finalPass ? 'Y' : 'n'} 版本=${versions.length} ` +
            `编译=${rec.usedCompiler ? 'Y' : 'n'} ` +
            `${res.usage?.costUsd !== undefined ? '$' + res.usage.costUsd.toFixed(4) : ''}`,
        )
      } finally {
        // ⚠️ **清理失败不能带崩整个 run** —— 实测踩过：Windows 上刚跑完的
        //   `.exe` 还被进程占着 ⇒ `rmSync` 抛 EPERM ⇒ 整个评测挂掉。
        // ⇒ 吞掉异常（临时目录留给系统清理）。
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 删不掉就算了 */
        }
      }
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────
  const n = records.length
  const first = records.filter((r) => r.firstPass).length
  const final = records.filter((r) => r.finalPass).length
  const cost = records.reduce((a, r) => a + (r.usage?.costUsd ?? 0), 0)
  const turns = records.reduce((a, r) => a + (r.usage?.turns ?? 0), 0)

  console.log(`\n===== 臂 ${arm.name} =====`)
  console.log(`首次写对：${first}/${n}（${n ? ((first / n) * 100).toFixed(0) : 0}%）`)
  console.log(`最终写对：${final}/${n}（${n ? ((final / n) * 100).toFixed(0) : 0}%）`)
  console.log(`用了编译器：${records.filter((r) => r.usedCompiler).length}/${n}`)
  console.log(`平均轮数：${n ? (turns / n).toFixed(1) : 0}`)
  console.log(`总花费：$${cost.toFixed(4)}`)
  console.log(`明细：${jsonl}`)

  const byMut = new Map<string, { first: number; final: number; n: number }>()
  for (const r of records) {
    const e = byMut.get(r.mutationId) ?? { first: 0, final: 0, n: 0 }
    e.n++
    if (r.firstPass) e.first++
    if (r.finalPass) e.final++
    byMut.set(r.mutationId, e)
  }
  console.log('\n按规则分组：')
  for (const [m, e] of [...byMut].sort()) {
    console.log(`  ${m.padEnd(22)} 首过 ${e.first}/${e.n}   最终 ${e.final}/${e.n}`)
  }
}

await main()
