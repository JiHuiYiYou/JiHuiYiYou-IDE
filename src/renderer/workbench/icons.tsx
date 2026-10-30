/**
 * 标题栏 / 面板 / 标签条用的图标。
 *
 * 16×16 的线框风格（跟 VS Code 的 codicon 一个调子）。
 * 全部用 `currentColor` —— 颜色跟着所在容器的 `color` 走。
 */
export type IconName =
  | 'blocks'
  | 'chat'
  | 'sidebar-left'
  | 'sidebar-right'
  | 'panel-bottom'
  | 'play'
  | 'split'
  | 'more'
  | 'close'
  | 'trash'
  | 'maximize'
  | 'restore'
  | 'chevron-down'
  | 'chevron-right'
  | 'search'
  | 'check'
  | 'error'
  | 'warning'
  | 'info'
  | 'plus'
  | 'file'
  | 'terminal'
  | 'history'
  | 'send'
  | 'stop'
  | 'layout'
  | 'settings'
  | 'attach'

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

const PATHS: Record<IconName, React.ReactNode> = {
  // 四块拼图 —— 代表「拖块」
  blocks: (
    <>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
      <path d="M9 9h5.5v5.5H9z" />
    </>
  ),
  // 对话气泡
  chat: <path d="M14 7.5a2.5 2.5 0 0 1-2.5 2.5H7l-3.5 3v-3H4.5A2.5 2.5 0 0 1 2 7.5v-4A2.5 2.5 0 0 1 4.5 1H11.5A2.5 2.5 0 0 1 14 3.5z" />,
  'sidebar-left': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
      <path d="M2.5 3.5h2.5v9H2.5z" fill="currentColor" stroke="none" />
    </>
  ),
  'sidebar-right': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
      <path d="M11 3.5h2.5v9H11z" fill="currentColor" stroke="none" />
    </>
  ),
  'panel-bottom': (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 10h13" />
      <path d="M2.5 11h11v1.5h-11z" fill="currentColor" stroke="none" />
    </>
  ),
  // 播放三角形
  play: <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" stroke="none" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />,
  // 两个并排的面板
  split: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </>
  ),
  more: (
    <>
      <circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  trash: (
    <>
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M3.5 4l.7 9.5h7.6L12.5 4" />
      <path d="M6.5 6.5v5M9.5 6.5v5" />
    </>
  ),
  maximize: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M2 6h12" />
    </>
  ),
  restore: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M2 10h12" />
    </>
  ),
  'chevron-down': <path d="M3.5 6l4.5 4.5L12.5 6" />,
  'chevron-right': <path d="M6 3.5l4.5 4.5L6 12.5" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  check: <path d="M2.5 8.5l3.5 3.5 7.5-8" />,
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.5L15 14H1z" />
      <path d="M8 6v4M8 11.5v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7v4M8 4.5v.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  file: (
    <>
      <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z" />
      <path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" />
    </>
  ),
  terminal: (
    <>
      <path d="M2.5 3l4 4-4 4" />
      <path d="M8 12h5.5" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
      <path d="M2 2v3.5h3.5" />
      <path d="M8 5.5V8l2 1.5" />
    </>
  ),
  send: (
    <>
      <path d="M8 13V3" />
      <path d="M3.5 7.5L8 3l4.5 4.5" />
    </>
  ),
  layout: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M5.5 2.5v11M5.5 10h9" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </>
  ),
  attach: (
    <>
      <path d="M11 5.5L6.2 10.3a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.2-4.2l-5 5" />
    </>
  ),
}
