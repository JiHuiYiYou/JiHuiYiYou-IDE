import type { CodePaneHandle } from '../panes/CodePane'
import type { EditorCommand } from '../editor/editorCommands'
import type { PanelTab } from '../state/layout'
import type { Command, MenuSpec } from './types'

/**
 * 命令表需要的上下文。
 *
 * 全部是**取值函数**而不是值 —— 这样命令表建一次就能一直用，
 * 每次执行时读到的都是最新的状态（不用 useMemo 的一堆依赖）。
 */
export interface CommandContext {
  // ── 文件 ──────────────────────────────────────────────────
  newFile(): void
  openFile(): void
  saveFile(): void
  saveAs(): void
  closeFile(): void

  // ── 编译 / 运行 ───────────────────────────────────────────
  compile(): void
  run(): void
  stop(): void

  // ── 视图 ──────────────────────────────────────────────────
  showCommandPalette(): void
  toggleBlocks(): void
  togglePanel(): void
  showPanelTab(tab: PanelTab): void
  toggleSidebar(): void
  toggleStatusBar(): void

  // ── 编辑器 ────────────────────────────────────────────────
  /** 拿到编辑器（可能没有 —— 比如当前显示的是拖块） */
  editor(): CodePaneHandle | null

  // ── 状态（用来决定菜单项灰不灰、勾不勾） ──────────────────
  hasFile(): boolean
  isBusy(): boolean
  isBlocksView(): boolean
  isPanelOpen(): boolean
  isSidebarOpen(): boolean
  /** 面板当前停在哪个页签（没展开时是 null） */
  activePanelTab(): PanelTab | null
}

/**
 * 建命令表。
 *
 * ⚠️ 参数是**活的**上下文（一个 ref）—— 命令表建一次就一直用，
 * 每次执行时读到的都是最新状态。这样 `useMemo` 不用挂一堆依赖，
 * 闭包也不会捕获到过期的 state。
 *
 * ⚠️ 快捷键的**优先级**：注册表和匹配器共用 `chordOf` 的规范化格式，
 * 这里写 "Ctrl+Shift+P"、匹配器也认 "Ctrl+Shift+P" —— 顺序必须一致。
 *
 * ⚠️ **哪些键 CodeMirror 已经占了**（别抢）：
 * - `standardKeymap`：Mod-a（全选）、Mod-z（撤销）、Mod-y（重做）、Mod-[/]…
 * - `searchKeymap`：Mod-f（查找）、F3、Mod-g、Shift-F3、Mod-d
 * - `historyKeymap`：Mod-z、Mod-y、Mod-Shift-z
 * ⇒ 下面的 "Ctrl+S"、"Ctrl+G"、"Ctrl+Shift+B"、"Ctrl+Shift+M/U"、"Ctrl+`"、"F5"
 *    都是**空闲**的。
 */
export function createCommands(ctx: { current: CommandContext }): Command[] {
  /** 编辑器命令 —— 只有编辑器有焦点时才该接管（scope: 'editor'）。 */
  const editorCmd = (
    id: string,
    title: string,
    titleEn: string,
    keybinding: string | undefined,
    cmd: EditorCommand,
  ): Command => ({
    id,
    title,
    titleEn,
    category: '编辑',
    keybinding,
    scope: 'editor',
    run: () => {
      ctx.current.editor()?.exec(cmd)
    },
  })

  return [
    // ── 文件 ──────────────────────────────────────────────────
    {
      id: 'file.new',
      title: '新建文件',
      titleEn: 'File: New File',
      category: '文件',
      keybinding: 'Ctrl+N',
      run: () => ctx.current.newFile(),
    },
    {
      id: 'file.open',
      title: '打开文件…',
      titleEn: 'File: Open File...',
      category: '文件',
      keybinding: 'Ctrl+O',
      run: () => ctx.current.openFile(),
    },
    {
      id: 'file.save',
      title: '保存',
      titleEn: 'File: Save',
      category: '文件',
      keybinding: 'Ctrl+S',
      run: () => ctx.current.saveFile(),
      enabled: () => ctx.current.hasFile(),
    },
    {
      id: 'file.saveAs',
      title: '另存为…',
      titleEn: 'File: Save As...',
      category: '文件',
      keybinding: 'Ctrl+Shift+S',
      run: () => ctx.current.saveAs(),
    },
    {
      id: 'file.close',
      title: '关闭文件',
      titleEn: 'File: Close File',
      category: '文件',
      run: () => ctx.current.closeFile(),
      enabled: () => ctx.current.hasFile(),
    },

    // ── 编译 / 运行 ───────────────────────────────────────────
    {
      id: 'build.check',
      title: '检查',
      titleEn: 'JHYY: Check',
      category: 'JHYY',
      keybinding: 'Ctrl+Shift+D',
      run: () => ctx.current.compile(),
      enabled: () => ctx.current.hasFile() && !ctx.current.isBusy(),
    },
    {
      id: 'build.run',
      title: '运行',
      titleEn: 'JHYY: Run',
      category: 'JHYY',
      keybinding: 'F5',
      run: () => ctx.current.run(),
      enabled: () => ctx.current.hasFile() && !ctx.current.isBusy(),
    },
    {
      id: 'build.stop',
      title: '停止',
      titleEn: 'JHYY: Stop',
      category: 'JHYY',
      keybinding: 'Shift+F5',
      run: () => ctx.current.stop(),
      enabled: () => ctx.current.isBusy(),
    },

    // ── 视图 ──────────────────────────────────────────────────
    {
      id: 'view.commandPalette',
      title: '命令面板…',
      titleEn: 'View: Command Palette...',
      category: '查看',
      keybinding: 'Ctrl+Shift+P',
      run: () => ctx.current.showCommandPalette(),
    },
    {
      id: 'view.toggleBlocks',
      title: '切换块视图 / 文本视图',
      titleEn: 'JHYY: Toggle Block View',
      category: '查看',
      keybinding: 'Ctrl+Shift+B',
      run: () => ctx.current.toggleBlocks(),
    },
    {
      id: 'view.togglePanel',
      title: '显示/隐藏 底部面板',
      titleEn: 'View: Toggle Panel',
      category: '查看',
      keybinding: 'Ctrl+J',
      run: () => ctx.current.togglePanel(),
      checked: () => ctx.current.isPanelOpen(),
    },
    {
      id: 'view.problems',
      title: '问题',
      titleEn: 'View: Problems',
      category: '查看',
      keybinding: 'Ctrl+Shift+M',
      run: () => ctx.current.showPanelTab('problems'),
      checked: () => ctx.current.activePanelTab() === 'problems',
    },
    {
      id: 'view.output',
      title: '输出',
      titleEn: 'View: Output',
      category: '查看',
      keybinding: 'Ctrl+Shift+U',
      run: () => ctx.current.showPanelTab('output'),
      checked: () => ctx.current.activePanelTab() === 'output',
    },
    {
      id: 'view.terminal',
      title: '终端',
      titleEn: 'View: Terminal',
      category: '查看',
      keybinding: 'Ctrl+Backquote',
      run: () => ctx.current.showPanelTab('terminal'),
      checked: () => ctx.current.activePanelTab() === 'terminal',
    },
    {
      id: 'view.toggleSidebar',
      title: '显示/隐藏 聊天侧栏',
      titleEn: 'View: Toggle Secondary Side Bar',
      category: '查看',
      keybinding: 'Ctrl+Alt+B',
      run: () => ctx.current.toggleSidebar(),
      checked: () => ctx.current.isSidebarOpen(),
    },
    {
      id: 'view.focusChat',
      title: '聚焦聊天',
      titleEn: 'View: Focus Chat',
      category: '查看',
      keybinding: 'Ctrl+Alt+I',
      run: () => ctx.current.toggleSidebar(),
    },
    {
      id: 'view.toggleStatusBar',
      title: '显示/隐藏 状态栏',
      titleEn: 'View: Toggle Status Bar',
      category: '查看',
      run: () => ctx.current.toggleStatusBar(),
    },

    // ── 编辑 ──────────────────────────────────────────────────
    editorCmd('edit.undo', '撤销', 'Edit: Undo', 'Ctrl+Z', 'undo'),
    editorCmd('edit.redo', '重做', 'Edit: Redo', 'Ctrl+Y', 'redo'),
    editorCmd('edit.cut', '剪切', 'Edit: Cut', 'Ctrl+X', 'cut'),
    editorCmd('edit.copy', '复制', 'Edit: Copy', 'Ctrl+C', 'copy'),
    editorCmd('edit.paste', '粘贴', 'Edit: Paste', 'Ctrl+V', 'paste'),
    editorCmd('edit.find', '查找', 'Edit: Find', 'Ctrl+F', 'find'),
    editorCmd('edit.replace', '替换', 'Edit: Replace', 'Ctrl+H', 'replace'),
    editorCmd('edit.gotoLine', '转到行/列…', 'Edit: Go to Line/Column...', 'Ctrl+G', 'gotoLine'),
    editorCmd('edit.toggleComment', '切换行注释', 'Edit: Toggle Line Comment', undefined, 'toggleLineComment'),
    editorCmd('edit.indentMore', '增加缩进', 'Edit: Indent Line', undefined, 'indentMore'),
    editorCmd('edit.indentLess', '减少缩进', 'Edit: Outdent Line', undefined, 'indentLess'),
    editorCmd('edit.deleteLine', '删除行', 'Edit: Delete Line', 'Ctrl+Shift+K', 'deleteLine'),

    // ── 选择 ──────────────────────────────────────────────────
    editorCmd('select.all', '全选', 'Select: All', 'Ctrl+A', 'selectAll'),
    editorCmd(
      'select.nextOccurrence',
      '选中下一处相同项',
      'Select: Next Occurrence',
      'Ctrl+D',
      'selectNextOccurrence',
    ),
    editorCmd('select.addCursorBelow', '在下面添加光标', 'Select: Add Cursor Below', 'Ctrl+Alt+Down', 'addCursorBelow'),
    editorCmd('select.addCursorAbove', '在上面添加光标', 'Select: Add Cursor Above', 'Ctrl+Alt+Up', 'addCursorAbove'),
    editorCmd(
      'select.matchingBracket',
      '匹配括号',
      'Select: Select Matching Bracket',
      undefined,
      'selectMatchingBracket',
    ),
  ]
}

/**
 * 标题栏的菜单栏 —— 六个下拉，跟 VS Code 的「文件/编辑/选择/查看//goto」对齐。
 *
 * 菜单项指向命令表里的命令（`commandId`），快捷键提示从那儿派生。
 */
export function createMenus(): MenuSpec[] {
  return [
    {
      id: 'file',
      label: '文件',
      items: [
        { commandId: 'file.new' },
        { commandId: 'file.open' },
        { label: '' },
        { commandId: 'file.save' },
        { commandId: 'file.saveAs' },
        { commandId: 'file.close' },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { commandId: 'edit.undo' },
        { commandId: 'edit.redo' },
        { label: '' },
        { commandId: 'edit.cut' },
        { commandId: 'edit.copy' },
        { commandId: 'edit.paste' },
        { label: '' },
        { commandId: 'edit.find' },
        { commandId: 'edit.replace' },
        { commandId: 'edit.gotoLine' },
        { label: '' },
        { commandId: 'edit.toggleComment' },
        { commandId: 'edit.indentMore' },
        { commandId: 'edit.indentLess' },
        { commandId: 'edit.deleteLine' },
      ],
    },
    {
      id: 'select',
      label: '选择',
      items: [
        { commandId: 'select.all' },
        { label: '' },
        { commandId: 'select.nextOccurrence' },
        { commandId: 'select.addCursorBelow' },
        { commandId: 'select.addCursorAbove' },
        { commandId: 'select.matchingBracket' },
      ],
    },
    {
      id: 'view',
      label: '查看',
      items: [
        { commandId: 'view.commandPalette' },
        { label: '' },
        { commandId: 'view.toggleBlocks' },
        { commandId: 'view.togglePanel' },
        { commandId: 'view.toggleSidebar' },
        { commandId: 'view.toggleStatusBar' },
        { label: '' },
        { commandId: 'view.problems' },
        { commandId: 'view.output' },
        { commandId: 'view.terminal' },
      ],
    },
    {
      id: 'go',
      label: '转到',
      items: [
        { commandId: 'edit.gotoLine' },
        { label: '' },
        { commandId: 'view.toggleBlocks' },
      ],
    },
  ]
}
