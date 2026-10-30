/**
 * 布局状态 —— 哪些区域显示、显示多大。
 *
 * 存在 localStorage 里，重开窗口还是上次的样子（VS Code 就是这么做的）。
 */

/** 底部面板的页签。 */
export type PanelTab = 'problems' | 'output' | 'terminal'

/** 中心区当前显示什么（**互斥** —— 代码和拖块不同时显示）。 */
export type CenterView = 'code' | 'blocks'

export interface LayoutState {
  /** 底部面板是否展开（默认隐藏） */
  panelOpen: boolean
  panelTab: PanelTab
  /** 右侧聊天栏是否展开 */
  sidebarOpen: boolean
  statusBarVisible: boolean
  menuBarVisible: boolean
  /** 中心区显示代码还是拖块 */
  centerView: CenterView
  /** 底部面板高度（像素） */
  panelHeight: number
  /** 右侧栏宽度（像素） */
  sidebarWidth: number
}

export const DEFAULT_LAYOUT: LayoutState = {
  // ⚠️ 面板默认**隐藏** —— 只在点「检查」或「运行」时才弹出来。
  panelOpen: false,
  panelTab: 'output',
  sidebarOpen: true,
  statusBarVisible: true,
  menuBarVisible: true,
  centerView: 'code',
  panelHeight: 240,
  sidebarWidth: 380,
}

const STORAGE_KEY = 'jhyy-ide.layout.v1'

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LAYOUT }
    const parsed = JSON.parse(raw) as Partial<LayoutState>
    return {
      ...DEFAULT_LAYOUT,
      ...parsed,
      // ⚠️ 底部面板**每次启动都是收起的** —— 它是临时的：
      // 点「检查」/「运行」才弹出来。用完就收，不该记到下次启动。
      panelOpen: false,
      // 数值要夹一下 —— localStorage 里的东西不可信
      panelHeight: clamp(
        typeof parsed.panelHeight === 'number' ? parsed.panelHeight : DEFAULT_LAYOUT.panelHeight,
        120,
        900,
      ),
      sidebarWidth: clamp(
        typeof parsed.sidebarWidth === 'number' ? parsed.sidebarWidth : DEFAULT_LAYOUT.sidebarWidth,
        260,
        900,
      ),
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function saveLayout(state: LayoutState): void {
  try {
    // ⚠️ `panelOpen` **不存** —— 面板每次启动都该是收起的（见 loadLayout）。
    const { panelOpen: _ignored, ...rest } = state
    void _ignored
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
  } catch {
    // localStorage 写不进去（隐私模式？）—— 布局记不住而已，不影响使用
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
