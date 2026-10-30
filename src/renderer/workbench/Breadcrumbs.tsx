import { Icon } from './icons'

interface Props {
  filePath: string | null
  /** 当前是代码视图还是块视图 */
  view: 'code' | 'blocks'
}

/**
 * 面包屑 —— VS Code 在编辑器和标签条之间那一行。
 *
 * 显示文件路径的每一段 + 最后的文件名。代码视图显示路径；
 * 块视图显示「拖块」和一个提示。
 */
export default function Breadcrumbs({ filePath, view }: Props) {
  if (view === 'blocks') {
    return (
      <div className="breadcrumbs">
        <span className="crumb">
          <Icon name="blocks" size={13} />
        </span>
        <span className="crumb-sep">›</span>
        <span className="crumb current">拖块视图</span>
        <span className="crumb-hint">改块 → 文本视图会跟着更新</span>
      </div>
    )
  }

  const parts = filePath ? filePath.split(/[\\/]/).filter(Boolean) : []

  // 没打开文件时**什么都不显示** —— 欢迎页已经把话说完了，
  // 再写一遍「未打开文件」是重复。
  if (parts.length === 0) return <div className="breadcrumbs" />

  return (
    <div className="breadcrumbs">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="crumb-part">
          {i > 0 && <span className="crumb-sep">›</span>}
          <span className={i === parts.length - 1 ? 'crumb current' : 'crumb'}>{p}</span>
        </span>
      ))}
    </div>
  )
}
