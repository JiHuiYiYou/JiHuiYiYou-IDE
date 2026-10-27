# Changelog

> **入口**：GitHub Release / 包管理器从这个文件读版本号。
>
> **约定**（跟 [JiHuiYiYou-compiler](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) 一致）：
> 每个 vX.Y 轴只用 **1 个** umbrella changelog（本文件）。vX.Y+.Z 的 ship 往本文件加一节，
> **不**创建 `changelog-vX.Y.Z.md` 之类的独立文件。

## 最新 release

### v0.1.0 — 2026-10-28 — **首个版本：拖块 + 文本 + 内嵌 Claude Code**

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

- **277/277** —— 语言仓库 `compiler/tests/examples/` 的每个例子走
  「IDE 解析 → IDE 打印 → 真实 `jhyy.exe` 编译」通过。
- **277/277** —— 再加上「真跑一遍 + 比对 `// EXPECT:` 指令」也全过。
- 单测合计 **62** 个；`npm test` 全跑 **359** 个，加全量一致性门共 **617** 个。

> **语料口径**：跟语言仓库自己的回归 harness 一致 —— 以 `_` 开头的文件
> **不进语料**（`mcp-jhyy/jhyy_regress.py:786`、`mcp-jhyy/server.py:453`、
> `scripts/dev/audit_test_assertions.py:302` 三处都排除）。那 9 个文件是
> 环境相关 / 需手工准备的（如 `_jh_gcc_p1.jhyy` 断言的是**本机**的
> `C:\msys64\ucrt64\bin\gcc.exe`，CI 上根本不存在 ⇒ 必假红）。

**GitHub 相关**：

- **About** —— 描述、topics（9 个）、homepage 都填好了。
- **Wiki** —— 7 个页面 × 中英双语 = 14 份，正文是**仓库里的文件**
  （`docs/wiki/`），`npm run publish:wiki` 推到 GitHub wiki。
- **Issue 表单 / PR 模板 / SECURITY.md / dependabot** —— 都补齐了。
- **品牌资产** —— logo 延用编译器仓库那套（`assets/`），不再另做一个。
  安装包也换上编译器的 `.ico`（之前是 Electron 默认图标）。
- README 头部与「架构」章节改成跟编译器仓库同款（居中头图 + badge + 导航 +
  mermaid 流程图）。

**已知限制**：

- 只构建和验证了 **Windows x64**。
- 安装包**未做代码签名**（Windows SmartScreen 会拦一下）。
- 块子集不含泛型 / 闭包 / 指针 —— 这些进逃生舱。

## 早期

（还没有更早的版本。）
