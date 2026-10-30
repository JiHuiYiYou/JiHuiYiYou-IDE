# JHYY IDE —— Wiki

**拖块写。写代码。跟 Claude Code 聊。**

[JHYY IDE](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) 是给
[JHYY（机会翼游）](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) 做的桌面 IDE ——
一门自举、静态类型、表达式导向的系统编程语言。

一个**VS Code 式的工作台**：

| 部分 | 是什么 | 给谁用 |
|---|---|---|
| **文本视图** | [CodeMirror 6](https://codemirror.net/) —— 跟任何编辑器一样写代码 | 要完整语言能力的人 |
| **块视图** | [Blockly](https://blockly.google.com/) 工作区 —— 拖块写程序。**独占整个编辑区**，跟文本视图**不同时显示**（`Ctrl+Shift+B`） | 初学者，以及喜欢可视化的人 |
| **Claude Code** | 右侧栏里内嵌你机器上已有的 `claude` CLI | 要一个 AI 结对程序员的人 |
| **底部面板** | 问题 / 输出 / 一个**终端**。默认隐藏 —— 点**检查**或**运行**才弹出来 | 想看编译器说了什么的人 |

外壳照着 VS Code 画：自绘标题栏（菜单栏 / 命令中心 / 布局开关）、
`Ctrl+Shift+P` 的命令面板、状态栏，还有一整套常用快捷键。

## 让这一切成立的那一条规则

> **块视图和文本视图共用一个 AST。**
> 改块，文本跟着变；改文本，切回块视图时块跟着重建。
> 它们不可能对同一份程序有不同理解。

块表达不了的代码（泛型、闭包、指针、借用、切片、`defer`、`asm!`、属性）会变成一个
**不透明块（opaque block）**，里面装着原始源码文本 —— 它绝不会悄悄消失。

而裁判永远是真实编译器：IDE 从不猜程序对不对 —— 它去问 `jhyy.exe`，把编译器自己的
诊断显示给你。

## 页面

| 页面 | 内容 |
|---|---|
| [快速上手](Getting-Started.zh-CN) | 安装、打开文件、跑起来、工作台实战 |
| [架构](Architecture.zh-CN) | 分层、数据流、改哪儿 |
| [块子集](Block-Subset.zh-CN) | 哪些语法有块、什么是逃生舱、怎么加一个新块 |
| [Claude Code](Claude-Code.zh-CN) | 内嵌会话、MCP 接线、权限 |
| [疑难排查](Troubleshooting.zh-CN) | 你真的会撞上的那些坑 |
| [贡献指南](Contributing.zh-CN) | 开发环境、门、约定 |

## 一条命令

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE && npm install && npm run dev
```

你还需要 **JHYY 编译器** —— IDE 会自己找（见[快速上手](Getting-Started.zh-CN#编译器)）。

## 链接

- [仓库](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) ·
  [Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) ·
  [Issues](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/issues)
- [JHYY 编译器](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) ·
  [语言规范](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler/blob/main/docs/abis/jhyy-lang-spec-v4.0.0.md)
- [English](Home)
