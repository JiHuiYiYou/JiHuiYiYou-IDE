import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './icons'

interface Props {
  children: ReactNode
  /** 出错时显示的标题 */
  label: string
  /** 「重来一次」按钮 —— 通常是换一个 key 把子组件整个重建 */
  onRetry?: () => void
}

interface State {
  error: Error | null
}

/**
 * 错误边界。
 *
 * Blockly 偶尔会抛（最常见的是
 * "The block associated with the block move event could not be found"）——
 * 没有边界的话，一个块视图的异常会把**整个应用**炸掉（React 卸载整棵树）。
 * 有了边界，最坏情况只是块视图变成一个「出错了，重来一次」的卡片。
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="error-boundary">
        <div className="error-boundary-icon">
          <Icon name="warning" size={22} />
        </div>
        <div className="error-boundary-title">{this.props.label}出错了</div>
        <pre className="error-boundary-message">{error.message}</pre>
        {this.props.onRetry && (
          <button className="primary" onClick={this.retry}>
            重来一次
          </button>
        )}
      </div>
    )
  }
}
