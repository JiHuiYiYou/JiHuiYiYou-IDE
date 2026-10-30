import { useEffect, useRef } from 'react'
import { chordOf, type Command } from './types'

/**
 * 全局快捷键。
 *
 * ⚠️ **为什么在渲染进程用捕获阶段，而不是主进程的 `before-input-event`**：
 * - 捕获阶段挂在 `window` 上会**先于** CodeMirror 的 keymap 执行
 *   （CM6 把 handler 挂在 `contentDOM` 上，是后代）。`preventDefault()` +
 *   `stopPropagation()` 之后 CM6 根本看不到这个事件 —— 这正是「Ctrl+S 不被
 *   CodeMirror 抢走」的机制。
 * - `before-input-event` 触发时渲染进程已经把事件派发给焦点元素了，
 *   而且它**不知道焦点在聊天输入框还是在编辑器**。
 * - 只有渲染进程知道焦点在哪 —— 而 scope 判定（app / editor）正需要这个。
 *
 * ⚠️ **必须先 `Menu.setApplicationMenu(null)`**（见 `src/main/index.ts`）：
 * Electron 默认菜单的 accelerator 会在渲染进程看到按键之前就被吃掉
 * （`F5`/`Ctrl+R` 重载、`Ctrl+W` 关窗、`Ctrl+Q` 退出……）。
 */
export function useKeybindings(commands: Command[]): void {
  const ref = useRef(commands)
  ref.current = commands

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入法组合中的按键不算（中文输入法会发 composition 事件）
      if (e.isComposing) return

      const chord = chordOf(e)
      const inEditor = isEditorFocused()
      const cmd = ref.current.find(
        (c) => c.keybinding === chord && (c.scope !== 'editor' || inEditor),
      )
      if (!cmd) return
      if (cmd.enabled && !cmd.enabled()) return

      e.preventDefault()
      e.stopPropagation()
      void cmd.run()
    }
    // 捕获阶段 —— 见上面的说明
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

/** 焦点在 CodeMirror 里吗？（聊天输入框不算 —— 它的剪贴板/撤销要保持原生） */
function isEditorFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  return el instanceof HTMLElement && el.closest('.cm-editor') !== null
}
