import { useEffect, useMemo, useRef, useState } from 'react'
import { displayChord, fuzzyScore, type Command } from '../commands/types'
import { Icon } from './icons'

interface Props {
  open: boolean
  commands: Command[]
  onClose: () => void
  /** 预填的查询串（命令中心点开时可以带上） */
  initialQuery?: string
}

const MAX_RESULTS = 50

/**
 * 命令面板 —— VS Code 的 `Ctrl+Shift+P`。
 *
 * 每一行显示两行：**本地化标题** + **英文原文**（像 VS Code 那样），
 * 右边是快捷键（从命令表派生）。
 */
export default function CommandPalette({ open, commands, onClose, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 打开之前的焦点 —— 关掉的时候还回去 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    setQuery(initialQuery ?? '')
    setIndex(0)
    // 下一帧再聚焦 —— 元素这会儿还没挂上
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, initialQuery])

  const results = useMemo(() => {
    const scored = commands
      .map((c) => {
        const haystack = `${c.category ?? ''} ${c.title} ${c.titleEn ?? ''}`
        const score = fuzzyScore(query, haystack)
        return { cmd: c, score }
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
    return scored.map((r) => r.cmd)
  }, [commands, query])

  // 查询变了 → 选中项重置到第一条
  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const run = (cmd: Command | undefined) => {
    if (!cmd) return
    onClose()
    void cmd.run()
  }

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette">
        <div className="palette-input-row">
          <Icon name="search" className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="输入命令…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(results[index])
              }
            }}
          />
        </div>
        <div className="palette-results">
          {results.length === 0 ? (
            <div className="palette-empty">没有匹配的命令</div>
          ) : (
            results.map((cmd, i) => (
              <div
                key={cmd.id}
                className={i === index ? 'palette-row active' : 'palette-row'}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(cmd)}
              >
                <div className="palette-row-text">
                  <div className="palette-row-title">
                    {cmd.category ? `${cmd.category}: ` : ''}
                    {cmd.title}
                  </div>
                  {cmd.titleEn && <div className="palette-row-sub">{cmd.titleEn}</div>}
                </div>
                {cmd.keybinding && (
                  <span className="palette-key">{displayChord(cmd.keybinding)}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
