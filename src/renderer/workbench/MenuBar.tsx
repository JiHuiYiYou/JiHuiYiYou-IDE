import { useEffect, useRef, useState } from 'react'
import { displayChord, findCommand, type Command, type MenuItem, type MenuSpec } from '../commands/types'

interface Props {
  menus: MenuSpec[]
  commands: Command[]
  onRun: (cmd: Command) => void
}

/**
 * 标题栏上的菜单栏 —— 六个下拉。
 *
 * ⚠️ 原生 Electron 菜单**不能**用：`titleBarStyle: 'hidden'` 把菜单栏藏了，
 * 而且它的 accelerator 会在渲染进程看到按键之前就被吃掉
 * （所以主进程还调了 `Menu.setApplicationMenu(null)`）。
 * 菜单只能自己在渲染进程里画。
 *
 * 交互跟 VS Code 一致：点开一个之后，**悬停**到别的菜单就切过去；
 * 点外面 / 按 Esc 关闭。
 */
export default function MenuBar({ menus, commands, onRun }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openId) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [openId])

  return (
    <div className="menu-bar" ref={rootRef}>
      {menus.map((menu) => (
        <div
          key={menu.id}
          className={openId === menu.id ? 'menu-trigger open' : 'menu-trigger'}
          onClick={() => setOpenId(openId === menu.id ? null : menu.id)}
          onMouseEnter={() => {
            // 已经有一个菜单开着时，悬停就切过去（VS Code 的行为）
            if (openId) setOpenId(menu.id)
          }}
        >
          <span className="menu-trigger-label">{menu.label}</span>
          {openId === menu.id && (
            <MenuDropdown
              items={menu.items}
              commands={commands}
              onRun={onRun}
              onClose={() => setOpenId(null)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function MenuDropdown({
  items,
  commands,
  onRun,
  onClose,
}: {
  items: MenuItem[]
  commands: Command[]
  onRun: (cmd: Command) => void
  onClose: () => void
}) {
  return (
    <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
      {items.map((item, i) => {
        // ⚠️ 分隔线是「**空字符串**标签」，不是「没有标签」——
        // 只写了 `commandId` 的菜单项（标签从命令表里取）不能被当成分隔线。
        if (item.label === '') {
          return <div key={`sep-${i}`} className="menu-separator" />
        }
        const cmd = item.commandId ? findCommand(commands, item.commandId) : undefined
        const label = item.label ?? cmd?.title ?? ''
        if (!label) return null
        const enabled = item.enabled ? item.enabled() : (cmd?.enabled?.() ?? true)
        const checked = item.checked ? item.checked() : cmd?.checked?.()
        return (
          <button
            key={(item.label ?? cmd?.id ?? '') + i}
            className="menu-item"
            disabled={!enabled}
            onClick={() => {
              if (!enabled) return
              onClose()
              if (item.run) item.run()
              else if (cmd) onRun(cmd)
            }}
          >
            <span className="menu-item-check">{checked ? '✓' : ''}</span>
            <span className="menu-item-label">{label}</span>
            <span className="menu-item-key">
              {cmd?.keybinding ? displayChord(cmd.keybinding) : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}
