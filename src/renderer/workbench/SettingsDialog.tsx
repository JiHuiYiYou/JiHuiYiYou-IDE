import { useEffect, useRef, useState } from 'react'
import {
  clampClaudeContextMaxKb,
  clampLargeFileThreshold,
  MAX_CLAUDE_CONTEXT_MAX_KB,
  MAX_LARGE_FILE_THRESHOLD,
  MIN_CLAUDE_CONTEXT_MAX_KB,
  MIN_LARGE_FILE_THRESHOLD,
} from '../editor/largeFile'
import { DEFAULT_SETTINGS, type Settings } from '../state/settings'
import { Icon } from './icons'

interface Props {
  open: boolean
  settings: Settings
  /** 改了就**立刻生效**（VS Code 的设置也是这样的） */
  onChange: (settings: Settings) => void
  onClose: () => void
}

/** 常用字体（点一下就填进去）。 */
const FONT_PRESETS = [
  { label: 'MV Boli', value: "'MV Boli', 'Cascadia Mono', Consolas, monospace" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono', Consolas, 'JetBrains Mono', monospace" },
  { label: 'Consolas', value: "Consolas, 'Cascadia Mono', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', Consolas, monospace" },
  { label: '系统等宽', value: 'monospace' },
]

/**
 * **设置** —— 编辑区的字体/字号。
 *
 * ⚠️ **改了就立刻生效**（VS Code 的设置也是这样）—— 不点「确定」，
 *    边改边看效果 ⇒ 字号这种东西光靠数字看不出来 ✓
 */
export default function SettingsDialog({ open, settings, onChange, onClose }: Props) {
  const [family, setFamily] = useState(settings.editorFontFamily)
  const [size, setSize] = useState(String(settings.editorFontSize))
  const [largeThreshold, setLargeThreshold] = useState(String(settings.largeFileThreshold))
  const [claudeKb, setClaudeKb] = useState(String(settings.claudeContextMaxKb))
  const familyRef = useRef<HTMLInputElement>(null)

  // 打开时把当前值灌进输入框（设置可能在外面改过）
  useEffect(() => {
    if (!open) return
    setFamily(settings.editorFontFamily)
    setSize(String(settings.editorFontSize))
    setLargeThreshold(String(settings.largeFileThreshold))
    setClaudeKb(String(settings.claudeContextMaxKb))
    requestAnimationFrame(() => familyRef.current?.focus())
  }, [
    open,
    settings.editorFontFamily,
    settings.editorFontSize,
    settings.largeFileThreshold,
    settings.claudeContextMaxKb,
  ])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  /** 字号输入框里的值 ⇒ 合法就立刻应用。 */
  const applySize = (raw: string): void => {
    setSize(raw)
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    const clamped = Math.min(Math.max(Math.round(n), 8), 48)
    onChange({ ...settings, editorFontSize: clamped })
  }

  /** 大文件阈值输入框里的值 ⇒ 合法就立刻应用（夹到范围里）。 */
  const applyLargeThreshold = (raw: string): void => {
    setLargeThreshold(raw)
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onChange({ ...settings, largeFileThreshold: clampLargeFileThreshold(n) })
  }

  /** Claude 上下文上限输入框里的值 ⇒ 合法就立刻应用。 */
  const applyClaudeKb = (raw: string): void => {
    setClaudeKb(raw)
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onChange({ ...settings, claudeContextMaxKb: clampClaudeContextMaxKb(n) })
  }

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-dialog" role="dialog" aria-label="设置">
        <div className="settings-head">
          <span className="settings-title">设置</span>
          <button className="icon-button small" onClick={onClose} title="关闭">
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-row">
            <label className="settings-label" htmlFor="jhyy-setting-font">
              编辑区字体
            </label>
            <input
              id="jhyy-setting-font"
              className="settings-input"
              value={family}
              spellCheck={false}
              onChange={(e) => {
                setFamily(e.target.value)
                onChange({ ...settings, editorFontFamily: e.target.value })
              }}
              placeholder="'Cascadia Mono', Consolas, monospace"
            />
            <div className="settings-presets">
              {FONT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="settings-preset"
                  onClick={() => {
                    setFamily(p.value)
                    onChange({ ...settings, editorFontFamily: p.value })
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="jhyy-setting-size">
              编辑区字号
            </label>
            <input
              id="jhyy-setting-size"
              className="settings-input settings-input-narrow"
              type="number"
              min={8}
              max={48}
              step={1}
              value={size}
              onChange={(e) => applySize(e.target.value)}
            />
            <span className="settings-unit">px</span>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="jhyy-setting-large">
              大文件阈值
            </label>
            <input
              id="jhyy-setting-large"
              className="settings-input settings-input-narrow"
              type="number"
              min={MIN_LARGE_FILE_THRESHOLD / 1024}
              max={MAX_LARGE_FILE_THRESHOLD / 1024}
              step={64}
              value={Math.round(Number(largeThreshold) / 1024)}
              onChange={(e) => applyLargeThreshold(String(Number(e.target.value) * 1024))}
            />
            <span className="settings-unit">KB</span>
            <div className="settings-hint">
              超过这个大小的文件会进「大文件模式」：自动关掉后台实时检查、拖块视图，
              以及把整份源码送进 Claude。
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="jhyy-setting-claude">
              送给 Claude 的源码上限
            </label>
            <input
              id="jhyy-setting-claude"
              className="settings-input settings-input-narrow"
              type="number"
              min={MIN_CLAUDE_CONTEXT_MAX_KB}
              max={MAX_CLAUDE_CONTEXT_MAX_KB}
              step={16}
              value={claudeKb}
              onChange={(e) => applyClaudeKb(e.target.value)}
            />
            <span className="settings-unit">KB</span>
            <div className="settings-hint">
              超过这个大小就只把路径报给 Claude，让它自己读磁盘上的文件。
            </div>
          </div>

          <div className="settings-row">
            <button
              className="settings-reset"
              onClick={() => {
                setFamily(DEFAULT_SETTINGS.editorFontFamily)
                setSize(String(DEFAULT_SETTINGS.editorFontSize))
                onChange({ ...DEFAULT_SETTINGS })
              }}
            >
              恢复默认
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
