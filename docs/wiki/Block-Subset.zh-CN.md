# 块子集

块视图覆盖 JHYY 的**入门**部分。其余部分照样能用 —— 只是它们待在一个
**不透明块（opaque block）**里，块里装着原始源码文本。

## 哪些语法有块

| 类别 | 块 |
|---|---|
| 变量 | `let`（带 `mut` 和可选类型标注）、赋值 |
| 字面量 | 数字、字符串、字符、布尔、数组字面量 |
| 运算符 | `+ - * / %`、`== != < > <= >=`、`&& \|\|`、`& \| ^ << >>`、一元 `- ! ~`、转换（`as`） |
| 取值 | 字段访问、下标 |
| 调用 | 普通调用、`module::function` 调用 |
| 控制流 | `if` / `else`、`while`、`for i in a..b`、`return`、`break`、`continue` |
| 声明 | 函数（带参数）、结构体（带字段）、枚举（带变体）、`type` 别名、`import` |
| 模式 | `match`，支持字面量 / 区间 / 枚举变体 / 通配 |
| 输出 | `printf` |

块目录在 `src/lang/blocks/tree.ts`（`BLOCK`、`BLOCK_FIELDS`、`BLOCK_INPUTS`、
`BLOCK_STATEMENTS`）—— 那个文件是「一个块是什么、它有哪些字段」的**唯一真相**。

### 同一件事的两种形态

在 Blockly 里，一个块不能既是值块（有输出连接）又是语句块（有前后连接）。
而 JHYY 里调用、赋值、`if`、`match` 在**两种位置**都能出现 —— 所以每种都做了两个：

| 值形态 | 语句形态 |
|---|---|
| `jhyy_call` | `jhyy_call_stmt` |
| `jhyy_qcall` | `jhyy_qcall_stmt` |
| `jhyy_set_val` | `jhyy_set` |
| `jhyy_if_val` | `jhyy_if` |
| `jhyy_match_val` | `jhyy_match` |

`jhyy_expr_stmt` 把语句位置上的值表达式包一层（求值，结果丢掉）。

## 什么是逃生舱

块子集表达不了的任何东西都会变成一个**不透明块**：一个块，载荷是那棵子树的原始源码。

覆盖的东西包括：

- 泛型与 turbofish（`max::<i32>(…)`）、泛型结构体与泛型函数
- 闭包
- 指针、引用、借用、切片
- `defer`、`asm!`、属性（`#[inline]`、`#[no_std]` …）
- 类型位置上的 `Cap<T>` / `PhantomData<T>`
- `sizeof` / `alignof`、`null`、`volatile`

载荷**无损**往返：不透明块存的是那段源码的精确切片（换行和反斜杠都转义过），
打印回文本时**逐字节**还原。只要你不动那个不透明块，那部分代码就不会变。

需要退化成不透明块时 IDE 会告诉你 —— 你绝不会悄悄丢代码。

## 加一个新块

1. **`src/lang/blocks/tree.ts`** —— 在 `BLOCK` 里加类型名，并登记它的字段
   （`BLOCK_FIELDS`）、输入（`BLOCK_INPUTS`）、语句容器（`BLOCK_STATEMENTS`）。
2. **`src/renderer/blocks/definitions.ts`** —— 写块定义（`init()`）。
3. **`src/lang/blocks/decompile.ts`** —— 让反编译器能从 AST 产出它。
4. **`src/lang/blocks/compile.ts`** —— 让编译器能把它编回 AST。
5. **`src/renderer/blocks/definitions.ts`** —— 放进 `buildToolbox()`。
6. **`npm test`** —— 一致性门必须还是绿的。
7. 更新仓库里的
   [`docs/blocks-subset.md`](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/blob/main/docs/blocks-subset.md)。

两条反复咬人的规矩：

- **一个块不能既是值块又是语句块。** 两种位置都要用就做两个块（见上面的表）。
- **每个字段都要显式给名字。** Blockly 的 `getField('CODE')` 对没名字的字段返回
  `null` —— 不透明块的源码载荷会跟着丢。

## Blockly 13 的坑

要动块这一层的话，这几个是真的费时间：

- `setNextStatement(true)` **不再建** previousConnection。语句块必须显式调
  `setPreviousStatement(true)`，不然什么都接不进容器。
- `<statement>` 容器装的是**一条链**：放好几个块意味着要吐 `<next>` 元素，
  不是塞好几个子节点。
- `workspace.render()` 只是**排队**（下一个动画帧才画）。窗口没焦点时什么都不画 ——
  调 `Blockly.renderManagement.triggerQueuedRenders(workspace)` 强制刷。
- 受支持的加载路径是 **XML**（`Blockly.Xml.domToWorkspace` / `workspaceToDom`），
  不是手动 `newBlock` + `connect`。
