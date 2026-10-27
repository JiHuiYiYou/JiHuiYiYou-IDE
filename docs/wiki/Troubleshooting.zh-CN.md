# 疑难排查

## 编译器

### 「找不到编译器」/ 问题面板一直空

IDE 需要 `jhyy.exe`，查找顺序：IDE 设置里的路径 → 环境变量 `JHY_EXE` →
`../JiHuiYiYou/compiler/build/bin/jhyy.exe` → `C:\Program Files\JHYY\bin\jhyy.exe` →
`PATH` 上的 `jhyy.exe`。

最快的办法是把[编译器仓库](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler)
clone 成 IDE 仓库的**兄弟目录**：

```
coding/
├── JiHuiYiYou/          ← 编译器仓库
└── JiHuiYiYou-IDE/      ← 本仓库
```

### 「gcc link failed」—— 而且一句错都没有

编译器靠 `gcc` 链接，要的是**真正的 MSYS2 UCRT64 gcc**：

- 装 MSYS2 以及 `mingw-w64-ucrt-x86_64-gcc` + `mingw-w64-ucrt-x86_64-binutils`。
- **千万别用** Git Bash 自带的 MinGW gcc
  （`C:\Program Files\Git\mingw64\bin\gcc.exe`）—— 它链不了 PE，而且**静默**失败
  （退出码 1，零字节输出）。
- `gcc` 必须以 **Windows 风格路径**能找到。只含 MSYS 风格条目
  （`/c/msys64/ucrt64/bin`）的 PATH，编译器内部 spawn 的 `cmd.exe` 不认。

### 编译器在我项目里拉了一堆垃圾

IDE 不会 —— 但它确实需要一个**可写的当前目录**，因为编译器的跨阶段临时文件走的是
**相对 CWD** 的路径（`compiler/build/obj/…`），而编译器自己不会建那个目录。
IDE 给它的是系统临时目录下的一个 scratch 目录。你要是手动在只读目录里跑
`jhyy.exe`，看到的就是这个。

## 诊断

### 问题面板里位置是空的

编译器的诊断是 stderr 上的自由文本：

```
C:\path\to\file.jhyy:12:8: error: type mismatch in let
```

正则必须**盘符感知**（`^(.*):(\d+):(\d+):`）。语言仓库 MCP server 用的
`^([^:]+):` 跨不过 `C:` 里的冒号 —— 位置会**静默**丢成空。

### 只显示一条错误

编译器**没有错误恢复**：解析器和语义分析器都在第一个错误处 bail。一次编译 ⇒
一条诊断。改掉再编。

### 编译器的进度信息混进输出了

编译成功时 stderr 也有进度噪声（`[1] imports start`、`[4] codegen done` …）。
IDE 把它们滤掉了 —— 你手动跑 `jhyy.exe` 时看到是正常的。

## 块视图

### 块是空的 / 什么都不画

Blockly 的 `workspace.render()` 只是**排队**等下一个动画帧才画，窗口没焦点时什么都不画。
IDE 用 `Blockly.renderManagement.triggerQueuedRenders(workspace)` 强制刷。

### 块接不上

Blockly 13 里 `setNextStatement(true)` **不再建** previousConnection。
语句块必须同时调 `setPreviousStatement(true)`。而且 `<statement>` 容器装的是
**一条链** —— 连着放好几个块意味着要吐 `<next>` 元素。

### 不透明块的源码丢了

每个字段都要**显式给名字**。Blockly 的 `getField('CODE')` 对没名字的字段返回 `null`，
逃生舱的载荷跟着一起丢。

### 文本视图改了，块却没动

这是设计如此：块是**切到块视图时**才重建，不是每敲一个键就重建（每键重建画布没法用）。
切一次视图就追上来了。

## Claude Code

工具权限和 MCP 的问题见 [Claude Code](Claude-Code.zh-CN#疑难)。

## 安装

### Windows SmartScreen 拦安装包

安装包**没有代码签名**。选"更多信息 → 仍要运行"。

### IDE 打开了，但每次编译都失败

九成是 gcc 不对或没有 —— 看这一页最上面。
