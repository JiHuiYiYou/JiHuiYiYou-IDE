import * as Blockly from 'blockly/core'
import type { BlockTree } from '@lang/blocks/tree'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { canonicalTree } from '../blocks/canonical'
import { treeToWorkspace, workspaceToTree } from '../blocks/adapter'
import { buildToolbox, DARK_THEME, defineJhyyBlocks } from '../blocks/definitions'

interface Props {
  /** 块树（从文本视图同步过来的） */
  tree: BlockTree[]
  /** 用户在块视图里改了 → 通知外面 */
  onChange?: (tree: BlockTree[]) => void
}

/** 块视图对外暴露的能力。 */
export interface BlockPaneHandle {
  /** 容器尺寸变了之后强制 Blockly 重新量一次 */
  resize(): void
  focus(): void
  /** 当前块树 */
  getTree(): BlockTree[]
}

/**
 * 块视图 —— Blockly 工作区。
 *
 * ⚠️ **Blockly 13 没有 ResizeObserver** —— 它只在 `window` 的 `resize` 事件里
 * 重新量尺寸。所以**任何不改窗口大小的布局变化**（右侧聊天栏折叠、
 * 底部面板开合、代码↔块切换）都会让它的 `<svg>` 尺寸过期。
 * ⇒ 这里自己加一个 ResizeObserver，调 `Blockly.svgResize`。
 *
 * ⚠️ **别用 `display:none` 藏这个面板** —— `svgResize` 读的是容器的
 * `offsetWidth`，`display:none` 时是 0，SVG 会被设成 0×0 且缓存被污染。
 * 要藏就用 `visibility:hidden`（布局盒子还在，尺寸还是真的）。
 */
export default function BlockPane({ tree, onChange, ref }: Props & { ref?: Ref<BlockPaneHandle> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null)
  /** 正在重建工作区 —— 抑制 change 回调（避免自激循环） */
  const rebuildingRef = useRef(false)
  /**
   * 上一次**发出去**的块树（规范化后的字符串）。
   *
   * 光靠 `rebuildingRef` 挡不住循环：Blockly 的渲染是**异步**的
   * （queueRender 排到下一帧），重建工作区之后还会冒出 BLOCK_MOVE 之类的事件 ——
   * 那时重建标记早就放掉了 → "块改动 → 重建 → 又算成改动" 的死循环。
   *
   * 改成**比对块树**：读回来的树跟上次发出去的一样就不通知。这样天然收敛，
   * 而用户真的改了块时一定会被发出去。
   *
   * ⚠️ 必须用**规范化**的比较（`canonicalTree`），不能直接 `JSON.stringify` ——
   * 字段顺序、空的 inputs 两边不一样，直接比字符串会把同一棵树判成「变了」。
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

    /*
      工具箱**默认展开**（用户提的：「托块会自动收起托块的左侧栏，
      我认为不收起会更好」）。

      两件事：
      ① `autoClose = false` —— 默认点一下画布，Blockly 会把 flyout（块列表）
         关掉；关掉之后左边看着就像「收起来了」。
      ② **默认选中第一个分类** —— 否则 flyout 是空的（一个块都不显示），
         新人根本不知道要从哪儿开始拖。
    */
    try {
      const flyout = workspace.getFlyout()
      if (flyout) flyout.autoClose = false
      const toolbox = workspace.getToolbox()
      const first = toolbox?.getToolboxItems()[0]
      if (toolbox && first) toolbox.setSelectedItem(first)
    } catch {
      // 工具箱结构变了 —— 不影响别的功能
    }

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
      let current: BlockTree[]
      try {
        current = workspaceToTree(workspace)
      } catch {
        // 工作区正在被拆（clear 之后残留的 move 事件）—— 忽略这一次
        return
      }
      const canonical = canonicalTree(current)
      if (canonical === lastEmittedRef.current) return
      lastEmittedRef.current = canonical
      onChangeRef.current?.(current)
    }
    workspace.addChangeListener(onWorkspaceChange)

    // ⚠️ Blockly 自己不会因为「容器变了」而重新量 —— 得我们盯着。
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const host = hostRef.current
        if (!host || host.offsetWidth === 0) return
        // svgResize 会设 <svg> 的宽高，并把工具箱/缩放控件/垃圾桶重新摆位。
        // 光调 workspace.resize() **不够** —— 它不设 <svg> 的宽高属性。
        Blockly.svgResize(workspace)
        // render() 只是把渲染**排队**（走 requestAnimationFrame）。
        // 窗口没焦点时 rAF 会被节流，块就一直画不出来 —— 这里排完队立刻同步触发一次。
        Blockly.renderManagement.triggerQueuedRenders(workspace)
      })
    })
    ro.observe(hostRef.current)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      workspace.removeChangeListener(onWorkspaceChange)
      workspace.dispose()
      workspaceRef.current = null
    }
  }, [])

  // 外部（文本视图）改了 → 重建工作区
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const canonical = canonicalTree(tree)
    // ⚠️ **这棵树跟工作区里的一样就别重建** ——
    // 重建 = `workspace.clear()` + 重新灌 ⇒ ① 视角被重置（用户刚拖的块跳回原位）
    // ② 冒出一堆假事件（clear 之后残留的 move 事件会让 Blockly 崩：
    //    "The block associated with the block move event could not be found"）。
    if (canonical === lastEmittedRef.current) return

    rebuildingRef.current = true
    treeToWorkspace(workspace, tree)
    rebuildingRef.current = false
    // 基线取「工作区现在的样子」—— 重建过程冒出来的假事件读回来还是它 ⇒ 不会误报
    try {
      lastEmittedRef.current = canonicalTree(workspaceToTree(workspace))
    } catch {
      lastEmittedRef.current = canonical
    }
  }, [tree])

  useImperativeHandle(
    ref,
    (): BlockPaneHandle => ({
      resize() {
        const workspace = workspaceRef.current
        const host = hostRef.current
        if (!workspace || !host || host.offsetWidth === 0) return
        Blockly.svgResize(workspace)
        Blockly.renderManagement.triggerQueuedRenders(workspace)
      },
      focus() {
        // Blockly 13 的 WorkspaceSvg 没有 focus() 方法（焦点由 FocusManager 管）——
        // 直接把焦点给容器就行。
        hostRef.current?.focus()
      },
      getTree() {
        const workspace = workspaceRef.current
        return workspace ? workspaceToTree(workspace) : []
      },
    }),
    [],
  )

  return <div ref={hostRef} className="block-pane" tabIndex={-1} />
}
