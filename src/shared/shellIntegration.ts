/**
 * **Shell 集成**（OSC 633）—— 跟 VS Code 用的**同一套协议**。
 *
 * ## 为什么要有这个
 *
 * IDE 要知道三件跟 shell 有关的事，光看终端里滚过去的字节是**看不出来**的：
 *
 * | 要知道的 | 靠猜（老办法） | 靠 shell 集成（现在） |
 * |---|---|---|
 * | shell 现在在哪个目录 | 往 shell 里发一条 `cd`（**污染历史**、有延迟、还会报错） | shell 自己报 `Cwd=…` |
 * | shell 是不是空闲（停在提示符上） | 记「用户这一行有没有输入」（**猜**） | shell 报「提示符开始」 |
 * | 上一条命令的退出码 | 没有 | shell 报 `D;<code>` |
 *
 * 老办法的猜法不准 ⇒ 终端里就会出现「多一行空白」「提示符位置对不上」
 * 「一堆空提示符」这些怪现象（用户报过好几次）。
 *
 * ## 协议
 *
 * shell 在特定时机往输出里插 **OSC 633** 序列：
 *
 * ```
 * ESC ] 633 ; <字母> [ ; <参数> ] BEL        （或 ESC \ 收尾）
 * ```
 *
 * 字母的含义跟 VS Code 一致（这样两边的语义能对上）：
 *
 * - `A` —— **提示符开始**（shell 空闲了）
 * - `B` —— 提示符结束
 * - `C` —— 命令开始执行
 * - `D` —— 命令执行完（参数是退出码）
 * - `E` —— 命令行（参数是命令本身）
 * - `P` —— 属性（参数是 `键=值`，我们要的是 `Cwd=…`）
 *
 * ## 为什么解析器在**主进程**这边
 *
 * 因为**反应**要发生在主进程：cwd 变了要同步状态、退出码要记下来、
 * 序列本身还要**从输出里抠掉**（不然会漏到「输出」面板的纯文本里）。
 * ⇒ 解析完的**干净文本**再走 IPC 给渲染进程 ✓。
 */

/** OSC 633 的序列字母（跟 VS Code 一致）。 */
export const ShellSequence = {
  /** 提示符**开始** —— shell 空闲了，正在画提示符。 */
  PromptStart: 'A',
  /** 提示符**结束** —— 提示符画完了。 */
  PromptEnd: 'B',
  /** 命令**开始执行**。 */
  CommandStart: 'C',
  /** 命令**执行完** —— 参数是退出码。 */
  CommandFinished: 'D',
  /** 命令行 —— 参数是命令本身。 */
  CommandLine: 'E',
  /** 属性 —— 参数是 `键=值`（我们要的是 `Cwd=…`）。 */
  Property: 'P',
} as const

/** shell 集成报上来的事件。 */
export type ShellIntegrationEvent =
  | { type: 'promptStart' }
  | { type: 'promptEnd' }
  | { type: 'commandStart' }
  | { type: 'commandFinished'; exitCode: number | null }
  | { type: 'commandLine'; commandLine: string }
  | { type: 'property'; key: string; value: string }

/** OSC 的前缀（`ESC ]`）。 */
const OSC = '\x1b]'
/** BEL —— OSC 的结束符之一。 */
const BEL = '\x07'
/** ST（String Terminator）—— OSC 的另一个结束符（`ESC \`）。 */
const ST = '\x1b\\'

/** `OSC 633;` 的前缀长度。 */
const PREFIX = '633;'

/**
 * 造一条 OSC 633 序列。
 *
 * ⚠️ 用 **BEL** 收尾（不是 ST）—— 跟 VS Code 的 bash 脚本一致，
 *    而且 BEL 在 Windows 控制台和 xterm 里都认 ✓。
 */
export function osc633(payload: string): string {
  return `${OSC}${PREFIX}${payload}${BEL}`
}

/**
 * 解开 shell 的转义。
 *
 * shell 脚本在把值（目录、命令行）塞进 OSC 序列之前要转义 ——
 * 格式跟 **VS Code 一样**：
 *
 * - `\xHH` ⇒ 那个字节（控制字符、`;` 都这么编码）
 * - `\\` ⇒ 一个反斜杠
 * - 其它字符原样
 *
 * ⚠️ **两边必须配套** —— 脚本用 `src/main/shellIntegration.ts` 里那份编码，
 *    这里解的就是它 ⇒ 改一边就得改另一边。
 */
export function unescapeShellValue(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const hex = s.slice(i + 2, i + 4)
    if (s[i + 1] === 'x' && hex.length === 2 && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16))
      i += 3
      continue
    }
    if (s[i + 1] === '\\') {
      out += '\\'
      i += 1
      continue
    }
    // 落单的反斜杠 ⇒ 原样留着
    out += ch
  }
  return out
}

/**
 * 归一目录 —— **拿来比较两个路径是不是同一个**。
 *
 * ⚠️ **为什么要归一**：IDE 这边的 cwd 是 `C:\Users\…`（Node 的 `resolve`），
 *    而 shell 报回来的是 `C:/Users/…`（MSYS2 的 `cygpath -m`）⇒
 *    不归一的话**永远不相等** ⇒ 每次都白白发一条 `cd` ⇒ 终端里全是噪音。
 *
 * - 反斜杠 ⇒ 正斜杠（Windows 上两者等价）
 * - 去掉尾部的 `/`（根目录除外）
 * - Windows 路径**不区分大小写** ⇒ 统一小写再比
 */
export function normalizeCwd(p: string): string {
  if (!p) return ''
  let s = p.replace(/\\/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (/^[A-Za-z]:\//.test(s)) s = s.toLowerCase()
  return s
}

/**
 * **流式**的 OSC 633 解析器。
 *
 * ## 为什么要「流式」
 *
 * shell 的输出是**任意切块**过来的（16ms 攒一批、或者控制台一次吐一段）⇒
 * 一条 OSC 序列**完全可能横跨两块**（前半块在这儿，后半块在下一块）。
 * ⇒ 解析器得**记住没收全的尾巴**，等下一块来了再拼 ✓。
 *
 * ## 为什么不直接用正则
 *
 * 正则得处理「跨块」和「前缀撞车」（`ESC ] 6331;…` 不是 633 序列），
 * 很容易写错 ⇒ 手写扫描器更好测 ✓。
 */
export class ShellIntegrationParser {
  /** 没收全的尾巴（下一块来了接着拼）。 */
  private pending = ''

  /**
   * 喂进来一块输出。
   *
   * @returns `text` 是**抠掉 OSC 633 序列之后**的干净文本（照常发给渲染进程），
   *          `events` 是这一块里解析出来的 shell 集成事件。
   */
  push(chunk: string): { text: string; events: ShellIntegrationEvent[] } {
    const buf = this.pending + chunk
    this.pending = ''

    const events: ShellIntegrationEvent[] = []
    let text = ''
    let i = 0

    while (i < buf.length) {
      const esc = buf.indexOf(OSC, i)
      if (esc < 0) {
        // 后面没有 OSC 了 ⇒ 全是普通文本
        text += buf.slice(i)
        i = buf.length
        break
      }
      // `ESC ]` 后面不是 `633;` ⇒ 不是 shell 集成序列 ⇒ **原样放行**
      // （别的 OSC 序列——比如改标题——得让 xterm 自己处理）
      if (!buf.startsWith(PREFIX, esc + 2)) {
        text += buf.slice(i, esc + 2)
        i = esc + 2
        continue
      }
      // 找结束符
      const end = findTerminator(buf, esc + 2 + PREFIX.length)
      if (end < 0) {
        // **没收全** ⇒ 前面那段是普通文本，剩下的留着等下一块
        text += buf.slice(i, esc)
        i = esc
        break
      }
      // 收全了 ⇒ 前面是普通文本，序列本身丢掉（不让它漏到输出面板）
      text += buf.slice(i, esc)
      const payload = buf.slice(esc + 2 + PREFIX.length, end)
      const ev = parsePayload(payload)
      if (ev) events.push(ev)
      // 跳过结束符（BEL 1 个字节，ST 2 个字节）
      i = buf[end] === BEL ? end + 1 : end + 2
    }

    this.pending = buf.slice(i)
    return { text, events }
  }

  /** 解析器还没收全的尾巴（测试用）。 */
  get pendingText(): string {
    return this.pending
  }
}

/** 找 OSC 的结束符（BEL 或 ST）；找不到返回 -1。 */
function findTerminator(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === BEL) return i
    if (s[i] === '\x1b' && s[i + 1] === ST[1]) return i
  }
  return -1
}

/** 把 `633;` 后面的载荷变成一个事件；不认识的返回 null。 */
function parsePayload(payload: string): ShellIntegrationEvent | null {
  const semi = payload.indexOf(';')
  const code = semi < 0 ? payload : payload.slice(0, semi)
  const rest = semi < 0 ? '' : payload.slice(semi + 1)
  switch (code) {
    case ShellSequence.PromptStart:
      return { type: 'promptStart' }
    case ShellSequence.PromptEnd:
      return { type: 'promptEnd' }
    case ShellSequence.CommandStart:
      return { type: 'commandStart' }
    case ShellSequence.CommandFinished: {
      // 没有参数（`D`）⇒ **这一行敲的是空的**（没跑过命令）⇒ 退出码是 null
      if (rest === '') return { type: 'commandFinished', exitCode: null }
      const n = Number(rest)
      return { type: 'commandFinished', exitCode: Number.isFinite(n) ? n : null }
    }
    case ShellSequence.CommandLine:
      return { type: 'commandLine', commandLine: rest }
    case ShellSequence.Property: {
      const eq = rest.indexOf('=')
      if (eq < 0) return null
      return { type: 'property', key: rest.slice(0, eq), value: rest.slice(eq + 1) }
    }
    default:
      return null
  }
}
