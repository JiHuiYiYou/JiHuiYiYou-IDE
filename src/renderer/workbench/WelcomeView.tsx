interface Props {
  onOpen: () => void
  onNew: () => void
}

/**
 * 没打开文件时的欢迎页 —— 抄 VS Code 的 Welcome。
 *
 * 之前没打开文件时编辑器里躺着一段示例代码（WELCOME 模板），
 * 那看着像「有个文件被打开了」—— 其实是假的。空编辑器 + 欢迎页更清楚。
 */
export default function WelcomeView({ onOpen, onNew }: Props) {
  return (
    <div className="welcome-view">
      <div className="welcome-card">
        <div className="welcome-logo">◈</div>
        <h1 className="welcome-title">JHYY IDE</h1>
        <p className="welcome-sub">给 JHYY（机会翼游）做的桌面 IDE</p>

        <div className="welcome-actions">
          <button className="primary" onClick={onOpen}>
            打开文件… <kbd>Ctrl+O</kbd>
          </button>
          <button onClick={onNew}>
            新建文件 <kbd>Ctrl+N</kbd>
          </button>
        </div>

        <ul className="welcome-list">
          <li>
            <b>拖块编程</b> —— 点标题栏的 <span className="welcome-icon">🧩</span> 切到拖块视图
            （独占整个编辑区，<kbd>Ctrl+Shift+B</kbd>）
          </li>
          <li>
            <b>终端</b> —— 底部面板的「终端」页签（<kbd>Ctrl+`</kbd>）
          </li>
          <li>
            <b>Claude Code</b> —— 右侧栏（<kbd>Ctrl+Alt+I</kbd>）
          </li>
          <li>
            <b>命令面板</b> —— 所有命令都在这儿（<kbd>Ctrl+Shift+P</kbd>）
          </li>
        </ul>
      </div>
    </div>
  )
}
