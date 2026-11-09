/**
 * **用户设置** —— 编辑区的字体/字号 + 大文件阈值。
 *
 * 存在 localStorage 里（跟 `layout.ts` 一个套路，但**分开放** ——
 * 布局是「窗口长什么样」，设置是「用户想要什么」，两码事）。
 */

import {
  clampClaudeContextMaxKb,
  clampLargeFileThreshold,
  DEFAULT_CLAUDE_CONTEXT_MAX_KB,
  DEFAULT_LARGE_FILE_THRESHOLD,
} from '../editor/largeFile'

/** 用户设置。 */
export interface Settings {
  /**
   * **编辑区的字体**（CSS font-family 值）。
   *
   * ⚠️ 默认是 **MV Boli**（用户自己的偏好 —— 装在 `C:\Windows\Fonts\mvboli.ttf`）
   *    ⇒ 后面挂了等宽兜底 ⇒ **别的机器上也能正常显示** ✓
   */
  editorFontFamily: string
  /**
   * **编辑区的字号**（像素）。
   *
   * ⚠️ 以前**根本没设过** ⇒ 靠 `body { font-size: 13px }` 继承 ⇒
   *    现在默认 **12**（用户要的）✓
   */
  editorFontSize: number
  /**
   * **大文件阈值**（字节）—— 超过就进「大文件模式」。
   *
   * ⚠️ 大文件模式会**自动关掉**后台实时检查、拖块视图、
   *    还有「把整份源码送进 Claude」⇒
   *    ⇒ 用户得能调这个阈值（有的项目就是有大文件）✓
   */
  largeFileThreshold: number
  /**
   * **送进 Claude 的源码上限**（KB）。
   *
   * ⚠️ 超过这个大小就**只报路径**，让 Claude 自己 `Read` 磁盘上的文件 ✓
   */
  claudeContextMaxKb: number
}

export const DEFAULT_SETTINGS: Settings = {
  editorFontFamily: "'MV Boli', 'Cascadia Mono', Consolas, 'JetBrains Mono', monospace",
  editorFontSize: 12,
  largeFileThreshold: DEFAULT_LARGE_FILE_THRESHOLD,
  claudeContextMaxKb: DEFAULT_CLAUDE_CONTEXT_MAX_KB,
}

/** 字号的范围（太小看不清，太大放不下几行）。 */
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 48

const STORAGE_KEY = 'jhyy-ide.settings.v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      editorFontFamily:
        typeof parsed.editorFontFamily === 'string' && parsed.editorFontFamily.trim() !== ''
          ? parsed.editorFontFamily
          : DEFAULT_SETTINGS.editorFontFamily,
      // ⚠️ 数值要夹一下 —— localStorage 里的东西不可信
      editorFontSize: clamp(
        typeof parsed.editorFontSize === 'number' ? parsed.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
        MIN_FONT_SIZE,
        MAX_FONT_SIZE,
      ),
      largeFileThreshold: clampLargeFileThreshold(
        typeof parsed.largeFileThreshold === 'number'
          ? parsed.largeFileThreshold
          : DEFAULT_SETTINGS.largeFileThreshold,
      ),
      claudeContextMaxKb: clampClaudeContextMaxKb(
        typeof parsed.claudeContextMaxKb === 'number'
          ? parsed.claudeContextMaxKb
          : DEFAULT_SETTINGS.claudeContextMaxKb,
      ),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage 写不进去（隐私模式？）—— 设置记不住而已，不影响使用
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
