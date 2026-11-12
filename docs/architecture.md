# 架构 —— 目录与模块职责

> **CLAUDE.md 是索引**（谁要看哪一块 ⇒ 去哪一页）；这里是那份「索引指向的细节」。

## 目录

```
src/
  lang/                ★ 语言核心（纯 TS，可单测）
    token.ts lexer.ts  词法（对齐 compiler/src0/lexer.jhyy 的 73 个 token）
    ast.ts             57 个节点种类（对齐 compiler/src0/ast.jhyy）
    parser.ts          语法（对齐 compiler/src0/parser.jhyy 的 Pratt 优先级表）
    printer.ts         AST → 源码
    stdlib.ts          8 个标准库模块的 API 表（补全/hover 用）
    spec.ts            语言规范索引（hover 给章节号）
    generated/         ★ 生成的规范索引 JSON —— 由 `npm run gen:spec` 从
                       语言仓库的 docs/abis/jhyy-lang-spec-v4.0.0.md 生成。
                       **提交进仓库**（打包时要带上），改了规范要重新生成。
    blocks/
      tree.ts          块树 IR + 块目录（块定义的唯一真相）
      decompile.ts     AST → 块树
      compile.ts       块树 → AST
  main/                Electron 主进程（特权）
    compiler/          调 jhyy.exe：定位 / 编译 / 运行 / 诊断解析
    claude/            调 claude CLI：定位 / 会话 / MCP 配置
    terminal.ts        终端会话（**一个终端**那一层：输入路由 / 回显 / 提示符 / 换目录）
    terminalRegistry.ts ★ 终端**登记表** —— 管着**多个**终端（VS Code 的模型）
    pty.ts ptyNode.ts ptyPipe.ts ptyFactory.ts   终端后端（真控制台 / 管道）
    shellIntegration.ts  ★ 往 shell 里注入 OSC 633 集成脚本（bash / PowerShell）
    watcher.ts         监听外部改动
  preload/             contextBridge 窄接口
  renderer/            UI
    workbench/         标题栏 · 菜单栏 · 命令面板 · 面板 · 状态栏
    commands/          ★ 命令表（菜单 + 命令面板 + 快捷键共用一份）
    editor/            CodeMirror 6 + JHYY 语言模式
      codemirror.ts   建编辑器 / 建状态（扩展集）
      docStore.ts     ★ 文档仓库 —— 文本**只存在编辑器里**（model ↔ view）
      jhyyLanguage.ts JHYY 的词法（StreamLanguage）
      largeFile.ts    ★ 大文件模式的阈值（纯函数）
      editorCommands.ts 编辑器命令（撤销/重做/查找…）
    blocks/            Blockly 块定义 + 适配器（+ 纯 DOM 的 xml.ts）
    panes/             各个面板（代码 / 块 / 对话 / 输出 / 问题 / 终端）
    state/             布局 / 设置 / 光标 store / 状态栏消息（都存 localStorage）
    sync/              块 ↔ 文本同步
  shared/              主/渲染共用的类型
    shellIntegration.ts  ★ OSC 633 的协议 + 流式解析器（纯 TS，可单测）
```

## 谁负责什么

| 目录 | 干什么 | 能不能依赖别的层 |
|---|---|---|
| `src/lang/` | **语言核心** —— 词法 / 语法 / 打印 / 块树 IR | **零依赖**（无 Electron / Node / Blockly）⇒ 能在纯 Node 里跑单测 ✓ |
| `src/main/` | Electron 主进程 —— 编译器、claude CLI、终端、文件监听 | 能调 OS / 起子进程 |
| `src/preload/` | contextBridge 窄接口 | 只暴露白名单方法 |
| `src/renderer/` | UI —— 工作台外壳、编辑器、块视图、聊天、终端 | 只碰 preload 暴露的 API |
| `src/renderer/editor/` | CodeMirror 6 + JHYY 语言模式 | 纯 TS（可单测）|
| `src/renderer/blocks/` | Blockly 块定义 + 适配器 | 只做「块树 ⇄ 工作区」 |
| `src/shared/` | 主 / 渲染共用的类型与协议 | 纯 TS |

## 数据流

```
源码 ──parse──▶ AST ──decompile──▶ 块树 ──▶ Blockly 工作区
                 ▲                                │
                 └──────────── 块树 ◀─────────────┘

块树 ──compile──▶ AST ──print──▶ 源码
```

**AST 是唯一的真相** —— 两条路共用同一个 AST ⇒ 同一个文件永远不会
产生两种输出 ⇒ 详见 CLAUDE.md 的「三条铁律」。

## 文本住在哪

⚠️ **文本只住在 `src/renderer/editor/docStore.ts` 的 `EditorState` 里** ——
`App` 的 React state 里**没有**文本副本 ⇒ 每敲一个字不用重新物化整份文件
⇒ 详见 [implementation-notes.md](implementation-notes.md) 的「编辑器 / 文件管理」。
