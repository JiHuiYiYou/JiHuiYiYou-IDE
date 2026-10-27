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
          .appendField(new Blockly.FieldTextInput(''), 'TYPE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.var)
        this.setTooltip('声明一个变量')
      },
    },

    [BLOCK.set]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('TARGET').setCheck(null)
        this.appendDummyInput('OP').appendField('=', 'LBL_EQ')
        this.appendValueInput('VALUE').setCheck(null)
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
        this.appendDummyInput('OP').appendField(
          new Blockly.FieldDropdown(BIN_OPS.map((op) => [op, op])),
          'OP',
        )
        this.appendValueInput('LEFT').setCheck(null)
        this.appendValueInput('RIGHT').setCheck(null)
        this.setOutput(true)
        this.setStyle(STYLE.op)
      },
    },

    [BLOCK.unop]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('OP').appendField(
          new Blockly.FieldDropdown(UN_OPS.map((op) => [op, op])),
          'OP',
        )
        this.appendValueInput('VALUE').setCheck(null)
        this.setOutput(true)
        this.setStyle(STYLE.op)
      },
    },

    [BLOCK.cast]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('VALUE').setCheck(null)
        this.appendDummyInput('OP')
          .appendField('as', 'LBL_AS')
          .appendField(new Blockly.FieldTextInput('i32'), 'TYPE')
        this.setOutput(true)
        this.setStyle(STYLE.type)
        this.setTooltip('类型转换 —— 整数和浮点之间必须显式转换')
      },
    },

    [BLOCK.field]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('OBJ').setCheck(null)
        this.appendDummyInput('NAME').appendField(new Blockly.FieldTextInput('x'), 'NAME')
        this.setOutput(true)
        this.setStyle(STYLE.op)
        this.setTooltip('取结构体字段')
      },
    },

    [BLOCK.index]: {
      init(this: Blockly.BlockSvg) {
        this.appendValueInput('ARR').setCheck(null)
        this.appendDummyInput('IDX').appendField('[', 'LBL_OPEN')
        this.appendValueInput('INDEX').setCheck(null)
        this.appendDummyInput('IDX2').appendField(']', 'LBL_CLOSE')
        this.setOutput(true)
        this.setStyle(STYLE.op)
        this.setTooltip('取数组 / 切片元素')
      },
    },

    [BLOCK.array]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('数组', 'LBL_ARRAY')
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
        this.appendStatementInput('ARGS')
        this.setOutput(true)
        this.setStyle(STYLE.func)
        this.setTooltip('调用模块里的函数（import 之后才能用）')
      },
    },

    [BLOCK.arg]: {
      init(this: Blockly.BlockSvg) {
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
          .appendField(
            new Blockly.FieldDropdown(
              [
                ['%d\\n', '%d\\n'],
                ['%d', '%d'],
                ['%s\\n', '%s\\n'],
                ['%x\\n', '%x\\n'],
              ],
            ),
            'FMT',
          )
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
        this.appendStatementInput('THEN')
        this.appendStatementInput('ELSE')
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.control)
      },
    },

    [BLOCK.while]: {
      init(this: Blockly.BlockSvg) {
        this.appendDummyInput('HDR').appendField('while', 'LBL_WHILE')
        this.appendValueInput('COND').setCheck(null)
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
          .appendField(new Blockly.FieldTextInput('i32'), 'RET')
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
          .appendField(new Blockly.FieldTextInput('i32'), 'TYPE')
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
          .appendField(new Blockly.FieldTextInput('i32'), 'TYPE')
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
          .appendField(new Blockly.FieldTextInput(''), 'TYPE')
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
        this.appendStatementInput('ARMS')
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
          .appendField(new Blockly.FieldTextInput('i32'), 'TYPE')
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
        this.appendStatementInput('THEN')
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
        this.appendStatementInput('ARMS')
        this.setOutput(true)
        this.setStyle(STYLE.control)
        this.setTooltip('match 表达式 —— 产出值')
      },
    },

    [BLOCK.exprStmt]: {
      init(this: Blockly.BlockSvg) {
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
        this.setPreviousStatement(true)
        this.setNextStatement(true)
        this.setStyle(STYLE.text)
        this.setTooltip(
          '块子集表达不了的语法 —— 原样保留，不会丢。' +
            '换行写成 \\n，反斜杠写成 \\\\。',
        )
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
      cat('变量', CATEGORY_COLOUR.var, [BLOCK.let, BLOCK.set, BLOCK.variable, BLOCK.value]),
      cat('运算', CATEGORY_COLOUR.op, [
        BLOCK.binop,
        BLOCK.unop,
        BLOCK.cast,
        BLOCK.field,
        BLOCK.index,
        BLOCK.array,
      ]),
      cat('控制流', CATEGORY_COLOUR.control, [
        BLOCK.if,
        BLOCK.while,
        BLOCK.for,
        BLOCK.break,
        BLOCK.continue,
        BLOCK.match,
      ]),
      cat('函数', CATEGORY_COLOUR.func, [
        BLOCK.func,
        BLOCK.call,
        BLOCK.qualifiedCall,
        BLOCK.print,
      ]),
      cat('类型', CATEGORY_COLOUR.type, [
        BLOCK.structDef,
        BLOCK.enumDef,
        BLOCK.structLit,
        BLOCK.enumVariant,
        BLOCK.typedef,
        BLOCK.import,
      ]),
      cat('原始代码', CATEGORY_COLOUR.text, [BLOCK.opaque]),
    ],
  }
}

export { CATEGORY_COLOUR, STYLE, TYPE_CHOICES }
