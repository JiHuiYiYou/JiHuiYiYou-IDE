# Changelog

> **入口**：GitHub Release / 包管理器从这个文件读版本号。
>
> **约定**（跟 [JiHuiYiYou-compiler](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) 一致）：
> 每个 vX.Y 轴只用 **1 个** umbrella changelog（本文件）。vX.Y+.Z 的 ship 往本文件加一节，
> **不**创建 `changelog-vX.Y.Z.md` 之类的独立文件。

## 最新 release

### v0.1.0 — 2026-10-27 — **首个版本：拖块 + 文本 + 内嵌 Claude Code**

**Highlights**:

- **三个视图并排**：块视图（Blockly 13）、文本视图（CodeMirror 6）、Claude Code 面板。
- **两个写代码的视图共用一个 AST**（`src/lang/`，纯 TypeScript，零 Electron/Node/Blockly 依赖）。
  改块 → 文本跟着变；改文本 → 切回块视图时重建。
- **逃生舱（不透明块）**：块子集表达不了的语法（泛型、闭包、指针、借用、切片、`defer`、
  `asm!`、属性）原样保留源码文本，往返无损。
- **诊断来自真实编译器**：IDE 跑 `jhyy.exe` 并解析 `file:line:col: error: …`；
  「检查」一趟 ~185ms（`--no-link` 跳过链接）。
- **内嵌 Claude Code**：驱动本机 `claude` CLI 的 stream-json 模式，多轮上下文连续；
  挂上 jhyy MCP server，Claude 能调 `jhyy_check` 拿真实编译错误并自我修正。

**一致性（本次的核心门）**：

- **287/287** —— 语言仓库 `compiler/tests/examples/` 的每个例子走
  「IDE 解析 → IDE 打印 → 真实 `jhyy.exe` 编译」通过。
- **286/286** —— 再加上「真跑一遍 + 比对 `// EXPECT:` 指令」也全过。
- 单测合计 **360** 个全过。

**已知限制**：

- 只构建和验证了 **Windows x64**。
- 安装包**未做代码签名**（Windows SmartScreen 会拦一下）。
- 块子集不含泛型 / 闭包 / 指针 —— 这些进逃生舱。

## 早期

（还没有更早的版本。）
