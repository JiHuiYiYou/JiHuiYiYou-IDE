import { EditorState, Transaction } from '@codemirror/state'

/**
 * **文档仓库** —— 每个打开的文件一份 `EditorState` + 一份元信息。
 *
 * ## 为什么要有它
 *
 * ⚠️⚠️ **以前 App 的 React state 里存着三份全文**（`source` / `saved` /
 * `blocksAt`），而 CodeMirror 的文档里还有第四份 ⇒ **一个大文件在内存里
 * 躺了四遍** ⇒ 而且**每次按键**还要：
 *
 * - `doc.toString()` 重新物化一份（`codemirror.ts` 的 updateListener）
 * - `normalizeEol(value)` 再跑一遍全文件正则（`CodePane` 的同步 effect）
 * - `source !== saved` / `source !== blocksAt` 各比较一遍
 * - 把整份源码结构化克隆一次过 IPC（发给 Claude 的上下文）
 *
 * ⇒ **每敲一个字 ⇒ 五趟全文件遍历** ⇒ 文件越大越卡（10 MB ⇒ 几十毫秒/键）✗✗
 *
 * ⇒ ⇒ **现在文本只存在编辑器里**（`EditorState` 的 `Text` 是个 rope，
 * 很省）⇒ App **不再镜像**任何一份全文 ⇒
 *
 * - 每次按键 ⇒ **O(1)**（只报「变了」，不传内容）
 * - 切标签 ⇒ **O(1)**（`view.setState(别的文件的 state)`）
 * - 要内容的时候（存盘 / 编译前 / 建块树）⇒ **按需取一次** ✓
 *
 * 这就是 VS Code 的 **model ↔ view** 模型：`TextModel` 是真相，编辑器只是投影。
 *
 * ## 不变式（很重要）
 *
 * ⚠️ **store 里那份 state 必须是「最新的」** ——
 * CodeMirror 的 state 是**不可变**的，每次事务都产生新对象 ⇒
 * ⇒ 所以**每次事务之后**都要把新 state 写回 store
 * （`noteChange` 干这个）⇒
 * ⇒ 这样切标签时 `get(id)` 拿到的就是最新状态，撤销历史也还在 ✓
 */

/** 一个文件的仓库条目。 */
interface Entry {
  /** ★ 活文档 —— 文本在整个 IDE 里**只存在这一份** */
  state: EditorState
  /** 磁盘路径（未命名的新文件是 null） */
  path: string | null
  /** 存盘时的内容（LF）—— 脏标记靠它精确比较（VS Code 也有：lastResolvedContent） */
  savedText: string
  /** 有未保存的改动 */
  dirty: boolean
  /** 内容版本号（每次变 +1） */
  version: number
  /** 块视图最后一次重建时的版本号（-1 = 还没建过） */
  blocksVersion: number
  /** 这个文件是不是大文件模式 */
  large: boolean
}

/** 内容变了以后的状态。 */
export interface ChangeInfo {
  /** 新的脏标记 */
  dirty: boolean
  /**
   * 脏标记有没有**翻转**（只在翻转时才需要更新 React state）——
   *
   * ⚠️⚠️ **这条是「打字不卡」的关键** ——
   *   如果每次按键都更新 React state ⇒ **整棵树重渲染** ⇒ 卡 ✗
   *   ⇒ ⇒ 脏标记**只在 true↔false 翻转的那一刻**才通知 ⇒
   *   ⇒ 一个编辑会话里**只重渲染一次** ✓✓
   */
  dirtyChanged: boolean
}

export class DocStore {
  private entries = new Map<string, Entry>()

  /** 打开一个文件（建条目）。 */
  open(
    id: string,
    state: EditorState,
    savedText: string,
    large: boolean,
    path: string | null,
    dirty = false,
  ): void {
    this.entries.set(id, {
      state,
      path,
      savedText,
      dirty,
      version: 0,
      blocksVersion: -1,
      large,
    })
  }

  /**
   * **整份换掉内容**（磁盘上被改了 ⇒ 重新加载）。
   *
   * ⚠️ **不进撤销历史** —— 用户没改过这个文件 ⇒ 「撤销」不该把它变回去 ✓
   * ⚠️ **保留扩展** —— 用 `state.update()` 而不是重建 `EditorState` ⇒
   *   ⇒ 「文档变了」那个回调还在 ✓（重建的话回调就没了 ⇒ 之后打字收不到通知）
   * ⚠️ **版本号要 +1** —— 内容变了 ⇒ 块视图**过期了** ⇒
   *   ⇒ 不 +1 的话 `blocksStale` 说的是「没过期」⇒
   *   ⇒ 切到块视图时**不会重建** ⇒ 块视图显示的是**旧内容** ✗✗
   */
  replaceDoc(id: string, text: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.state = e.state.update({
      changes: { from: 0, to: e.state.doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
    }).state
    e.version += 1
  }

  /** 磁盘路径（未命名的新文件是 null）—— O(1)。 */
  path(id: string): string | null {
    return this.entries.get(id)?.path ?? null
  }

  /** 改磁盘路径（「另存为」之后）。 */
  setPath(id: string, path: string | null): void {
    const e = this.entries.get(id)
    if (e) e.path = path
  }

  /** 关掉文件 ⇒ 连同它的撤销历史一起扔掉（VS Code 关标签页也是这样）。 */
  delete(id: string): void {
    this.entries.delete(id)
  }

  /** 有没有这个文件。 */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** 某个文件的当前状态。 */
  get(id: string): EditorState | undefined {
    return this.entries.get(id)?.state
  }

  /** 文件的当前内容 —— ⚠️ **O(n)**，只在真需要的时候调（存盘 / 编译前）。 */
  text(id: string): string {
    return this.entries.get(id)?.state.doc.toString() ?? ''
  }

  /** 文件有多大（字符数）—— O(1)。 */
  size(id: string): number {
    return this.entries.get(id)?.state.doc.length ?? 0
  }

  /**
   * **内容变了** —— 更新状态、版本号、脏标记。
   *
   * @param state 最新的 state（CodeMirror 每次事务都产生新对象）
   * @param historyJump 是不是**撤销 / 重做**
   *   ⇒ 撤销/重做要**精确**比一次内容（否则「撤销回存盘点 ⇒ 小圆点消失」
   *   这个行为就没了）⇒ 代价 O(n)，但撤销是低频动作 ⇒ 可以接受 ✓
   *
   * ⚠️ **大文件模式不做精确比较** —— O(n) 的比较在大文件上不划算 ⇒
   *   大文件的脏标记只到「存盘」为止 ✓
   */
  noteChange(id: string, state: EditorState, historyJump: boolean): ChangeInfo {
    const e = this.entries.get(id)
    if (!e) return { dirty: false, dirtyChanged: false }
    const wasDirty = e.dirty
    e.state = state
    e.version += 1
    if (!historyJump) {
      e.dirty = true
    } else if (e.large) {
      // 大文件模式：不做精确比较（O(n)）⇒ 脏标记只到「存盘」为止
      e.dirty = true
    } else {
      e.dirty = state.doc.toString() !== e.savedText
    }
    return { dirty: e.dirty, dirtyChanged: e.dirty !== wasDirty }
  }

  /** 有没有未保存的改动 —— O(1)。 */
  isDirty(id: string): boolean {
    return this.entries.get(id)?.dirty ?? false
  }

  /** 内容版本号 —— O(1)。 */
  version(id: string): number {
    return this.entries.get(id)?.version ?? 0
  }

  /** 记下「刚刚存盘」⇒ 脏标记清掉，存盘快照更新。 */
  markSaved(id: string, text?: string): void {
    const e = this.entries.get(id)
    if (!e) return
    e.savedText = text ?? e.state.doc.toString()
    e.dirty = false
  }

  /** 块视图最后一次重建时的版本号 —— O(1)。 */
  blocksVersion(id: string): number {
    return this.entries.get(id)?.blocksVersion ?? -1
  }

  /** 记下「块视图刚按这个版本重建过」。 */
  setBlocksVersion(id: string, version: number): void {
    const e = this.entries.get(id)
    if (e) e.blocksVersion = version
  }

  /**
   * **块视图过期没有**（源码在块上次重建之后又变了）—— O(1)。
   *
   * ⚠️ **只用来决定「切到块视图时要不要重建」** ——
   *    不做任何视觉提示（见 CLAUDE.md）✓
   */
  blocksStale(id: string): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    return e.version !== e.blocksVersion
  }

  /** 这个文件是不是大文件模式。 */
  isLarge(id: string): boolean {
    return this.entries.get(id)?.large ?? false
  }

  /** 改「是不是大文件模式」。 */
  setLarge(id: string, large: boolean): void {
    const e = this.entries.get(id)
    if (e) e.large = large
  }
}
