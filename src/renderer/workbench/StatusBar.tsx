import type { Diagnostic, ToolchainInfo } from '@shared/jhyy'
import { Icon, type IconName } from './icons'

export interface StatusMessage {
  text: string
  kind: 'ok' | 'bad' | 'info'
}

interface Props {
  /** 光标位置（1-based 行列） */
  cursor: { line: number; col: number; selectedLines: number }
  diagnostics: Diagnostic[]
  toolchain: ToolchainInfo | null
  /** 临时状态消息（编译/运行的结果） */
  message: StatusMessage | undefined
  /** 视图是代码还是块 —— 块视图时「Ln/Col」没意义 */
  view: 'code' | 'blocks'
  blocksStale: boolean
}

/**
 * 状态栏 —— VS Code 最底下那一行。
 *
 * 左边：位置 / 缩进 / 编码 / 语言 / 选中行数
 * 右边：错误警告数 / 编译器状态 / 临时消息
 */
export default function StatusBar({ cursor, diagnostics, toolchain, message, view, blocksStale }: Props) {
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
        {blocksStale && <span className="status-item warn">块视图已过期</span>}
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
        {message && (
          <span className={`status-item message ${message.kind}`}>
            <Icon name={statusIconOf(message.kind)} size={12} />
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}

function statusIconOf(kind: 'ok' | 'bad' | 'info'): IconName {
  if (kind === 'ok') return 'check'
  if (kind === 'bad') return 'error'
  return 'info'
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
