import type { Diagnostic, ToolchainInfo } from '@shared/jhyy'
import type { PtyBackendInfo } from '@shared/terminal'
import { Icon } from './icons'

export interface StatusMessage {
  text: string
  /**
   * ⚠️ **只能是 `'bad'`** —— 状态栏**只放出错的消息**。
   *
   * ⚠️⚠️ **为什么把类型限死** —— 用户明说：
   *    「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   *    ⇒ 「运行中…」「退出码 42」「已保存…」「降级运行…」**都不该出现在这儿** ✓
   *    ⇒ **类型限死 ⇒ 编译器替你把关** ✓✓
   */
  kind: 'bad'
}

interface Props {
  /** 光标位置（1-based 行列） */
  cursor: { line: number; col: number; selectedLines: number }
  diagnostics: Diagnostic[]
  toolchain: ToolchainInfo | null
  /**
   * 终端后端（真控制台 / 管道兜底）。
   *
   * ⚠️ **这个徽章是给用户看的** —— node-pty 起不来时会退到管道版，
   *    而用户**看不出来**（终端照样能用，只是没有真 TTY）⇒
   *    用户报过「终端一会真一会假的」⇒ 得**看得见**才说得清 ✓。
   */
  ptyBackend: PtyBackendInfo | null
  /**
   * 临时消息 —— ⚠️ **只放「出错」的**。
   *
   * ⚠️⚠️ **程序行为不放这儿** —— 用户明说：
   *    「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
   *    ⇒ 「运行中…」「退出码 42」「降级运行…」「已保存…」**全都不显示** ✓
   */
  message: StatusMessage | undefined
  /** 视图是代码还是块 —— 块视图时「Ln/Col」没意义 */
  view: 'code' | 'blocks'
}

/**
 * 状态栏 —— VS Code 最底下那一行。
 *
 * 左边：位置 / 缩进 / 编码 / 语言 / 选中行数
 * 右边：错误警告数 / 编译器状态 / **PTY 徽章** / **出错消息**
 *
 * ⚠️⚠️ **程序行为（运行中…/退出码/降级提示/已保存…）不显示** ——
 *    用户明说：「右下角的状态栏戏太多了，人家用户根本就不需要知道程序行为」✗
 *    ⇒ **运行状态在终端页签上**（转圈 / ✓ / ✗，VS Code 的 task 页签一样）✓
 *    ⇒ 编译诊断在**问题面板**里 ✓
 */
export default function StatusBar({
  cursor,
  diagnostics,
  toolchain,
  ptyBackend,
  message,
  view,
}: Props) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  const toolchainOk = toolchain?.available ?? false

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-item status-brand">
          <span className="logo-mark small">◈</span>
          JHYY
        </span>
        {view === 'code' ? (
          <>
            <span className="status-item">Ln {cursor.line}, Col {cursor.col}</span>
            <span className="status-item">空格: 4</span>
            <span className="status-item">UTF-8</span>
            <span className="status-item">JHY</span>
            {cursor.selectedLines > 0 && (
              <span className="status-item">Ln {cursor.selectedLines}</span>
            )}
          </>
        ) : (
          <span className="status-item">拖块视图</span>
        )}
      </div>

      <div className="status-right">
        {errors > 0 && (
          <span className="status-item error">
            <Icon name="error" size={12} /> {errors}
          </span>
        )}
        {warnings > 0 && (
          <span className="status-item warn">
            <Icon name="warning" size={12} /> {warnings}
          </span>
        )}
        <span
          className={toolchainOk ? 'status-item ok' : 'status-item error'}
          title={toolchain?.exePath ?? '找不到 jhyy 编译器'}
        >
          <Icon name={toolchainOk ? 'check' : 'error'} size={12} />
          {toolchain ? (toolchainOk ? shortenVersion(toolchain.versionText) : '找不到编译器') : '探测中…'}
        </span>
        {ptyBackend && (
          <span
            className={ptyBackend.backend === 'node-pty' ? 'status-item ok' : 'status-item warn'}
            title={
              ptyBackend.backend === 'node-pty'
                ? '终端跑在真控制台（ConPTY）上：TUI 程序能跑、窗口尺寸实时对得上、程序提示立刻可见'
                : `终端跑在管道上（不是真控制台）：${ptyBackend.reason ?? '未知原因'}\n` +
                  '跑一次 npm install，让 postinstall 把 node-pty 按 Electron 的 ABI 编出来'
            }
          >
            <Icon name={ptyBackend.backend === 'node-pty' ? 'check' : 'warning'} size={12} />
            {ptyBackend.backend === 'node-pty' ? 'PTY' : '管道'}
          </span>
        )}
        {message && (
          <span className={`status-item message ${message.kind}`}>
            <Icon name="error" size={12} />
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 编译器的版本文本往往很长
 * （"jhyy compiler v2.5.0 (self-hosted, v2.0 series)"）——
 * 状态栏只留第一段，完整内容放 title 里。
 */
function shortenVersion(text: string | undefined): string {
  if (!text) return '编译器就绪'
  const first = text.split('\n')[0].trim()
  const short = first.replace(/^jhyy\s+compiler\s+/i, '')
  return short.length > 28 ? `${short.slice(0, 27)}…` : short
}
