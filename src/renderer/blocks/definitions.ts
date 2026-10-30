import * as Blockly from 'blockly/core'
import * as enMessages from 'blockly/msg/en'
import { BIN_OPS, BLOCK, TYPE_CHOICES, UN_OPS, VALUE_KINDS } from '@lang/blocks/tree'

/**
 * JHYY 的 Blockly 块定义。
 *
 * 字段名 / 输入名必须跟 `src/lang/blocks/tree.ts` 的块树对上 —— 那是
 * 「AST ↔ 块树 ↔ Blockly」三层之间唯一的契约。
 */

/** 主题里的块样式名（跟 DARK_THEME 的 blockStyles 对应）。 */
const STYLE = {
  var: 'var_blocks',
  value: 'value_blocks',
  op: 'op_blocks',
  control: 'control_blocks',
  func: 'func_blocks',
  type: 'type_blocks',
  text: 'text_blocks',
} as const

/** 工具箱分类的颜色（跟 DARK_THEME 的 categoryStyles 对应）。 */
const CATEGORY_COLOUR = {
  var: '#1e6f8f',
  value: '#8a6d1f',
  op: '#2f7a4f',
  control: '#9a5a1e',
  func: '#6b3f9e',
  type: '#2a7a7a',
  text: '#4a4f5a',
} as const

let registered = false

/**
 * 常用 C 函数的预设 —— 新人不用背参数表。
 *
 * ⚠️ 这些函数**不是** JHYY 的标准库，而是链接期由 `ld` 解析的 C 符号
 * （规范 §14「FFI」）。JHYY 里必须先声明才能调用。
 */
const EXTERN_PRESETS: Record<string, { name: string; params: string; ret: string }> = {
  printf: { name: 'printf', params: 'fmt: *u8, val: i32', ret: 'i32' },
  puts: { name: 'puts', params: 's: *u8', ret: 'i32' },
  putchar: { name: 'putchar', params: 'c: i32', ret: 'i32' },
  malloc: { name: 'malloc', params: 'size: u64', ret: '*u8' },
  free: { name: 'free', params: 'p: *u8', ret: '' },
  exit: { name: 'exit', params: 'code: i32', ret: '' },
  scanf: { name: 'scanf', params: 'fmt: *u8, val: *i32', ret: 'i32' },
}

/**
 * 「类型」下拉 —— 选项是**动态**的。
 *
 * ⚠️ Blockly 的 `FieldDropdown.setValue` 遇到**不在选项里**的值会**直接拒绝**
 * （保留旧值 + 打一条警告）—— 实测把 `*u8` 设进一个只有 i32/i64 的下拉，
 * 值会**悄悄变成 i32** ⇒ 用户的代码被改掉。
 *
 * 类型的取值空间不止基础类型（还有 `*u8` / `[i32; 4]` / `Cap<T>` …），
 * 而反编译出来的就是这些值 ⇒ 选项里必须**永远带上当前值**。
 * 所以这里重写 `setValue`：先把要设的值加进选项，再设。
 */
function typeOptions(): Blockly.MenuOption[] {
  return [
    // 「不写类型」—— `let mut i = 0;` 的类型是空的，得能选得回来
    ['', '（不写）'] as Blockly.MenuOption,
    ...TYPE_CHOICES.map((t) => [t, t] as Blockly.MenuOption),
  ]
}

/** printf 的格式串 —— 常用的一批（用户可以自己填别的 ✓）。 */
function formatOptions(): Blockly.MenuOption[] {
  return [
    '%d\n',
    '%d',
    '%s\n',
    '%s',
    '%x\n',
    '%x',
    '%c',
  ].map((f) => [f, f] as Blockly.MenuOption)
}

/**
 * 每个动态下拉**见过的、列表之外的值**。
 *
 * ⚠️ 用 WeakMap 而不是实例字段 —— `FieldDropdown` 的构造函数里就会调
 * `getOptions()`，那时候子类的字段还没初始化 ✗。
 */
const dynExtras = new WeakMap<Blockly.FieldDropdown, Set<string>>()

/**
 * 「选项可以超出固定列表」的下拉。
 *
 * ⚠️ Blockly 的 `FieldDropdown.setValue` 遇到**不在选项里**的值会**直接拒绝**
 * （保留旧值 + 打一条警告）—— 实测把 `*u8` 设进一个只有 i32/i64 的下拉，
 * 值会**悄悄变成 i32** ⇒ 用户的代码被改掉。
 *
 * 类型的取值空间不止基础类型（还有 `*u8` / `[i32; 4]` / `Cap<T>` …），
 * printf 的格式串也是任意的 ⇒ 选项里必须**永远带上当前值**。
 */
class DynamicDropdown extends Blockly.FieldDropdown {
  constructor(base: Blockly.MenuOption[], defaultValue: string) {
    super(() => base)
    dynExtras.set(this, new Set<string>([defaultValue]))
    // ⚠️ `FieldDropdown` 的构造函数会把值设成**第一个选项** ⇒
    //   得自己设回真正的默认值。
    this.setValue(defaultValue)
  }

  /** 选项 = 固定列表 + **这个块见过的一切别的值**。 */
  override getOptions(_useCache?: boolean): Blockly.MenuOption[] {
    const opts = [...super.getOptions(false)]
    const extra = dynExtras.get(this)
    if (extra) {
      for (const v of extra) {
        if (!opts.some((o) => o[1] === v)) opts.push([v, v] as Blockly.MenuOption)
      }
    }
    return opts
  }

  override setValue(newValue: string): void {
    const extra = dynExtras.get(this) ?? new Set<string>()
    extra.add(newValue)
    dynExtras.set(this, extra)
    // ⚠️ **不能**在 setValue 里调 setOptions —— `setOptions` 内部会调
    // `setValue` ⇒ 无限递归。改成把值加进 `getOptions()` 的结果里 ✓。
    super.setValue(newValue)
  }
}

/** 「类型」下拉。 */
function typeField(defaultValue: string): DynamicDropdown {
  return new DynamicDropdown(typeOptions(), defaultValue)
}

/** 「printf 格式串」下拉。 */
function formatField(defaultValue: string): DynamicDropdown {
  return new DynamicDropdown(formatOptions(), defaultValue)
}


/**
 * 暗色主题。
 *
 * Blockly 默认是浅色的（白底黑字），跟 IDE 的暗色调不搭 —— 而且工具箱那一条
 * 窄边上的分类名几乎看不见。所以这里自己定义一套。
 */
export const DARK_THEME = new Blockly.Theme(
  'jhyy-dark',
  {
    var_blocks: { colourPrimary: '#1e6f8f', colourSecondary: '#17536b', colourTertiary: '#0f3d50', hat: '' },
    value_blocks: { colourPrimary: '#8a6d1f', colourSecondary: '#6b5416', colourTertiary: '#4d3c0f', hat: '' },
    op_blocks: { colourPrimary: '#2f7a4f', colourSecondary: '#255f3d', colourTertiary: '#1a452c', hat: '' },
    control_blocks: { colourPrimary: '#9a5a1e', colourSecondary: '#7a4616', colourTertiary: '#5b3310', hat: '' },
    func_blocks: { colourPrimary: '#6b3f9e', colourSecondary: '#54327d', colourTertiary: '#3d2460', hat: '' },
    type_blocks: { colourPrimary: '#2a7a7a', colourSecondary: '#216161', colourTertiary: '#184848', hat: '' },
    text_blocks: { colourPrimary: '#4a4f5a', colourSecondary: '#3a3f49', colourTertiary: '#2b2f37', hat: '' },
  },
  {
    var_category: { colour: CATEGORY_COLOUR.var },
    value_category: { colour: CATEGORY_COLOUR.value },
    op_category: { colour: CATEGORY_COLOUR.op },
    control_category: { colour: CATEGORY_COLOUR.control },
    func_category: { colour: CATEGORY_COLOUR.func },
    type_category: { colour: CATEGORY_COLOUR.type },
    text_category: { colour: CATEGORY_COLOUR.text },
  },
  {
    workspaceBackgroundColour: '#101219',
    toolboxBackgroundColour: '#1b1e26',
    toolboxForegroundColour: '#d7dce5',
    flyoutBackgroundColour: '#14161c',
    flyoutForegroundColour: '#d7dce5',
    flyoutOpacity: 1,
    scrollbarColour: '#2a2f3a',
    scrollbarOpacity: 1,
    insertionMarkerColour: '#00d4aa',
    insertionMarkerOpacity: 1,
    markerColour: '#00d4aa',
    cursorColour: '#00d4aa',
    selectedGlowColour: '#00d4aa',
    selectedGlowOpacity: 0.4,
  },
)

/** 注册全部块定义（幂等）。 */
export function defineJhyyBlocks(): void {
  if (registered) return
  registered = true

  // ⚠️ `blockly/core` **不带语言包** —— 不设 locale 的话 Blockly 自己的
  // 提示文案（Blockly.Msg.*）全是 undefined，工作区一建就炸
  // （`WORKSPACE_LABEL_MANY_STACKS.replace(...)` → "Cannot read properties
  // of undefined (reading 'replace')"）。所以这里显式把英文语言包装上。
  Blockly.setLocale(enMessages as unknown as Record<string, string>)

  const defs = {
    // ── 变量 ──────────────────────────────────────────────
    [BLOCK.let]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW1')
          .appendField('let', 'LBL_LET')
          .appendField(new Blockly.FieldCheckbox('FALSE'), 'MUT')
          .appendField(new Blockly.FieldTextInput('x'), 'NAME')
        this.appendValueInput('VALUE').setCheck(null)
        this.appendDummyInput('ROW2').appendField('类型', 'LBL_TYPE')
          .appendField(typeField(''), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.var)
        this.setTooltip('声明一个变量')
      },
    },

    [BLOCK.set]: {
      init(this: Blockly.BlockSvg) {
        // 一行两个孔：`[目标] = [值]`
        this.appendValueInput('TARGET').setCheck(null)
        // ⚠️ 「=」要挂在**右边的孔**上 ⇒ 渲染成 [目标] = [值]（跟经典积木一样）
        const value = this.appendValueInput('VALUE')
        value.setCheck(null)
        value.appendField('=', 'LBL_EQ')
        this.setInputsInline(true)
        // ⚠️ **不要** `setOutput(true)` —— 值形态是另一个块（`jhyy_set_val`）。
        // 一个块既输出又前后连接 ⇒ 灌进**语句容器**时 Blockly 会拿输出连接
        // 去接语句口 ⇒ "Attempt to connect incompatible types."（块视图崩）。
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.var)
        this.setTooltip('给变量赋值')
      },
    },

    [BLOCK.variable]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('NAME').appendField(new Blockly.FieldTextInput('x'), 'NAME')
        this.setOutput(true)
        this.setStyle(STYLE.var)
        this.setTooltip('引用一个变量')
      },
    },

    // ── 字面量 ────────────────────────────────────────────
    [BLOCK.value]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField(
            new Blockly.FieldDropdown(VALUE_KINDS.map((k) => [k, k])),
            'KIND',
          )
          .appendField(new Blockly.FieldTextInput('0'), 'VALUE')
        this.setOutput(true)
        this.setStyle(STYLE.value)
      },
    },

    // ── 运算 ──────────────────────────────────────────────
    [BLOCK.binop]: {
      init(this: Blockly.BlockSvg) {
        /*
          ⚠️ **一行、两个孔** —— 用户提的：「运算表达式现在是分两行显示，
          我认为一行里面挖两个孔那种更直观」。

          做法：值输入 + `setInputsInline(true)`；中间的运算符**直接
          `appendField` 到块上**（它会挂到上一个输入的那一行里），
          **不能**用 `appendDummyInput` —— dummy 输入**一定会另起一行** ✗。
        */
        this.appendValueInput('LEFT').setCheck(null)
        // ⚠️ **运算符要挂在「右边的孔」上** ——
        //   Blockly 把一个输入上的字段渲染在**这个孔的前面** ⇒
        //   挂左边 ⇒ 变成 [+] [a] [b]（运算符跑到最左边了）；
        //   挂右边 ⇒ [a] [+] [b]（运算符在中间 ✓）。
        const right = this.appendValueInput('RIGHT')
        right.setCheck(null)
        right.appendField(
          new Blockly.FieldDropdown(BIN_OPS.map((op) => [op, op])),
          'OP',
        )
        this.setInputsInline(true)
        this.setOutput(true)
        this.setStyle(STYLE.op)
      },
    },

    [BLOCK.unop]: {
      init(this: Blockly.BlockSvg) {
        const value = this.appendValueInput('VALUE')
        value.setCheck(null)
        value.appendField(
          new Blockly.FieldDropdown(UN_OPS.map((op) => [op, op])),
          'OP',
        )
        this.setInputsInline(true)
        this.setOutput(true)
        this.setStyle(STYLE.op)
      },
    },

    [BLOCK.cast]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('VALUE').setCheck(null)
        // ⚠️ 「as i32」只有一个孔，而字段渲染在**自己那个孔前面** ⇒
        //   同一行会变成 [as i32][孔]（读着别扭）⇒ 这里还是两行。
        this.appendDummyInput('OP')
          .appendField('as', 'LBL_AS')
          .appendField(typeField('i32'), 'TYPE')
        this.setOutput(true)
        this.setStyle(STYLE.type)
        this.setTooltip('类型转换 —— 整数和浮点之间必须显式转换')
      },
    },

    [BLOCK.field]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('OBJ').setCheck(null)
        this.appendDummyInput('NAME')
          .appendField('.', 'LBL_DOT')
          .appendField(new Blockly.FieldTextInput('x'), 'NAME')
        this.setOutput(true)
        this.setStyle(STYLE.op)
        this.setTooltip('取结构体字段')
      },
    },

    [BLOCK.index]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('ARR').setCheck(null)
        const index = this.appendValueInput('INDEX')
        index.setCheck(null)
        index.appendField('[', 'LBL_OPEN')
        index.appendField(']', 'LBL_CLOSE')
        this.setInputsInline(true)
        this.setOutput(true)
        this.setStyle(STYLE.op)
        this.setTooltip('取数组 / 切片元素')
      },
    },

    [BLOCK.array]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('数组', 'LBL_ARRAY')
        this.appendDummyInput('LBL_ELEMS').appendField(new Blockly.FieldLabel('元素'))
        this.appendStatementInput('ELEMS')
        this.setOutput(true)
        this.setStyle(STYLE.value)
      },
    },

    // ── 调用 ──────────────────────────────────────────────
    [BLOCK.call]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('NAME').appendField(
          new Blockly.FieldTextInput('printf'),
          'NAME',
        )
        this.appendDummyInput('LBL_ARGS').appendField(new Blockly.FieldLabel('参数'))
        this.appendStatementInput('ARGS')
        this.setOutput(true)
        this.setStyle(STYLE.func)
        this.setTooltip('调用函数')
      },
    },

    [BLOCK.qualifiedCall]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('MOD').appendField(
          new Blockly.FieldTextInput('vec'),
          'MODULE',
        )
        this.appendDummyInput('DOT')
          .appendField('::', 'LBL_COLONCOLON')
          .appendField(new Blockly.FieldTextInput('std_vec_len'), 'NAME')
        this.appendDummyInput('LBL_ARGS').appendField(new Blockly.FieldLabel('参数'))
        this.appendStatementInput('ARGS')
        this.setOutput(true)
        this.setStyle(STYLE.func)
        this.setTooltip('调用模块里的函数（import 之后才能用）')
      },
    },

    [BLOCK.arg]: {
      init(this: Blockly.BlockSvg) {
        // ⚠️ **静态标签必须用「没有名字」的 FieldLabel** ——
        // Blockly 的 `Field.isSerializable()` 对「没有名字」的字段返回 false
        // ⇒ 它**不会**被写进 XML ⇒ 块树一个字节都不变 ✓
        // （用 `appendField(text, '名字')` 给个名字的话，XML 里就多一个字段，
        //   读回来跟反编译出来的对不上 ⇒ 每次都判成「变了」⇒ 无限重建。）
        this.appendDummyInput('ROW').appendField(new Blockly.FieldLabel('实参'))
        this.appendValueInput('ARG').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.value)
        this.setTooltip('一个值（实参 / 数组元素）')
      },
    },

    [BLOCK.print]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('FMT').appendField('printf', 'LBL_PRINTF')
          // ⚠️ 格式串是**动态**下拉 —— 源码里可能是 "%d 件\n" 这种，
          // 固定选项的下拉会**悄悄拒绝**它（值变成第一个选项 ⇒ 代码被改掉）。
          .appendField(formatField('%d\\n'), 'FMT')
        this.appendValueInput('VALUE').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
        this.setTooltip('打印一个值')
      },
    },

    // ── 控制流 ────────────────────────────────────────────
    [BLOCK.if]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('if', 'LBL_IF')
        this.appendValueInput('COND').setCheck(null)
        /*
          ⚠️ **两个分支长得一模一样，谁是谁分不清** —— 用户报过
          「同样 if 的块也让人摸不着头脑」。

          Blockly 的**语句容器没法加标签**，所以用「无名静态标签」在容器**前面**
          各加一行字（成立时 / 否则）。

          ⚠️ 这个标签**必须没有名字** ⇒ 它不会被写进 XML ⇒ 块树一个字节都不变
          （见 CLAUDE.md 里「静态标签要用没有名字的 FieldLabel」那条）。
        */
        this.appendDummyInput('LBL_THEN').appendField(new Blockly.FieldLabel('成立时'))
        this.appendStatementInput('THEN')
        this.appendDummyInput('LBL_ELSE').appendField(new Blockly.FieldLabel('否则'))
        this.appendStatementInput('ELSE')
        // ⚠️ **不要** `setOutput(true)` —— `if` 当**表达式**用的时候
        // （`let x = if c { 1 } else { 0 };`）用的是另一个块 `jhyy_if_val`。
        // 一个块既输出又前后连接 ⇒ 灌进**语句容器**时 Blockly 会拿输出连接
        // 去接语句口 ⇒ "Attempt to connect incompatible types."（块视图崩）。
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.while]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('while', 'LBL_WHILE')
        this.appendValueInput('COND').setCheck(null)
        this.appendDummyInput('LBL_BODY').appendField(new Blockly.FieldLabel('循环体'))
        this.appendStatementInput('BODY')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.for]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR')
          .appendField('for', 'LBL_FOR')
          .appendField(new Blockly.FieldTextInput('i'), 'NAME')
          .appendField('in', 'LBL_IN')
        this.appendValueInput('START').setCheck(null)
        this.appendDummyInput('DOTDOT').appendField('..', 'LBL_')
        this.appendValueInput('END').setCheck(null)
        this.appendDummyInput('LBL_BODY').appendField(new Blockly.FieldLabel('循环体'))
        this.appendStatementInput('BODY')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.return]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('return', 'LBL_RETURN')
        this.appendValueInput('VALUE').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.break]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('break', 'LBL_BREAK')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.continue]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('continue', 'LBL_CONTINUE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    // ── 函数 / 类型 ───────────────────────────────────────
    [BLOCK.func]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW1')
          .appendField('fn', 'LBL_FN')
          .appendField(new Blockly.FieldTextInput('main_jhyy'), 'NAME')
        this.appendDummyInput('ROW2')
          .appendField('参数', 'LBL_PARAMS')
        this.appendStatementInput('PARAMS')
        this.appendDummyInput('ROW3')
          .appendField('返回', 'LBL_RET')
          .appendField(typeField('i32'), 'RET')
        this.appendDummyInput('LBL_BODY').appendField(new Blockly.FieldLabel('函数体'))
        this.appendStatementInput('BODY')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
      },
    },

    [BLOCK.param]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField(new Blockly.FieldTextInput('x'), 'NAME')
          .appendField(':', 'LBL_')
          .appendField(typeField('i32'), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
        this.setTooltip('函数参数（类型必须显式标注）')
      },
    },

    [BLOCK.structDef]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW1')
          .appendField('type', 'LBL_TYPE')
          .appendField(new Blockly.FieldTextInput('Point'), 'NAME')
          .appendField('= struct', 'LBL_STRUCT')
        this.appendDummyInput('LBL_FIELDS').appendField(new Blockly.FieldLabel('字段'))
        this.appendStatementInput('FIELDS')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
      },
    },

    [BLOCK.fieldDecl]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField(new Blockly.FieldTextInput('x'), 'NAME')
          .appendField(':', 'LBL_')
          .appendField(typeField('i32'), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
      },
    },

    [BLOCK.enumDef]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW1')
          .appendField('type', 'LBL_TYPE')
          .appendField(new Blockly.FieldTextInput('Color'), 'NAME')
          .appendField('= enum', 'LBL_ENUM')
        this.appendDummyInput('LBL_VARIANTS').appendField(new Blockly.FieldLabel('变体'))
        this.appendStatementInput('VARIANTS')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
      },
    },

    [BLOCK.variantDecl]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField(new Blockly.FieldTextInput('Red'), 'NAME')
          .appendField(':', 'LBL_')
          .appendField(typeField(''), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
        this.setTooltip('枚举变体 —— 载荷类型留空表示无载荷')
      },
    },

    [BLOCK.structLit]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('TYPE').appendField(
          new Blockly.FieldTextInput('Point'),
          'TYPE',
        )
        this.appendDummyInput('LBL_FIELDS').appendField(new Blockly.FieldLabel('字段'))
        this.appendStatementInput('FIELDS')
        this.setOutput(true)
        this.setStyle(STYLE.value)
      },
    },

    [BLOCK.fieldInit]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('NAME').appendField(new Blockly.FieldTextInput('x'), 'NAME')
        this.appendValueInput('VALUE').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.value)
      },
    },

    [BLOCK.enumVariant]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField(new Blockly.FieldTextInput('Color'), 'TYPE')
          .appendField('::', 'LBL_COLONCOLON')
          .appendField(new Blockly.FieldTextInput('Red'), 'VARIANT')
        this.appendValueInput('PAYLOAD').setCheck(null)
        this.setOutput(true)
        this.setStyle(STYLE.value)
      },
    },

    [BLOCK.match]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('match', 'LBL_MATCH')
        this.appendValueInput('SUBJECT').setCheck(null)
        this.appendDummyInput('LBL_ARMS').appendField(new Blockly.FieldLabel('分支'))
        this.appendStatementInput('ARMS')
        // ⚠️ **不要** `setOutput(true)` —— 值形态是 `jhyy_match_val`（同 `jhyy_if`）。
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
        this.setTooltip('match —— 每个分支的模式写在分支块里')
      },
    },

    [BLOCK.matchArm]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('PAT').appendField(new Blockly.FieldTextInput('_'), 'PATTERN')
        this.appendDummyInput('ARROW').appendField('=>', 'LBL_')
        this.appendValueInput('BODY').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
        this.setTooltip('分支 —— 模式可以是 1 / 1..10 / Color::Red / Some(v) / _')
      },
    },

    [BLOCK.typedef]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField('type', 'LBL_TYPE')
          .appendField(new Blockly.FieldTextInput('Age'), 'NAME')
          .appendField('=', 'LBL_EQ')
          .appendField(typeField('i32'), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
      },
    },

    [BLOCK.import]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('ROW')
          .appendField('import', 'LBL_IMPORT')
          .appendField(new Blockly.FieldTextInput('vec'), 'MODULE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
        this.setTooltip('导入模块 —— 只写模块名，不带 std:: 前缀')
      },
    },

    /*
      读入一个整数 —— `scanf("%d", &x)`。

      ⚠️ **给新人的现成块** —— 以前要手写 `extern fn scanf(...)` 声明 +
      `scanf("%d", &x)`，而「取地址」在块子集里根本没有（只能靠逃生舱）。
      现在：**取地址由这个块自己加** ✓。
    */
    [BLOCK.input]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR')
          .appendField('读入', 'LBL_INPUT')
          .appendField(new Blockly.FieldDropdown([['整数', '整数']]), 'KIND')
        this.appendValueInput('VALUE').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
        this.setTooltip(
          '从标准输入读一个整数到左边那个变量。' +
            '需要先有「C 函数声明」块（选 scanf 那个预设）。',
        )
      },
    },

    /*
      C 函数声明（`extern fn`）。
      ⚠️ **这个块是「新人友好」的关键** —— 以前没有它，写 hello world 的
      第一行 `extern fn printf(fmt: *u8, val: i32) -> i32;` 只能用
      「原始代码」逃生舱 ⇒ 一上来就让人面对原始文本，对新人极其不友好。
    */
    [BLOCK.externFn]: {
      init(this: Blockly.BlockSvg) {
        const block = this
        const preset = new Blockly.FieldDropdown(
          [
            ['（自己填）', ''],
            ...Object.keys(EXTERN_PRESETS).map((k) => [k, k] as [string, string]),
          ],
          function (newValue: string) {
            const p = EXTERN_PRESETS[newValue]
            if (!p) return newValue
            block.setFieldValue(p.name, 'NAME')
            block.setFieldValue(p.params, 'PARAMS')
            block.setFieldValue(p.ret, 'RET')
            return newValue
          },
        )
        this.appendDummyInput('ROW1')
          .appendField('extern fn', 'LBL_EXTERN')
          // ⚠️ **这个下拉不给名字** ⇒ 它不会被写进 XML ⇒ 块树一个字节都不变
          //   （见 CLAUDE.md 里「静态标签要用没有名字的 FieldLabel」那条）。
          //   真正存内容的是下面三个有名字的字段。
          .appendField(preset)
          .appendField(new Blockly.FieldTextInput('puts'), 'NAME')
        this.appendDummyInput('ROW2')
          .appendField('(', 'LBL_LPAREN')
          .appendField(new Blockly.FieldTextInput('s: *u8'), 'PARAMS')
          .appendField(')', 'LBL_RPAREN')
        this.appendDummyInput('ROW3')
          .appendField('->', 'LBL_ARROW')
          .appendField(typeField('i32'), 'RET')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.type)
        this.setTooltip(
          '声明一个 C 函数（链接期由 ld 解析符号）—— ' +
            '上面那个下拉可以直接选常见的（printf / puts / malloc …）',
        )
      },
    },


    // ── 语句形态 / 值形态的变体 ──────────────────────────
    //
    // Blockly 里一个块不能同时是值块（有输出连接）和语句块（有前后连接）。
    // JHYY 里调用 / 赋值 / if / match 在两种位置都能出现，所以各给一个变体。

    [BLOCK.callStmt]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('NAME').appendField(
          new Blockly.FieldTextInput('printf'),
          'NAME',
        )
        this.appendDummyInput('LBL_ARGS').appendField(new Blockly.FieldLabel('参数'))
        this.appendStatementInput('ARGS')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
        this.setTooltip('调用函数（当语句用，返回值丢弃）')
      },
    },

    [BLOCK.qualifiedCallStmt]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('MOD').appendField(
          new Blockly.FieldTextInput('vec'),
          'MODULE',
        )
        this.appendDummyInput('DOT')
          .appendField('::', 'LBL_COLONCOLON')
          .appendField(new Blockly.FieldTextInput('std_vec_len'), 'NAME')
        this.appendDummyInput('LBL_ARGS').appendField(new Blockly.FieldLabel('参数'))
        this.appendStatementInput('ARGS')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.func)
        this.setTooltip('调用模块里的函数（当语句用）')
      },
    },

    [BLOCK.setValue]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('TARGET').setCheck(null)
        this.appendDummyInput('OP').appendField('=', 'LBL_EQ')
        this.appendValueInput('VALUE').setCheck(null)
        this.setOutput(true)
        this.setStyle(STYLE.var)
        this.setTooltip('赋值（当表达式用）')
      },
    },

    [BLOCK.ifValue]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('if', 'LBL_IF')
        this.appendValueInput('COND').setCheck(null)
        this.appendDummyInput('LBL_THEN').appendField(new Blockly.FieldLabel('成立时'))
        this.appendStatementInput('THEN')
        this.appendDummyInput('LBL_ELSE').appendField(new Blockly.FieldLabel('否则'))
        this.appendStatementInput('ELSE')
        this.setOutput(true)
        this.setStyle(STYLE.control)
        this.setTooltip('if 表达式 —— 产出值')
      },
    },

    [BLOCK.matchValue]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('match', 'LBL_MATCH')
        this.appendValueInput('SUBJECT').setCheck(null)
        this.appendDummyInput('LBL_ARMS').appendField(new Blockly.FieldLabel('分支'))
        this.appendStatementInput('ARMS')
        this.setOutput(true)
        this.setStyle(STYLE.control)
        this.setTooltip('match 表达式 —— 产出值')
      },
    },

    [BLOCK.exprStmt]: {
      init(this: Blockly.BlockSvg) {
        // 静态标签 —— 没有名字 ⇒ 不会被写进 XML（见上面 jhyy_arg 的说明）
        this.appendDummyInput('ROW').appendField(new Blockly.FieldLabel('表达式'))
        this.appendValueInput('VALUE').setCheck(null)
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.op)
        this.setTooltip('求值但丢弃结果（表达式语句）')
      },
    },

    // ── 逃生舱 ────────────────────────────────────────────
    [BLOCK.opaque]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('原始代码', 'LBL_RAW')
        this.appendDummyInput('CODE').appendField(
          // ⚠️ 字段**必须显式给名字** —— 不给的话 Blockly 13 会建出一个
          // 空名字的字段，读回来时找不到，代码就丢了。
          new Blockly.FieldTextInput('// 这段代码暂时不能用块表示'),
          'CODE',
        )
        /*
          ⚠️ **语句形态** —— 只有前后连接，**没有**输出连接。

          逃生舱在三种位置出现（见 `src/lang/blocks/decompile.ts`）：
          - **表达式**位置 ⇒ 用**值形态**的 `jhyy_opaque_val`
          - **语句**位置（函数体里的一句）⇒ 这个块
          - **声明**位置（顶层）⇒ 这个块

          为什么不能「一个块两种连接都有」：Blockly 灌 XML 时给子块挑连接口
          的顺序是**先 output、再 previous**，它分不清 `<statement>` 和
          `<value>`。所以一个既输出又前后连接的块，放进语句容器时会拿输出
          连接去接语句口 ⇒ **"Attempt to connect incompatible types."**
          ⇒ 块视图直接崩。
        */
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.text)
        this.setTooltip(
          '块子集表达不了的语法 —— 原样保留，不会丢。' +
            '换行写成 \\n，反斜杠写成 \\\\。',
        )
      },
    },

    [BLOCK.opaqueValue]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('原始代码', 'LBL_RAW')
        this.appendDummyInput('CODE').appendField(
          new Blockly.FieldTextInput('// 这段代码暂时不能用块表示'),
          'CODE',
        )
        // ⚠️ **值形态** —— 只有输出连接（语句形态见上面 `jhyy_opaque`）。
        this.setOutput(true)
        this.setStyle(STYLE.text)
        this.setTooltip('块子集表达不了的表达式 —— 原样保留，不会丢。')
      },
    },
  }
  Blockly.common.defineBlocks(defs)
}

/** 工具箱。 */
/** 工具箱。 */
export function buildToolbox(): Blockly.BlocklyOptions['toolbox'] {
  defineJhyyBlocks()

  const cat = (name: string, colour: string, types: string[]) => ({
    kind: 'category',
    name,
    colour: String(colour),
    contents: types.map((type) => ({ kind: 'block', type })),
  })

  return {
    kind: 'categoryToolbox',
    contents: [
      /*
        ⚠️ **「入门」放在第一个** —— 新人打开块视图看到的第一屏。
        以前第一屏是「变量 / 运算 / 控制流 / 函数 / 类型」这一堆看不懂的分类，
        而写 hello world 需要的块**一个都不在那几屏里**
        （`extern fn` 声明更是只能靠「原始代码」逃生舱）。
        现在第一屏就是「写第一个程序」要用的那几块。
      */
      cat('入门', CATEGORY_COLOUR.control, [
        BLOCK.func, // 函数
        BLOCK.print, // 打印
        BLOCK.input, // 读入（scanf）
        BLOCK.callStmt, // 调用函数（当语句用）
        BLOCK.arg, // 实参（调用函数的参数）
        BLOCK.value, // 数字 / 字符串 / 布尔
        BLOCK.let, // 变量
        BLOCK.return, // 返回
        BLOCK.externFn, // C 函数声明
      ]),
      cat('变量', CATEGORY_COLOUR.var, [BLOCK.let, BLOCK.set, BLOCK.variable, BLOCK.value]),
      cat('运算', CATEGORY_COLOUR.op, [
        BLOCK.binop,
        BLOCK.unop,
        BLOCK.cast,
        BLOCK.field,
        BLOCK.index,
        BLOCK.array,
        // 「表达式语句」—— 画布上会出现（反编译器生成的），工具箱里也得能找得到
        BLOCK.exprStmt,
      ]),
      cat('控制流', CATEGORY_COLOUR.control, [
        BLOCK.if,
        BLOCK.while,
        BLOCK.for,
        BLOCK.break,
        BLOCK.continue,
        BLOCK.match,
        // 「分支」—— match 的每个分支都是它，画布上会出现，工具箱里也得能找得到
        BLOCK.matchArm,
        BLOCK.return,
      ]),
      cat('函数', CATEGORY_COLOUR.func, [
        BLOCK.func,
        BLOCK.call,
        BLOCK.qualifiedCall,
        // 「语句形态」的调用 / 限定调用 —— 当语句用的时候要的是这两个
        BLOCK.callStmt,
        BLOCK.qualifiedCallStmt,
        BLOCK.print,
        // 「实参」—— 画布上会出现（反编译器生成的），工具箱里也得能找得到
        BLOCK.arg,
        // 「参数」—— 函数块的参数栏里放的就是它
        BLOCK.param,
      ]),
      cat('类型', CATEGORY_COLOUR.type, [
        BLOCK.structDef,
        BLOCK.enumDef,
        BLOCK.structLit,
        BLOCK.enumVariant,
        BLOCK.typedef,
        BLOCK.import,
        // 「字段」/「变体」—— 结构体 / 枚举体里放的就是它们
        BLOCK.fieldDecl,
        BLOCK.variantDecl,
        // C 函数声明（extern fn）
        BLOCK.externFn,
      ]),
      cat('原始代码', CATEGORY_COLOUR.text, [BLOCK.opaque, BLOCK.opaqueValue]),
    ],
  }
}

export { CATEGORY_COLOUR, STYLE, TYPE_CHOICES }
