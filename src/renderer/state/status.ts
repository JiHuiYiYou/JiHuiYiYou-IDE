/**
 * **状态栏的消息** —— 只放「出错」的。
 *
 * ⚠️⚠️ **它必须是「**当前的**问题」，不是「历史日志」** ——
 *   用户报过：「右下角的状态栏不带更新的，一次编译失败就一直留着了」✗
 *   ⇒ ⇒ **问题解决了就得把它撤掉** ✓
 *   ⇒ ⇒ 所以每条消息都带一个 `tag`（属于哪一类）⇒ 撤的时候**只撤同一类** ✓
 *
 * ⚠️ **为什么按分类撤** —— 「块视图只重建了一部分」那条跟编译没关系 ⇒
 *   ⇒ 编译成功了**不该**把它撤掉 ✓
 */

/**
 * 消息属于哪一类（**撤的时候只撤同一类**）。
 *
 * - `'compile'` —— 编译失败（「检查」那一步）
 * - `'run'` —— 运行失败（程序那一步）
 * - `'blocks'` —— 块视图只重建了能解析的部分（源码有语法问题）
 * - `'claude-overwrite'` —— Claude 改文件时把用户未保存的修改覆盖了
 * - `'file'` —— 文件打不开 / 还没打开文件
 */
export type StatusTag = 'compile' | 'run' | 'blocks' | 'claude-overwrite' | 'file'

export interface Status {
  text: string
  /**
   * ⚠️ **只能是 `'bad'`** —— 状态栏**只放出错的消息**。
   *
   * ⚠️⚠️ **为什么把类型限死** —— 用户明说：
   *    「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   *    ⇒ 「运行中…」「退出码 42」「已保存…」「降级运行…」**都不该出现在这儿** ✓
   *    ⇒ **类型限死 ⇒ 编译器替你把关**（写错了编译不过）✓✓
   */
  kind: 'bad'
  /** 这一条属于哪一类（撤的时候只撤同一类） */
  tag?: StatusTag
  /**
   * **后台实时诊断能不能把它撤掉** ——
   *
   * ⚠️ 后台检查是 `--no-link` ⇒ 它**看得见源码错误**、**看不见链接错误** ⇒
   *   ⇒ 「链接失败」那条**不能**被后台诊断撤掉 ✓
   *   ⇒ 只有「确实有源码诊断」的那种才置 true ✓
   */
  clearsWhenDiagnosticsClean?: boolean
}

/**
 * **撤掉指定分类的消息** —— 别的分类**不动** ✓
 *
 * ⚠️ **为什么不能无脑全撤** —— 「块视图只重建了一部分」跟编译没关系 ⇒
 *   ⇒ 编译成功了**不该**把它撤掉 ✓
 */
export function clearStatus(
  prev: Status | undefined,
  ...tags: StatusTag[]
): Status | undefined {
  if (!prev) return prev
  if (prev.tag && tags.includes(prev.tag)) return undefined
  return prev
}

/**
 * **后台实时诊断干净了 ⇒ 撤掉那条消息**（如果它是被后台诊断验证过的）。
 *
 * ⚠️ **为什么后台诊断也能撤** —— 用户改完代码、后台检查说「没错了」⇒
 *   ⇒ 状态栏还挂着「编译失败」就是**骗人** ✗ ⇒ 撤掉 ✓
 *
 * ⚠️ **但只撤「有源码诊断」的那种** —— 后台是 `--no-link` ⇒
 *   ⇒ 它看不见链接错误 ⇒ 「链接失败」那条留着 ✓
 */
export function clearWhenDiagnosticsClean(prev: Status | undefined): Status | undefined {
  if (!prev) return prev
  if (prev.tag === 'compile' && prev.clearsWhenDiagnosticsClean) return undefined
  return prev
}
