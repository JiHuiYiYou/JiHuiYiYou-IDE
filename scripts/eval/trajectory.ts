/**
 * 事件流解析 —— 把 `claude -p --output-format stream-json` 的输出变成可判分的东西。
 *
 * ## 为什么单独一个文件
 *
 * `run-eval.ts` 顶层有 `await main()` ⇒ **测试不能 import 它**（会真跑评测）。
 * ⇒ 解析逻辑拆到这里，单独可测。
 *
 * ## 三件事
 *
 * 1. **逐行解析 JSONL**（`claude` 的 stream-json 是一行一个 JSON）
 * 2. **重建模型改过的每一版** —— 依次重放 Write / Edit / MultiEdit
 * 3. **兜底**：模型没写文件、只在对话里贴了代码 ⇒ 从回答里抠出来
 */

/** 一次工具调用。 */
export interface ToolUseEvent {
  name: string
  input: any
  /** 对应的 tool_result（如果事件流里有） */
  result?: ToolResultEvent
}

/** 一次工具调用的结果。 */
export interface ToolResultEvent {
  /** 工具返回的文本（截断） */
  text: string
  /** 工具是不是报错了 */
  isError: boolean
}

/** 一次运行的解析结果。 */
export interface Trajectory {
  /** 助手的文本（所有轮次拼起来） */
  answer: string
  /** 工具调用（按时间顺序，带上结果） */
  toolUses: ToolUseEvent[]
  /** 助手消息的条数 */
  assistantMessages: number
}

/** 工具返回文本的截断长度（够看出成功/失败就行）。 */
const RESULT_SNIPPET = 400

/**
 * 归一化路径 —— **两边都要用**。
 *
 * ⚠️ Windows 上分隔符不一致：模型给的 `file_path` 可能是正斜杠，
 * `join()` 出来的是反斜杠 ⇒ 只归一化一边就永远比不相等
 * ⇒ 模型改了文件但我们没看见（实测踩过：模型明明改对了，评测却判失败）。
 */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * 解析 stream-json 的输出行。
 *
 * @param lines stdout 的行（不含换行）
 */
export function parseStream(lines: string[]): Trajectory {
  const answer: string[] = []
  const toolUses: ToolUseEvent[] = []
  /** toolUseId → 那次调用（用来把 tool_result 挂回去） */
  const byId = new Map<string, ToolUseEvent>()
  let assistantMessages = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let ev: any
    try {
      ev = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (ev.type === 'assistant') {
      assistantMessages++
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text') answer.push(b.text)
        else if (b.type === 'tool_use') {
          const tu: ToolUseEvent = { name: b.name, input: b.input }
          toolUses.push(tu)
          if (b.id) byId.set(b.id, tu)
        }
      }
    } else if (ev.type === 'user') {
      // tool_result 在「用户」消息里（角色是工具回声，不是真人说话）。
      // ⚠️ **字段名是 `tool_use_id`（snake_case）** —— 写 camelCase 会**静默拿不到结果**
      //    （实测：所有 tool_result 都成了空串 ⇒ 轨迹分析全瞎）。
      for (const b of ev.message?.content ?? []) {
        if (b.type !== 'tool_result') continue
        const id = b.tool_use_id ?? b.toolUseId
        const tu = id ? byId.get(id) : undefined
        if (!tu) continue
        const content = b.content
        const text = Array.isArray(content)
          ? content.map((c: any) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n')
          : String(content ?? '')
        tu.result = { text: text.slice(0, RESULT_SNIPPET), isError: Boolean(b.is_error) }
      }
    }
  }

  return { answer: answer.join(''), toolUses, assistantMessages }
}

/**
 * 重建模型改过的每一版。
 *
 * `initial` 是坏版本（第一版）。模型每改一次就多一版。
 * 重放 Edit / MultiEdit 时用**首个匹配**替换 —— 跟 Claude Code 的 Edit 语义一致
 * （old_string 不唯一时它会报错，所以唯一匹配是对的）。
 */
export function reconstructVersions(
  toolUses: ToolUseEvent[],
  targetPath: string,
  initial: string,
): string[] {
  const versions: string[] = [initial]
  let current = initial
  const target = normPath(targetPath)
  for (const ev of toolUses) {
    const p = String(ev.input?.file_path ?? '')
    if (!p || normPath(p) !== target) continue
    try {
      if (ev.name === 'Write') {
        current = String(ev.input.content ?? '')
      } else if (ev.name === 'Edit') {
        current = current.replace(String(ev.input.old_string), String(ev.input.new_string))
      } else if (ev.name === 'MultiEdit') {
        const edits = Array.isArray(ev.input.edits) ? ev.input.edits : []
        for (const e of edits) current = current.replace(String(e.old_string), String(e.new_string))
      } else {
        continue
      }
      versions.push(current)
    } catch {
      /* 重放失败就到此为止 */
    }
  }
  return versions
}

/**
 * 从助手的回答里抠出一段代码（模型没写文件、只在对话里贴了代码的情况）。
 */
export function extractCodeFromAnswer(answer: string): string | undefined {
  const fence = /```(?:jhyy|rust)?\s*\n([\s\S]*?)```/.exec(answer)
  return fence ? fence[1] : undefined
}

/**
 * 模型有没有真的去编译（调 Bash 跑编译器）。
 *
 * ⚠️ 这不是「它说它编译了」—— 是**看它调了什么工具**。
 * 「假装验过了」的检测靠这个。
 */
export function usedCompiler(toolUses: ToolUseEvent[]): boolean {
  return toolUses.some(
    (t) => t.name === 'Bash' && /jhyy|compile|\.exe/i.test(String(t.input?.command ?? '')),
  )
}

/** 轨迹里的一次工具调用（落盘用的紧凑形状）。 */
export interface TrajectoryEntry {
  /** 工具名 */
  tool: string
  /** **归类** —— 分析轮数去向就靠它 */
  kind: ToolKind
  /** 输入摘要（命令 / 路径 / 查询串） */
  what: string
  /** 结果摘要（截断） */
  result?: string
  /** 结果是不是错误 */
  isError?: boolean
  /** 这次调用是不是一次「编译」 */
  isCompile?: boolean
  /** 这次编译**成功**了吗（从结果文本里看有没有 error:） */
  compileOk?: boolean
}

/** 工具调用的归类。 */
export type ToolKind =
  | 'compile' // 调编译器
  | 'edit' // 写/改文件
  | 'read' // 读文件
  | 'explore' // ls/grep/find/which/glob/powershell —— 找东西
  | 'peek-grader' // **翻判分脚本 / 找答案**（评测自己的东西）
  | 'peek-impl' // **翻编译器实现源码**（逆向实现）
  | 'run' // 跑程序（不是编译）
  | 'find-tool' // ToolSearch —— **在「找该用哪个工具」**
  | 'mcp:spec' // 查规范
  | 'mcp:ledger' // 查台账
  | 'mcp:check' // 用 MCP 编译检查
  | 'mcp:run' // 用 MCP 跑程序
  | 'mcp:other' // 其它 MCP
  | 'subagent' // 派子代理
  | 'other'

/** 这段文本像不像「编译失败」。 */
function looksLikeCompileFailure(text: string): boolean {
  if (/"ok"\s*:\s*false/.test(text)) return true
  if (/\berror:\s/m.test(text)) return true
  if (/error\[E\d+\]/.test(text)) return true
  return false
}

/**
 * **按工具名归类** —— 单一真相源。
 *
 * ⚠️ **为什么按「工具名 + 输入摘要」而不是按别的**：轨迹是**落盘**的，
 *   落盘时的归类规则可能比现在的旧 ⇒ 分析器**离线重新归类**，
 *   这样老 run 也能用新规则分析。
 */
/**
 * **越界探索** —— 模型跑去翻**评测自己**的东西，而不是做任务。
 *
 * 为什么要单独一类（2026-11-15 实测）：
 *   翻译题的 8 道全部由 difftest 的**随机 u32 程序**生成 ⇒ 8 道题其实
 *   是同一道题的 8 次采样。而 G 臂 157 次工具调用里，**28% 是「探索」**
 *   —— 拆开看，其中一大块根本不是「摸 stdlib」，而是：
 *     · 翻 `bench/difftest.py` / `bench/seeds/golden.json` —— **找答案**
 *       （模型发现输出对不上 ⇒ 去判分脚本里找期望输出）
 *     · 翻 `compiler/src0/jhyy_helpers.c` —— **逆向编译器实现**
 *       （想知道 stdout 到底是不是 CRLF）
 *
 * ⇒ 这两类不是「探索」的一部分，是**离题**：它们既不产出答案也不产出
 *   知识包能覆盖的东西。混在「探索」里 ⇒ 归因会把它误记成「摸 stdlib」
 *   ⇒ 于是「该补 stdlib 用法」的结论就下错了。
 *
 * 判据只看**路径/命令文本**里有没有那些**不属于题目工作目录**的东西。
 */
const GRADER_PEEK_RE =
  /difftest|golden\.json|known-divergent|tasks-paired|expected\.json|eval[\\/]tasks/i
const IMPL_PEEK_RE =
  /compiler[\\/]src|jhyy_helpers|jh_fputs|src0[\\/]|main\.jhyy\.il/i

export function classifyTool(name: string, what: string): ToolKind {
  // ⚠️ **越界探索要在所有常规归类之前判** —— 一条 `grep -rn difftest ...`
  //   本来会被归成 'explore'，一条 `cat bench/difftest.py` 会被归成 'run'。
  if (GRADER_PEEK_RE.test(what)) return 'peek-grader'
  if (IMPL_PEEK_RE.test(what)) return 'peek-impl'
  if (name === 'Bash') {
    if (/\bcompile\b|\.exe\s+compile|jhyy\s+compile/i.test(what)) return 'compile'
    if (/\b(ls|grep|find|which|dir|tree|rg)\b/i.test(what)) return 'explore'
    return 'run'
  }
  if (name === 'Read') return 'read'
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return 'edit'
  // ⚠️ **单独一类** —— 它是「模型在找该用哪个工具」的纯开销
  if (name === 'ToolSearch') return 'find-tool'
  if (name === 'Glob' || name === 'Grep' || name === 'PowerShell') return 'explore'
  if (name === 'Task') return 'subagent'
  if (name.startsWith('mcp__')) {
    const m = /^mcp__[^_]+__(.+)$/.exec(name)
    const tool = m ? m[1] : name
    if (/lang_ref|spec/i.test(tool)) return 'mcp:spec'
    if (/workaround/i.test(tool)) return 'mcp:ledger'
    if (/check/i.test(tool)) return 'mcp:check'
    if (/compile/i.test(tool)) return 'compile'
    if (/_run$|run_/i.test(tool)) return 'mcp:run'
    return 'mcp:other'
  }
  return 'other'
}

/** 把一次工具调用归类 + 摘要。 */
export function summarizeToolUse(tu: ToolUseEvent): TrajectoryEntry {
  const name = tu.name
  const input = tu.input ?? {}
  let what = ''

  if (name === 'Bash') {
    what = String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 120)
  } else if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    what = String(input.file_path ?? '')
  } else if (name === 'ToolSearch') {
    what = String(input.query ?? '').slice(0, 80)
  } else if (name === 'Glob' || name === 'Grep' || name === 'PowerShell') {
    what = String(input.pattern ?? input.query ?? input.command ?? '').slice(0, 80)
  } else if (name === 'Task') {
    what = String(input.description ?? input.subagent_type ?? '')
  } else if (name.startsWith('mcp__')) {
    what = String(input.query ?? input.file ?? input.file_path ?? '').slice(0, 80)
  }

  const kind = classifyTool(name, what)
  const res = tu.result
  const isCompile = kind === 'compile' || kind === 'mcp:check'
  return {
    tool: name,
    kind,
    what,
    result: res?.text,
    isError: res?.isError,
    isCompile,
    // 编译成功 = 结果里没有失败迹象
    compileOk: isCompile && res ? !looksLikeCompileFailure(res.text) : undefined,
  }
}
