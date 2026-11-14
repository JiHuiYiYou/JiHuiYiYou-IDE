#!/usr/bin/env node
/**
 * PostToolUse hook —— **模型一写完 `.jhyy`，IDE 立刻编译，把真实诊断喂回去**。
 *
 * ## 为什么有这个
 *
 * 评测的轨迹归因（`scripts/eval/analyze-turns.ts`，32 道题）显示：
 *
 * | 大类 | 占比 | 说明 |
 * |---|---|---|
 * | **验证**（编译 + 跑程序） | **31~34%** | 模型自己花好几轮「想起来去编译」 |
 * | 找工具（ToolSearch） | 8~9% | 不知道有 `jhyy_check` / `jhyy_run` |
 * | 查资料 | 17~22% | 查规范 / 查台账 |
 *
 * ⇒ **「验证」是最大的开销**，而其中「模型自己想起来要去编译」这一段
 *   **可以由系统代劳** —— 模型写完文件，**编译自动发生**，诊断自动进上下文。
 *
 * ⇒ 这跟「让模型自己记得验」是本质区别：**从「靠模型的自觉」变成「系统的保证」**。
 *
 * ## 协议（Claude Code）
 *
 * - 钩子命令从 **stdin** 收一段 JSON：含 `tool_name` / `tool_input` / `cwd` …
 * - 想把信息注入模型上下文 ⇒ stdout 输出：
 *   `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
 * - **退出码 0 = 成功**。⚠️ **永远 exit 0** —— 这个钩子只**提供信息**，
 *   绝不能阻断会话（阻断用 exit 2，但会让 IDE 看起来卡死）。
 *
 * ## 用法
 *
 *     node scripts/jhyy-check-hook.mjs <jhyy.exe 路径>
 *
 * 由 `src/main/claude/hooks.ts` 生成一份临时 `settings.json`，命令行里带上编译器路径
 * ⇒ **钩子自己不用猜编译器在哪**。
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const COMPILER = process.argv[2] ?? ''
/**
 * 「报错 → 修法」表的路径（可选）。
 *
 * ⚠️ **跨仓产物** —— 真相在语言仓（`docs/generated/jhyy-error-fix.json`，
 *   从 `mcp-jhyy/jhyy_errors.py` 导出）⇒ IDE 只读、不生成。
 *   找不到就**不注入修法**（hook 仍然正常工作）。
 */
const ERROR_FIX = process.argv[3] ?? ''

/** 「报错 → 修法」表（懒加载 + 缓存）。 */
let errorFixCache = null
function loadErrorFix() {
  if (errorFixCache !== null) return errorFixCache
  errorFixCache = []
  if (!ERROR_FIX) return errorFixCache
  try {
    const raw = JSON.parse(readFileSync(ERROR_FIX, 'utf8'))
    errorFixCache = Array.isArray(raw?.entries) ? raw.entries : []
  } catch {
    errorFixCache = []
  }
  return errorFixCache
}

/** 归一化（跟语言仓 `jhyy_errors.normalize()` 一个口径）。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/^.*?:\d+:\d+:\s*/, '')
    .replace(/^(error|warning)\s*:\s*/i, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 给一条诊断找「什么意思 / 怎么改 / 该查哪一节」。
 *
 * ⚠️ **只认高置信匹配**（完全相等 / 一方是另一方的子串且够长）
 *   ⇒ 宁可不给，也别给错的 —— **瞎猜比不给更糟**。
 */
function lookupFix(message) {
  const q = normalize(message)
  if (!q) return null
  const entries = loadErrorFix()
  let best = null
  let bestLen = 0
  for (const e of entries) {
    const t = normalize(e.text)
    if (!t) continue
    if (t === q) return e
    if (t.length >= 12 && q.includes(t)) {
      if (t.length > bestLen) {
        best = e
        bestLen = t.length
      }
    } else if (q.length >= 12 && t.includes(q) && !best) {
      best = e
    }
  }
  return best
}

/** 把一条诊断渲染成「位置 + 原文 + 怎么改」。 */
function renderDiagnostic(d) {
  const head = `- ${d.line}:${d.col} ${d.message}`
  const hit = lookupFix(d.message)
  if (!hit) return head
  const bits = []
  if (hit.meaning) bits.push(`什么意思：${hit.meaning}`)
  if (hit.fix) bits.push(`怎么改：${hit.fix}`)
  const refs = []
  if (hit.spec_ref) refs.push(`规范 ${hit.spec_ref}`)
  if (hit.w_ref) refs.push(`台账 ${hit.w_ref}`)
  if (refs.length) bits.push(`见 ${refs.join(' / ')}`)
  if (!bits.length) return head
  return `${head}\n  → ${bits.join('；')}`
}

/** 从编译器 stderr 里抠出诊断行。 */
function parseDiagnostics(stderr) {
  const out = []
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^(.*?):(\d+):(\d+):\s*(error|warning)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4],
      message: m[5],
    })
  }
  return out
}

/**
 * 记一行到日志（`JHY_HOOK_LOG` 指定）。
 *
 * ⚠️ **只为验证用**：hook 到底有没有被 CLI 真的触发、诊断有没有真的进上下文，
 * 光看代码不算数 ⇒ 得有一个**外部可观测**的信号。
 * 生产环境不设这个环境变量 ⇒ 什么都不写 ⇒ 零开销。
 */
function logHook(line) {
  const path = process.env.JHY_HOOK_LOG
  if (!path) return
  try {
    appendFileSync(path, line + '\n')
  } catch {
    /* 记不上就算了 */
  }
}

function main() {
  // 1) 读钩子负载
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }
  let payload = {}
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    return
  }

  // 2) 只管「改了 .jhyy 文件」这件事
  const tool = String(payload.tool_name ?? '')
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return
  const file = String(payload.tool_input?.file_path ?? '')
  if (!file.endsWith('.jhyy')) return
  if (!COMPILER) return

  // 3) 编译
  // ⚠️ **不要用 `--no-link`** —— 链接期错误才是**模型最常犯的那一类**：
  //   入口写成 `fn main`（该是 `fn main_jhyy`）在**链接期**才报
  //   （`undefined reference to 'main'`）⇒ 只查语法/语义会**完全漏掉它**。
  //
  // ⚠️ **要用 bash 跑（`-lc`）** —— 这是**踩过的坑**：
  //   直接 spawn 编译器时，hook 继承的是 CLI 的 env ⇒ 里面的 PATH 带着
  //   **错的 `C:\msys\usr\bin`**（不是 `C:\msys64`）⇒
  //   链接阶段 `windres`（嵌 exe 图标）**预处理失败** ⇒ 编译器判定
  //   「图标嵌入失败」⇒ 改用占位对象 `__jhyy_icon_obj_missing__` 去链接
  //   ⇒ **链接必然失败，而且失败原因跟我们的代码毫无关系**
  //   ⇒ 模型拿到的是**假错误**，连编译正确的代码也会被判失败
  //   （实测日志：「W-132: windres failed … icon embedding failed — 链接将失败」）。
  //
  //   走 bash（`-lc`）⇒ bash 加载 MSYS2 的 profile ⇒ PATH 正确 ⇒ windres 正常。
  //   CLI 自己的 env 里就有 `CLAUDE_CODE_GIT_BASH_PATH` ⇒ 不用猜路径。
  const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'C:\\msys64\\usr\\bin\\bash.exe'
  let stderr = ''
  // ⚠️ **成功判据 = 退出码** —— ⚠️ **不要用「有没有结构化诊断」**！
  //   链接期失败（`fn main` 该是 `fn main_jhyy`）**没有** `file:line:col:` 形态
  //   ⇒ 用诊断条数判断 ⇒ 会把**链接不过的程序说成「编译通过了」**
  //   ⇒ 模型以为做完了 ⇒ 交了一份链接不过的代码（实测踩过）。
  let exitCode = null
  try {
    const res = spawnSync(bash, ['-lc', `"${COMPILER}" compile "${file}"`], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    stderr = String(res.stderr ?? '')
    exitCode = res.status
    logHook(
      `COMPILE status=${res.status} signal=${res.signal ?? '-'} ` +
        `err=${res.error ? res.error.message : 'none'} stderrLen=${stderr.length}`,
    )
  } catch (e) {
    logHook(`COMPILE THREW ${e}`)
    return
  }

  logHook(`TRIGGER ${tool} ${file}`)
  if (process.env.JHY_HOOK_LOG) {
    const interesting = Object.keys(process.env)
      .filter((k) => /^(MSYS|MINGW|CHOCOLATE|CYGWIN|PATH|HOME|WINDIR|CLAUDE_CODE_GIT_BASH_PATH)$/i.test(k))
      .map((k) => `${k}=${String(process.env[k]).slice(0, 120)}`)
    logHook('ENV>>> ' + interesting.join(' | '))
  }
  logHook('STDERR>>> ' + JSON.stringify(stderr.slice(0, 900)))

  const diags = parseDiagnostics(stderr)
  const errors = diags.filter((d) => d.severity === 'error')
  let lines = []
  let headline = ''

  // ⚠️ **按退出码判断成功** —— 链接期失败没有结构化诊断（见上）。
  if (exitCode === 0) {
    // ⚠️ **编译成功也要说一句** —— 两个理由：
    //
    //   ① **可观测**：成功时也注入 ⇒ 「注入真的进了模型上下文」这件事
    //      **每次**都能被端到端验证（否则模型一次就改对时，注入路径根本测不到 ——
    //      实测踩过：模型知道入口叫 main_jhyy ⇒ 一次改对 ⇒ hook 无错可注 ⇒
    //      e2e 判不出「注入到底有没有生效」）。
    //   ② **省一轮**：模型改完 ⇒ 立刻知道「编译过了」⇒ **不用自己再编译一次确认**
    //      （评测实测：JHYY 侧模型「调编译器」只有 C 侧的一半（11/29 vs 28/29）
    //      ⇒ 它是「凭知识直接改」的 ⇒ 这次确认正好省掉它自己跑编译的那一轮）。
    //
    // 代价只有一句（≈15 token），比模型自己去编译一轮（一次工具往返 + 几百 token）便宜得多。
    logHook(`OK ${file}`)
    // ⚠️ **测试 marker**（`JHY_HOOK_MARKER`）—— 生产环境不设 ⇒ 零成本。
    //   它的作用：让 e2e 能**铁证**「注入的内容真的进了模型的上下文」
    //   （模型把 marker 复述出来 ⇒ 就进了）。
    const marker = process.env.JHY_HOOK_MARKER
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `✓ \`${file}\` 现在编译通过了（**只说明语法/语义没问题，不代表输出对**）。` +
            (marker ? ` [marker ${marker}]` : ''),
        },
        tool_response: { success: true },
      }),
    )
    return
  }

  if (errors.length > 0) {
    headline = `⚠️ 你刚写的 \`${file}\` **编译不过**（${errors.length} 个错误）：`
    lines = errors.slice(0, 20).map((d) => renderDiagnostic(d))
    if (errors.length > 20) lines.push(`- …还有 ${errors.length - 20} 个`)
  } else {
    // ⚠️ **链接期错误没有 `file:line:col` 形态** —— 入口写成 `fn main`
    //   （该是 `fn main_jhyy`）就是这种 ⇒ 只认结构化诊断会**整个漏掉**。
    const raw = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && /undefined reference|ld returned|collect2|error:/i.test(l))
    if (raw.length === 0) {
      // 编译退出码非 0、但既没结构化诊断也没链接错误 ⇒ 没东西可说 ⇒ 不出声
      // ⚠️ **但还是要写 `tool_response`** —— stdout 一个字节都不写的话，
      //   CLI 会把这次 hook 当成「出错」（实测踩过：漏掉它 ⇒ 诊断压根不注入）。
      logHook(`SILENT ${file}`)
      process.stdout.write(JSON.stringify({ tool_response: { success: true } }))
      return
    }
    headline = `⚠️ 你刚写的 \`${file}\` **编译/链接不过**：`
    lines = raw.slice(0, 10).map((l) => `- ${l}`)
    // ⚠️ **链接失败时 gcc/ld 的真实原因被吞掉了**（语言仓 W-226）：
    //   本机 gcc 只给出「ld returned 1 exit status」，
    //   **`undefined reference to 'main'` 根本没传回来** ⇒ 拿这条错误**不知道该改什么**。
    //   ⇒ 这里补一条**针对性提示**（条件式，不武断）。
    if (/ld returned|undefined reference|collect2/i.test(raw.join('\n'))) {
      lines.push(
        '- 💡 链接失败最常见的原因：**hosted 模式的入口函数名必须是 `main_jhyy`**' +
          '（不是 `main`）—— 先检查这个。',
      )
    }
  }

  // 4) 把诊断注入回上下文
  // ⚠️ **结尾这句话是有讲究的** —— 实测踩过：
  //   原来写「按这些诊断改，别靠猜。」⇒ **把模型从「去查规范」拽到「照诊断改」**
  //   ⇒ 评测里 `mask-change`（能编译、但输出不对）那类题**正确率掉了**。
  // ⇒ 现在改成：**先按诊断改，不确定就查错误索引拿修法** —— 指回**正确的工具**。
  const context = [
    headline,
    ...lines,
    '按这些诊断改；**不确定某个错是什么意思时**，用 MCP 工具 `jhyy_error_lookup` 查它的修法（别硬猜）。',
  ].join('\n')

  logHook(`INJECT ${file} :: ${errors.length} 个错误`)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
      // ⚠️ **`tool_response` 是 PostToolUse 专用的字段** —— CLI 的 hook 文档里写着
      //   `"tool_response": { "success": true }  // PostToolUse only`。
      //   **漏了它 ⇒ CLI 把这次 hook 当成「出错」⇒ 诊断压根不注入上下文**
      //   （实测：漏掉 ⇒ hook 日志空、模型没拿到诊断）。
      tool_response: { success: true },
    }),
  )
}

try {
  main()
} catch {
  // ⚠️ **钩子绝不能把会话搞崩** —— 任何异常都静默退出
}
process.exit(0)
