/**
 * **大文件模式** —— 打开一个特别大的文件时，IDE 要**主动关掉几样东西**。
 *
 * ## 为什么
 *
 * ⚠️⚠️ **大文件的每一个「全文件操作」都是致命的** ——
 *   打开一个 10 MB 的文件 ⇒ 后面这些全都按 10 MB 算：
 *
 * | 操作 | 代价 | 后果 |
 * |---|---|---|
 * | 后台实时检查 | 把整份源码写进临时文件 + 起一个 `jhyy.exe` 编全文件 | **好几秒**，而且每 600 ms 空闲就一次 ⇒ 机器被压满 ⇒ IDE 卡死 ✗ |
 * | 拖块视图 | 解析整份源码 + 反编译成几千个块 | Blockly 直接趴窝 ✗ |
 * | 送进 Claude | 整份源码进系统提示 | 每轮对话重发一遍 ⇒ token 爆炸 ✗ |
 *
 * ⇒ ⇒ 所以：**超过阈值就进「大文件模式」**，把上面三样**自动关掉** ✓
 * ⇒ ⇒ 用户还是能**手动**「检查」/「运行」（那是他明确要的，一次性的）✓
 *
 * ## 跟 VS Code 一个路子
 *
 * VS Code 有 `editor.largeFileOptimizations`（超过 `files.maxMemoryForLargeFilesMB`
 * 就关掉语法高亮 / 补全）和 `editor.maxTokenizationLineLength`（20000）——
 * 核心思想一样：**大文件上牺牲功能，换 responsiveness** ✓
 *
 * ⚠️ **这个模块是纯函数** —— 好测（不用起 IDE）✓
 */

/**
 * **默认阈值：1 MB**。
 *
 * ⚠️ **为什么是 1 MB** —— JHYY 的源码一行大概 40 字符 ⇒ 1 MB ≈ 25000 行 ⇒
 *   那已经是个很大的文件了 ⇒ 而 CodeMirror 打开它是**瞬间**的（虚拟渲染）✓
 *   ⇒ 真正会卡的是**那些全文件操作** ⇒ 1 MB 是个合适的界线 ✓
 */
export const DEFAULT_LARGE_FILE_THRESHOLD = 1024 * 1024

/** 阈值下限 —— 再小就没意义了（64 KB 的文件本来就不卡）。 */
export const MIN_LARGE_FILE_THRESHOLD = 64 * 1024

/** 阈值上限 —— 再大就基本没法用了（64 MB）。 */
export const MAX_LARGE_FILE_THRESHOLD = 64 * 1024 * 1024

/**
 * **送进 Claude 的源码上限**（KB）。
 *
 * ⚠️ **为什么单独一个上限** —— 这是**「每功能硬上限」**那一层：
 *   就算文件没进大文件模式，超过这个大小也**不贴源码** ⇒
 *   ⇒ 只把路径报上去，让 Claude 自己 `Read` 磁盘上的文件 ✓
 *   ⇒ 理由：① 几 MB 的源码塞进系统提示 = 每轮对话都要重发一遍；
 *     ② Claude Code 本来就有 `Read` 工具；
 *     ③ 唯一读不到的是「**还没保存的修改**」⇒ 那就明说，让用户先保存 ✓
 */
export const DEFAULT_CLAUDE_CONTEXT_MAX_KB = 256

/** Claude 上下文下限（KB）。 */
export const MIN_CLAUDE_CONTEXT_MAX_KB = 16

/** Claude 上下文上限（KB）。 */
export const MAX_CLAUDE_CONTEXT_MAX_KB = 4096

/** 这个文件算不算「大文件」。 */
export function isLargeFile(bytes: number, threshold: number): boolean {
  return bytes >= threshold
}

/** 把阈值夹到合法范围。 */
export function clampLargeFileThreshold(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_LARGE_FILE_THRESHOLD
  return Math.min(Math.max(Math.round(v), MIN_LARGE_FILE_THRESHOLD), MAX_LARGE_FILE_THRESHOLD)
}

/** 把 Claude 上下文上限夹到合法范围。 */
export function clampClaudeContextMaxKb(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_CLAUDE_CONTEXT_MAX_KB
  return Math.min(Math.max(Math.round(v), MIN_CLAUDE_CONTEXT_MAX_KB), MAX_CLAUDE_CONTEXT_MAX_KB)
}

/**
 * **大文件模式关掉了哪几样** —— 给提示消息用。
 *
 * ⚠️ **用户得知道为什么少了几样功能** —— 不然会以为是 IDE 坏了 ✓
 */
export const LARGE_FILE_DISABLED_FEATURES = [
  '后台实时检查',
  '拖块视图',
  '把整份源码送进 Claude',
] as const

/** 把字节数说成人话（KB / MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
