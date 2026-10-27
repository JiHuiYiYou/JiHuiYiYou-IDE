import * as Blockly from 'blockly/core'
import type { BlockTree } from '@lang/blocks/tree'
import { useEffect, useRef } from 'react'
import { treeToWorkspace, workspaceToTree } from '../blocks/adapter'
import { buildToolbox, DARK_THEME, defineJhyyBlocks } from '../blocks/definitions'

interface Props {
  /** 块树（从文本视图同步过来的） */
  tree: BlockTree[]
  /** 用户在块视图里改了 → 通知外面 */
  onChange?: (tree: BlockTree[]) => void
}

/** 块视图 —— Blockly 工作区。 */
export default function BlockPane({ tree, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null)
  /** 正在重建工作区 —— 抑制 change 回调（避免自激循环） */
  const rebuildingRef = useRef(false)
  /**
   * 上一次**发出去**的块树（序列化后的字符串）。
   *
   * 光靠 `rebuildingRef` 挡不住循环：Blockly 的渲染是**异步**的
   * （queueRender 排到下一帧），重建工作区之后还会冒出 BLOCK_MOVE 之类的事件 ——
   * 那时重建标记早就放掉了 → "块改动 → 重建 → 又算成改动" 的死循环。
   *
   * 改成**比对块树**：读回来的树跟上次发出去的一样就不通知。这样天然收敛，
   * 而用户真的改了块时一定会被发出去。
   */
  const lastEmittedRef = useRef<string>('')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // 建工作区（只建一次）
  useEffect(() => {
    if (!hostRef.current) return
    defineJhyyBlocks()

    const workspace = Blockly.inject(hostRef.current, {
      toolbox: buildToolbox(),
      trashcan: true,
      sounds: false,
      move: { scrollbars: true, drag: true, wheel: true },
      zoom: { controls: true, wheel: true, startScale: 0.9 },
      grid: { spacing: 22, length: 3, colour: '#2a2f3a', snap: true },
      renderer: 'geras',
      theme: DARK_THEME,
      // Blockly 的图标默认从 CDN 拉 —— 桌面应用不能依赖网络，
      // 这里指向本地提供的 media 目录（见 electron.vite.config.ts 的 blocklyMedia 插件）
      media: './blockly-media/',
    })
    workspaceRef.current = workspace
    // 挂到 window 上，方便在 DevTools 里调试
    ;(window as unknown as { Blockly?: typeof Blockly }).Blockly = Blockly

    const onWorkspaceChange = (event: Blockly.Events.Abstract) => {
      if (rebuildingRef.current) return
      if (
        event.type !== Blockly.Events.BLOCK_CREATE &&
        event.type !== Blockly.Events.BLOCK_DELETE &&
        event.type !== Blockly.Events.BLOCK_MOVE &&
        event.type !== Blockly.Events.CHANGE
      ) {
        return
      }
      const current = workspaceToTree(workspace)
      const serialized = JSON.stringify(current)
      if (serialized === lastEmittedRef.current) return
      lastEmittedRef.current = serialized
      onChangeRef.current?.(current)
    }
    workspace.addChangeListener(onWorkspaceChange)

    return () => {
      workspace.removeChangeListener(onWorkspaceChange)
      workspace.dispose()
      workspaceRef.current = null
    }
  }, [])

  // 外部（文本视图）改了 → 重建工作区
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    rebuildingRef.current = true
    treeToWorkspace(workspace, tree)
    rebuildingRef.current = false
    // 记住这次的状态 —— 重建过程里冒出来的事件读回来的树跟它一样，
    // 就不会再通知出去（见 lastEmittedRef 的说明）
    lastEmittedRef.current = JSON.stringify(tree)
  }, [tree])

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
}
