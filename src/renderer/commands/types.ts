/**
 * 命令表 —— 菜单栏 / 命令面板 / 快捷键的**唯一真相**。
 *
 * 三个消费方：
 * - `workbench/MenuBar.tsx` —— 标题栏上的文件/编辑/选择/查看//goto 下拉
 * - `workbench/CommandPalette.tsx` —— `Ctrl+Shift+P` 的命令面板
 * - `commands/useKeybindings.ts` —— 全局快捷键
 *
 * 菜单里显示的快捷键提示**从这张表派生**（不重写一遍），所以改一处三处都跟着变。
 */

/**
 * 命令的作用域。
 *
 * - `app` —— 永远接管这个按键（哪怕焦点在聊天输入框里）。
 * - `editor` —— **只有编辑器有焦点时**才接管；否则让 CodeMirror / textarea
 *   自己处理原生行为（剪贴板、撤销、全选、查找……）。
 */
export type CommandScope = 'app' | 'editor'

export interface Command {
  id: string
  /** 本地化标题（中文） */
  title: string
  /** 英文原文 —— 命令面板里像 VS Code 那样显示第二行 */
  titleEn?: string
  /** 分类 —— 命令面板显示 "分类: 标题" */
  category?: string
  /** 规范化后的快捷键，例如 "Ctrl+Shift+P" */
  keybinding?: string
  scope?: CommandScope
  run: () => void | Promise<void>
  /** 菜单里灰掉（返回 false） */
  enabled?: () => boolean
  /** 勾选态菜单项 */
  checked?: () => boolean | undefined
}

/** 菜单里的一项。`label` 为空 ⇒ 分隔线。 */
export interface MenuItem {
  label?: string
  /** 指向命令表里的某条命令（菜单项的快捷键提示会从那儿取） */
  commandId?: string
  /** 直接执行（不走命令表） */
  run?: () => void
  enabled?: () => boolean
  checked?: () => boolean | undefined
  submenu?: MenuItem[]
}

export interface MenuSpec {
  id: string
  label: string
  items: MenuItem[]
}

/** 命令表里查命令。 */
export function findCommand(commands: Command[], id: string): Command | undefined {
  return commands.find((c) => c.id === id)
}

/**
 * 按键事件里我们只关心的那几项。
 *
 * 故意用**结构类型**而不是 `KeyboardEvent` —— 这样 `chordOf` 不用 DOM 就能测
 * （仓库里没有 jsdom，`tests/` 跑在 Node 环境里）。
 */
export interface KeyChord {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * 键名别名 —— `KeyboardEvent.key` 的原始值跟 VS Code 的写法对不上。
 *
 * ⚠️ 别名表和注册表必须用**同一套写法**，否则匹配不上。
 */
const KEY_ALIASES: Record<string, string> = {
  '`': 'Backquote',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/**
 * 把按键事件规范化成 "Ctrl+Shift+P" 这样的字符串。
 *
 * ⚠️ 修饰键的**顺序必须固定** —— 注册表和匹配器共用这一个函数，
 * 否则 "Ctrl+Shift+P" 和 "Shift+Ctrl+P" 会对不上。
 *
 * ⚠️ 单字符键**转成大写** —— 按住 Ctrl 时 `e.key` 是小写（'j'），
 * 而按住 Shift 时是大写（'B'）。注册表里写的是 "Ctrl+J" / "Ctrl+Shift+B"，
 * 所以这里统一大写；Shift 本身已经是独立的修饰键，不影响区分。
 */
export function chordOf(e: KeyChord): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  let key = e.key
  const alias = KEY_ALIASES[key]
  if (alias) {
    key = alias
  } else if (key.length === 1) {
    key = key.toUpperCase()
  } else {
    key = key.charAt(0).toUpperCase() + key.slice(1)
  }
  parts.push(key)
  return parts.join('+')
}

/**
 * 显示用的快捷键写法。
 *
 * 匹配时用规范化名字（`Ctrl+Backquote`），显示时用大家看得惯的符号
 * （VS Code 显示的是 ``Ctrl+` ``）。
 */
export function displayChord(chord: string): string {
  return chord.replace(/Backquote/g, '`').replace(/Space/g, 'Space')
}

/** 命令面板的模糊匹配 —— 子序列匹配，连续命中和词首命中加分。 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return 0
    // 连续命中加分，词首命中额外加分
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak
    if (found === 0 || /[\s:·/]/.test(t[found - 1] ?? '')) score += 3
    ti = found + 1
  }
  // 越短的目标越像用户想要的
  return score - target.length * 0.01
}
