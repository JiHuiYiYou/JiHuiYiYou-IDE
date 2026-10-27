<div align="center">

<div><img src="assets/icon-animated.svg" width="96" alt="JHYY 标志"></div>

<div><img src="assets/jhyy-calligraphy.png" width="220" alt="机会翼游 书法 logo"></div>

### JHYY IDE —— 给机会翼游（JHYY）做的桌面 IDE

**拖块写。写代码。跟 Claude Code 聊。**

[![版本](https://img.shields.io/badge/版本-v0.1.0-00d4aa)](CHANGELOG.md)
[![一致性](https://img.shields.io/badge/一致性-277%2F277-success)](tests/conformance)
[![CI](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/actions/workflows/ci.yml)
[![技术栈](https://img.shields.io/badge/技术栈-Electron%20%7C%20Blockly%20%7C%20CodeMirror%206-blue)](#架构)
[![平台](https://img.shields.io/badge/平台-Windows%20x64-lightgrey)](#安装)
[![协议](https://img.shields.io/badge/协议-MIT-blue)](LICENSE)
[![English](https://img.shields.io/badge/lang-English-red)](README.md)

[这是什么](#这是什么) · [安装](#安装) · [快速开始](#快速开始) · [三个视图](#三个视图) · [架构](#架构) · [测试](#测试) · [状态](#状态) · [文档](#文档)

</div>

---

## 这是什么

**JHYY IDE** 是给 [JHYY（机会翼游）](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler)
——一门自举的、静态类型的、表达式导向的系统编程语言 —— 做的桌面 IDE。

三件事并排放在一个窗口里：

1. **块视图**（Blockly）—— 拖块写程序，入门友好
2. **文本视图**（CodeMirror 6）—— 正常写代码，完整语言能力
3. **Claude Code** —— 直接对话你本机已经装好的 `claude` CLI

两个写代码的视图**共用同一个 AST**。改块 → 文本跟着变；改文本 → 块重建。
块表达不了的语法（泛型、闭包、指针）会变成**不透明块**，里面装着原始源码 —— **不会悄悄消失**。

## 安装

**前置条件**：

- **Windows** x64（目前只构建和验证了这一个平台）
- **Node.js** 20+（开发用的是 24）
- **一个 JHYY 编译器** —— IDE 会自动找下面几个：
  - `../JiHuiYiYou/compiler/build/bin/jhyy.exe`（编译器仓库的开发构建）
  - `C:\Program Files\JHYY\bin\jhyy.exe`（官方安装版）
  - `PATH` 上的 `jhyy.exe`
  - 或设 `JHY_EXE` 环境变量

**从源码装**：

```bash
git clone git@github.com:JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE
npm install
npm run dev
```

**发行版**：去 [Releases 页](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases)
拿 `JHYY-IDE-<版本>-x64-setup.exe`。

## 快速开始

```bash
# 开发模式
npm run dev

# 直接带一个文件打开
npx electron . samples/demo.jhyy

# 构建 + 打安装包
npm run build
npm run dist
```

## 三个视图

### 块视图

拖块写程序。块子集覆盖语言日常用的部分：变量、运算、`if`/`else`、`while`、`for`、
函数、结构体、枚举、`match`、`printf`。

其余的 —— 泛型、turbofish、闭包、指针、借用、切片、`defer`、`asm!`、属性 ——
会落进一个**不透明块**，里面是原始源码文本。往返无损：只有**你**动了它，那部分才会变。

边界见 [`docs/blocks-subset.md`](docs/blocks-subset.md)。

### 文本视图

CodeMirror 6 + 手写的 JHYY 语言模式：语法高亮、括号匹配、自动闭合、缩进、
补全（关键字、类型、8 个标准库模块），以及能给出**规范章节号**的悬停提示。

诊断来自**真实编译器** —— IDE 跑 `jhyy.exe` 并解析它的
`file:line:col: error: …` 输出。「检查」一趟 ~185ms（跳过链接）。

### Claude Code

内嵌对话面板，驱动你本机已经装好的 `claude` CLI。走 stdin 的流式模式，
所以多轮对话上下文是连着的。

Claude 拿到了 **jhyy MCP server** —— 它能调 `jhyy_check` 拿到**真实编译器**的诊断，
而不是靠猜。指个文件给它，它会自己编译、自己读报错、自己改对。

## 架构

三个视图，**一个 AST**。块视图和文本视图不可能对同一份程序有不同理解 —— 它们是
同一棵树的两个投影。而裁判永远是真实编译器。

```mermaid
flowchart TB
    file["<b>.jhyy 文件</b><br/>磁盘上"]
    blocks["<b>块视图</b><br/>Blockly 13 工作区<br/>拖块写程序"]
    text["<b>文本视图</b><br/>CodeMirror 6<br/>直接写代码"]
    core["<b>src/lang/ —— 语言核心</b><br/>词法 · 语法 · 打印<br/>块: tree · decompile · compile<br/><i>纯 TypeScript</i>"]
    tree["<b>块树</b><br/>AST 与 Blockly 之间的 IR"]
    adapter["<b>Blockly 适配器</b><br/>块树 ⇄ 工作区 (XML)"]
    main["<b>Electron 主进程</b><br/>编译器 · claude · 文件监听"]
    jhyy["<b>jhyy.exe</b><br/>编译 · 运行"]
    claude["<b>claude CLI</b><br/>stream-json · MCP"]

    file -->|解析| core
    core -->|打印| text
    core -->|反编译| tree
    tree -->|编译回| core
    tree <--> adapter <--> blocks
    blocks -->|重新生成源码| core
    text -->|切回时解析| core
    core -->|诊断| main
    main -->|编译 · 运行| jhyy
    main -->|对话| claude
```

| 层 | 位置 | 干什么 |
|---|---|---|
| 语言核心 | `src/lang/` | 词法 · 语法 · 打印 · 块转换 —— **纯 TypeScript**，不依赖 Electron / Node / Blockly，所以能单测 |
| 块树 | `src/lang/blocks/tree.ts` | AST 与 Blockly 之间的 IR + 块目录（块的唯一真相） |
| 反编译器 / 编译器 | `src/lang/blocks/decompile.ts` / `compile.ts` | AST → 块树 / 块树 → AST |
| Blockly 适配器 | `src/renderer/blocks/adapter.ts` | 块树 ⇄ Blockly 工作区（走 Blockly 的 XML 这条官方路径） |
| 文本编辑器 | `src/renderer/editor/` | CodeMirror 6 + JHYY 语言模式 —— 高亮、补全、悬停、波浪线 |
| 主进程 | `src/main/compiler/`、`src/main/claude/` | 驱动 `jhyy.exe` 和 `claude` CLI；所有特权操作都在这儿 |
| 桥接 | `src/preload/index.ts` | `contextBridge` —— 渲染进程唯一的特权入口（`contextIsolation` 开，`nodeIntegration` 关） |

AST 在 `src/lang/` 里，是**纯 TypeScript** —— 不依赖 Electron / Node / Blockly ——
所以解析器、打印器、块转换器都能在 Node 里跑单测。

两个写代码的视图**走同一个打印器** —— 所以它们不可能对同一份程序有不同理解。
而且 IDE 从不猜程序对不对 —— 它去问 `jhyy.exe`，把编译器自己的诊断显示给你。

## 目录

```
src/
  lang/                ★ 语言核心（纯 TS，可单测）
    token.ts lexer.ts    词法 —— 73 个 token 种类，对齐 compiler/src0/lexer.jhyy
    ast.ts               57 个节点种类，对齐 compiler/src0/ast.jhyy
    parser.ts            递归下降 + Pratt，对齐 compiler/src0/parser.jhyy
    printer.ts           AST → JHYY 源码
    stdlib.ts            8 个标准库模块的 API（补全 / 悬停用）
    spec.ts              语言规范索引（悬停给章节号）
    blocks/              块树 IR + 反编译器 + 编译器
  main/                Electron 主进程（有特权）
    compiler/            定位 / 编译 / 运行 jhyy.exe，解析诊断
    claude/              定位 / 驱动 claude CLI，MCP 配置
    watcher.ts           发现 IDE 外面被改过的文件
  preload/             contextBridge —— 渲染进程碰到主进程的唯一途径
  renderer/            UI
    editor/              CodeMirror 6 + JHYY 语言模式
    blocks/              Blockly 块定义 + 适配器
    panes/               块 / 代码 / 对话 / 输出 / 问题 面板
    sync/                块 ⇄ 文本 同步
  shared/              主 / 渲染 共用的类型
tests/
  lang/                词法 + 语法 + 打印 单测
  blocks/              块往返测试
  compiler/            诊断、NTSTATUS、真实编译器集成
  conformance/         ★ 真实编译器的一致性门（见下）
```

## 测试

IDE 的解析器和打印器必须跟**真实编译器**说同样的话。这靠编译器仓库自己的
277 个示例程序来保证：

| 套件 | 干什么 | 数量 |
|---|---|---|
| `tests/conformance/examples.test.ts` | IDE 解析 → IDE 打印 → **真实 `jhyy.exe` 编译** | 278 |
| `tests/conformance/run.test.ts` | ……然后**真跑一遍**，比对 `// EXPECT:` 指令 | 19（全量：277） |
| 其余 | 单测 | 62 |

语料口径跟语言仓库自己的规则一致：**以 `_` 开头的文件不进语料**
（`mcp-jhyy/jhyy_regress.py:786`、`mcp-jhyy/server.py:453`、
`scripts/dev/audit_test_assertions.py:302` 三处都排除）。那 9 个文件断言的是
**跟机器绑定**的事实 —— 比如 `_jh_gcc_p1.jhyy` 期望 gcc 在
`C:\msys64\ucrt64\bin\gcc.exe`，CI 机器上那个路径压根不存在。

```bash
npm test                                    # 全部 359
npx vitest run tests/conformance            # 只跑一致性
JHY_CONFORMANCE_FULL=1 npx vitest run tests/conformance/run.test.ts   # 全量 277（约 25 分钟）
```

一致性套件需要把编译器仓库 checkout 在**本仓库的兄弟目录** —— CI 就是这么做的，
本地也应该这么放：

```
coding/
├── JiHuiYiYou/          ← 编译器仓库
└── JiHuiYiYou-IDE/      ← 本仓库
```

## 状态

**v0.1.0** —— 首个发行版。见 [`CHANGELOG.md`](CHANGELOG.md)。

| 部分 | 状态 |
|---|---|
| 文本视图 | ✅ 完成 |
| 块视图 | ✅ 完成（入门子集 + 逃生舱） |
| 双向同步 | ✅ 完成 |
| Claude Code 面板 | ✅ 完成 |
| Linux / macOS | ❌ 未构建（目前只有 Windows 工具链） |
| 代码签名 | ❌ 未配置 |

## 路线图

- **给逃生舱那部分做块** —— 泛型、闭包、指针。不是小活。
- **Linux 构建** —— 语言工具链目前是 Windows 优先。
- **LSP** —— 编译器路线图 v4.14 有一个；IDE 会是它的第一个使用者。

## 文档

- **[Wiki](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/wiki)** —— 长文版指南：快速上手、
  架构、块子集、疑难排查、怎么加一个新块
- [`CLAUDE.md`](CLAUDE.md) —— 架构、三条铁律、语言坑、加新块的流程
- [`docs/blocks-subset.md`](docs/blocks-subset.md) —— 哪些语法有块，哪些没有，为什么
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 怎么贡献，CI 的门验的是什么
- [JHYY 语言规范](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler/blob/main/docs/abis/jhyy-lang-spec-v4.0.0.md)
- [JHYY 编译器](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler)

## 协议

[MIT](LICENSE)
