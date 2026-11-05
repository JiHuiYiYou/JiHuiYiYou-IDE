/**
 * 「双击自己填」的探测器。
 *
 * ## 为什么不能靠浏览器/Blockly 的双击
 *
 * - **浏览器的 `click`/`dblclick` 靠不住** —— Blockly 的手势在 pointerdown 上
 *   `preventDefault()` ⇒ ⇒ **兼容性的 mouse 事件（mousedown/click/dblclick）
 *   根本不会触发** ⇒ ⇒ 连 `MouseEvent.detail` 都拿不到 ✗
 * - **Blockly 的 `showEditor_` 也靠不住** —— 单击那一下就把
 *   `currentDropdownOwner` 设成了这个字段 ⇒ ⇒ 双击的第二下
 *   `currentDropdownOwner === startField` ⇒ ⇒ **压根不会调 `showEditor_`**
 *   ⇒ ⇒ ⇒ 表现就是「一直只有单击的效果」（用户报过）✗
 *
 * ⇒ ⇒ 所以**自己记「上一次按下的时间 + 位置」** ⇒ 自己判 ✓
 *
 * ## 为什么要挂在**捕获阶段**
 *
 * Blockly 的手势（`doFieldClick`）挂在**工作区 SVG**上 ⇒ 那是字段组的**祖先**
 * ⇒ ⇒ 它跑在**冒泡**阶段 ⇒ ⇒ 我们在**捕获**阶段挂在字段组上 ⇒ ⇒ **一定先跑** ✓
 * ⇒ ⇒ 双击时可以 `stopPropagation()` ⇒ **Blockly 压根看不到第二下**
 * ⇒ ⇒ 不会出现「下拉又弹回来 / 把块拖走」✗
 */

/** 双击的判定参数。 */
export interface DoubleClickOptions {
  /** 双击的时间窗（毫秒）—— 浏览器自己的双击判定约 500ms。 */
  windowMs?: number
  /** 双击的最大位移（像素）—— 拖动块的时候指针会走 ⇒ 不能当成双击 ✓ */
  maxDistance?: number
}

const DEFAULT_WINDOW_MS = 500
const DEFAULT_MAX_DISTANCE = 8

export class DoubleClickWatcher {
  /** 上一次 pointerdown 的时间（毫秒）。0 = 还没按过。 */
  private lastTime = 0
  /** 上一次 pointerdown 的位置。 */
  private lastX = 0
  private lastY = 0
  /**
   * 上一次处理过的**事件对象**。
   *
   * ⚠️ 捕获阶段和冒泡阶段**都会**收到同一个事件（目标就是字段组的时候）⇒
   *    ⇒ 不去重的话**一次点击会被算成两下** ⇒ ⇒ 单击就变成双击 ✗
   */
  private lastEvent: Event | null = null

  private readonly onDoubleClick: (e: PointerEvent) => void
  private readonly windowMs: number
  private readonly maxDistance: number

  constructor(onDoubleClick: (e: PointerEvent) => void, opts: DoubleClickOptions = {}) {
    this.onDoubleClick = onDoubleClick
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE
  }

  /**
   * 挂到元素上 ⇒ 一定抢在 Blockly 前面 ✓
   *
   * ⚠️ **捕获 + 冒泡都挂** ——
   *    - 捕获阶段：目标是字段组的**后代**（文字/箭头）时 ⇒ 抢在 Blockly 前面 ✓
   *    - 冒泡阶段：**万一**目标就是字段组本身（DOM 规范在「at target」阶段
   *      只跑非捕获监听器）⇒ 靠它兜底 ✓
   *    - 同一个事件两个阶段都会到 ⇒ **`handle` 里去重** ✓
   *
   * ⚠️ 挂在**字段组**上（不是 `<text>`）——
   *    ① 点文字、点下拉箭头都算「点这个字段」✓
   *    ② 字段组是**一个**元素 ⇒ 一次点击只算一下 ✓
   */
  attach(target: Element): void {
    target.addEventListener('pointerdown', this.handle, true)
    target.addEventListener('pointerdown', this.handle, false)
  }

  /** 解除挂载（块被删掉时）✓ */
  detach(target: Element): void {
    target.removeEventListener('pointerdown', this.handle, true)
    target.removeEventListener('pointerdown', this.handle, false)
  }

  /** 处理一次 pointerdown —— 是「双击的第二下」就回调 ✓ */
  readonly handle = (e: Event): void => {
    // ⚠️ **同一个事件只算一下**（捕获 + 冒泡都会来）✓
    if (e === this.lastEvent) return
    this.lastEvent = e

    const pe = e as PointerEvent
    const now = Date.now()
    const moved = Math.hypot(pe.clientX - this.lastX, pe.clientY - this.lastY)
    const isDouble =
      this.lastTime !== 0 && now - this.lastTime < this.windowMs && moved <= this.maxDistance
    this.lastX = pe.clientX
    this.lastY = pe.clientY
    if (!isDouble) {
      this.lastTime = now
      return
    }
    // ⚠️ **双击之后就「归零」** —— 三击应该是「双击 + 再单击」，
    //    而不是「双击 + 又一个双击」（跟浏览器自己的 `dblclick` 一个语义）✓
    this.lastTime = 0
    this.onDoubleClick(pe)
  }
}
