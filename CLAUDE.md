# CLAUDE.md

JHYY IDE —— 给 **JHYY（机会翼游）** 做的桌面 IDE。

> **这个文件是索引**：要改哪一块 ⇒ 去「参考」那一栏点进去。
> 细节**不写在这里**（那是那些专门文档的活）。

## 这是什么

一个 Electron 桌面应用，**VS Code 式的工作台**：

1. **正常写代码**（CodeMirror 6）—— 承担完整语言能力
2. **拖块编程**（Blockly）—— 入门友好。**独占整个编辑区**，跟代码编辑器**不同时显示**
   （`Ctrl+Shift+B` 切）
3. **内嵌 Claude Code 对话**（右侧栏）—— 直接对话本机的 `claude` CLI，能读写项目文件
4. **底部面板** —— 问题 / 终端。**默认隐藏**，点「检查」或「运行」才弹出来
   （**没有「输出」页签** —— 编译器和程序的输出都进终端，跟 VS Code 一个路子）

外壳照着 VS Code 抄：自绘标题栏（菜单栏 / 命令中心 / 布局开关）、命令面板、状态栏、
一整套快捷键。**菜单、命令面板、快捷键从同一张命令表生成**（`src/renderer/commands/`）。

## 工作规约（家族共用，先读）

本机（**不入仓**）有一份家族共用的工作规约：**`../WORKING-RULES.md`** ——
机会翼游家族**四个仓共用这一份**（编译器 / IDE / OS / for-VEX）。
**动手前先读它。** 本仓 `.claude/working-rules.md` 是指向它的指针
（别在那儿改内容 —— 改那一处，四个仓同时生效）。

## 三条铁律

### ① AST 是唯一的真相

块视图和文本视图**共用同一个 AST** ⇒ 同一个文件永远不会产生两种输出。
`src/lang/` 是**纯 TypeScript**（零 Electron / 零 Node / 零 Blockly 依赖）⇒
能在 Node 里跑单测。**不要在两边各写一套代码生成逻辑**。

### ② 打印出来的代码必须能被真实编译器接受

`jhyy.exe` 是唯一的裁判。任何改动 `src/lang/` 之后必须跑 `npm test`
（含 278 个真实编译器的往返验证）。语料口径跟上游一致（`_` 开头的文件不进语料）。

### ③ 语言规则以编译器为准，不是以文档为准

规范在语言仓库 `../JiHuiYiYou/docs/abis/jhyy-lang-spec-v4.0.0.md`，
编译器在 `../JiHuiYiYou/compiler/src0/`。最容易踩的几条：

| 规则 | 说明 |
|---|---|
| 入口是 `fn main_jhyy() -> i32` | **不是 `main`**（`#[no_std]` 才用 `main`） |
| `type X = struct {...}` 结尾**不能**带 `;` | 带了就报 `unexpected token ';' in expression` |
| `import vec;` | 模块名**不带** `std::` 前缀 |
| 整数 ↔ 浮点**不能**隐式转换 | 必须写 `as` |
| `if/else` 是表达式 | 分支体是表达式不是语句块 |
| `match` 的区间是**闭**区间，`for` 的是**半开** | 方向相反，容易搞错 |
| 切片区间**没有开区间** | `a[1..]` 编译器拒绝 ⇒ `SliceRangeNode.rangeEnd` 不是可空的 |
| `&&`/`\|\|` 是短路逻辑，`&`/`\|`/`^` 是位运算 | |
| `as` 的优先级跟 `*` 一样 | 跟大部分语言不同 |
| 参数类型**必须**显式标注 | |
| 闭包不能捕获外层变量 | |
| 没有 `print` 内建 | 用 `extern fn printf(...)` |

## 参考 —— 按需加载

| 主题 | 文件 |
|---|---|
| 架构 · 目录 · 模块职责 | [docs/architecture.md](docs/architecture.md) |
| **实现里的坑**（编译器 / 编辑器 / 块视图 / 终端 / Claude） | [docs/implementation-notes.md](docs/implementation-notes.md) |
| 块子集 —— 哪些语法有块，哪些是逃生舱 | [docs/blocks-subset.md](docs/blocks-subset.md) |
| 用户手册（对外 wiki） | [docs/wiki/Home.zh-CN.md](docs/wiki/Home.zh-CN.md) |

## 命令

```bash
npm run dev          # 开发
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # 测试
npm run conformance  # 只跑一致性测试
npm run dist         # 打 NSIS 安装包
```

## 加一个新块

1. 在 `src/lang/blocks/tree.ts` 的 `BLOCK` 里加类型名，并在 `BLOCK_FIELDS` /
   `BLOCK_INPUTS` / `BLOCK_STATEMENTS` 里登记它的字段/输入/容器。
2. 在 `src/renderer/blocks/definitions.ts` 里加块定义（`init()`）。
3. 在 `src/lang/blocks/decompile.ts` 里把它从 AST 反编译出来。
4. 在 `src/lang/blocks/compile.ts` 里把它编回 AST。
5. 在 `src/renderer/blocks/definitions.ts` 的 `buildToolbox()` 里放进工具箱。
6. 跑 `npm test`。

**别忘了**：一个块不能既是值块（有输出连接）又是语句块（有前后连接）。
两种位置都要用，就做两个变体（见 `jhyy_call` / `jhyy_call_stmt`）。
