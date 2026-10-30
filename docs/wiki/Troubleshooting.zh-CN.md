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

## 终端

### 终端是空的 / shell 根本没起来

终端是**懒启动**的：只有第一次切到**终端**页签才会拉起 shell 进程。页签一直空白的话，
看面板右边的动作按钮 —— 没有错误弹窗。最常见的原因是 shell 不在 IDE 以为的地方：
MSYS2 的 bash 在 `C:\msys64\usr\bin\bash.exe`（`ucrt64` 那个**不存在**）。

### 退格只移动光标，不删东西

那是 PowerShell 的锅。**管道下，PowerShell 的行编辑器（PSReadLine）是坏的** ——
它会把退格字节原样吐回，而行首一个退格甚至能把整个 shell 卡死。
所以 IDE **默认用 MSYS2 的 bash** —— 它的 readline 在管道下有真正的行编辑：
退格会真的擦掉、方向键能移动、历史能翻，而且**你看得见自己打的字**。

如果把终端切到 PowerShell，退格发的是 `BS (0x08)` 而不是 xterm.js 默认的
`DEL (0x7f)` —— PowerShell 认的是前者。

### 程序的输出被当命令执行了

不会再有了。IDE 以前把程序的 stdout 写进了 shell 的 **stdin**（那是*输入*）。
现在输出只进显示层。

### `vim` / `top` 这类全屏程序跑不了

终端跑的是**管道，不是 PTY**。没有 PTY，子进程不觉得自己在终端上，
所以那些要接管屏幕的程序会拒绝运行。

按行走的都没问题 —— `dir`、`gcc --version`、`jhyy run foo.jhyy`、管道、重定向都行。

要真 PTY 就得装 `node-pty`，而它给 Electron 编译需要 C++ 工具链。
这台机器没有 MSVC，所以 IDE 不依赖它。

### 终端里的中文输出是乱码

不该乱码 —— IDE 启动 shell 时会强制设 UTF-8，`cmd` 那边还会探测 OEM 代码页。
要是**终端**里看到乱码，先确认你不是在看一个 `cmd` 会话（它的系统消息走 OEM 代码页）。

（**输出面板**里的乱码是另一回事 —— 见下。）

### IDE 跑完程序后，终端不显示提示符了

少的就是 `user@host ~/dir` 那一行。IDE 跑命令时只是把命令**回显**到终端
（像 VS Code 的任务终端），而 shell 自己并不知道命令跑完了 —— 所以它不再打提示符。

现在 IDE 跑完命令后往 shell 的 **stdin** 发一个空行，**shell 自己**会把提示符打出来
（各家 shell 的提示符格式和转义序列都不一样，IDE 自己画必然对不上）。
⚠️ 你**正在敲命令**的时候 IDE 不会发 —— 那会把半截命令执行掉。

### 程序不等输入就跑过去了 —— `scanf` 读不到东西

以前 IDE 给程序接的是**空设备**（stdin 直接是 EOF）⇒ 任何读 stdin 的程序
一上来就拿到 EOF ⇒ `scanf` 直接返回、程序接着往下跑。

现在跑程序时 IDE **接管一根管道**，并把**你在终端里敲的字喂给程序** ✓
（跟 VS Code 的「在终端里运行」一个意思）—— 切到**终端**页签敲下回车，
程序就收到了 ✓。

⚠️ 字要敲在**终端**页签里（不是「输出」页 —— 那是只读的程序输出）。
敲进去的字会**回显**在终端里 —— 程序从管道读 stdin，它自己**没有 TTY、不会回显**，
不回显的话看着就像「还是坏的」。
程序跑满 60 秒还没结束会被**超时杀掉**（等输入得给用户时间打字）；
疯狂打印的那种由**输出上限**（512 KB）秒杀 ✓。

## 窗口和外壳

### `Ctrl+C` / `Ctrl+V` / `Ctrl+Z` 没反应，或者 `F5` 把窗口重载了

那是 Electron 的**默认应用菜单**抢了 accelerator。IDE 在主进程里调
`Menu.setApplicationMenu(null)` 正是为了这个 —— 哪天把那行删了，
`F5` 就会重载整个 IDE，`Ctrl+C` 也会失灵。

### 窗口没有标题栏 / 按钮位置不对

窗口**故意没有原生边框**（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：
标题栏是 IDE 自己画的，系统把最小化/最大化/关闭按钮画在它上面。
标题栏右边特意留了 ~138px 给它们。

### 编辑器打不了字 —— 看着像只读的

界面完全正常（能选中、能滚动、光标在那儿），但**一个字都打不进去**。

这是 CodeMirror 的 `indentOnInput()` 扩展在**抛异常**：它是个**事务过滤器**，
每次输入都跑 `rules.some(r => r.test(lineStart))`；而语言数据里的
`indentOnInput` 要是写成了 `true`（而不是**正则表达式**），`true.test` 就不是函数
⇒ 抛 TypeError ⇒ **整个输入事务被丢掉** ⇒ 字进不去。

规则：`languageData.indentOnInput` **必须是一个正则**（CodeMirror 文档原话：
*which must hold a regular expression*）。`tests/renderer/jhyyLanguage.test.ts`
钉着这条 —— 它直接断言「输入的事务不会抛异常」。

### 同一行里选中的字几乎看不见

两个原因叠在一起：

- **当前行的背景把选区盖住了。** `highlightActiveLine()` 给当前行加的背景是
  **行 div 自己**的 —— 而行 div 在**内容层**里，**画在选区层上面**
  （选区层的 z-index 是 -1）。不透明 ⇒ 当前行的选区被整个盖住。
  IDE 把当前行改成**半透明**了。
- **选区颜色被 CodeMirror 自带的主题盖住了。** `drawSelection()` 把**浏览器原生**的
  选区设成 transparent ⇒ 看得见的选区**只有** CodeMirror 自己画的那一层，
  而它用的是 base theme 的深蓝灰 `#222`/`#233`。IDE 的主色
  `rgba(0, 212, 170, 0.34)` 写了 `!important` 才盖得住。

### 打开 CRLF 的文件就崩（`RangeError: Selection points outside of document`）

CodeMirror 灌字符串时按 `/\r\n?|\n/` 拆行 ⇒ **`\r` 会被丢掉** ⇒
编辑器里的文档**永远是 LF**，而磁盘上的文件可能是 CRLF ⇒ 两边长度对不上 ⇒
选区被算到**文档外面** ⇒ 事务直接抛异常 ⇒ 整个编辑器崩掉。

IDE **读文件时归一化成 LF、存盘时还原原来的行尾** —— 既不崩，
也**不会把你文件的行尾改掉**。

### 「另存为」把整个文件名（连后缀一起）选中了

Windows 的保存对话框会把「文件名」框里的内容**整段选中**（含后缀）⇒ 没法只改基础名。

IDE 现在**只给目录、不给默认名** ⇒ 框是空的 ⇒ 没有「被选中的后缀」✓
（**其它一切不变**：过滤器还在，扩展名照样自动补 —— 填 "hello" ⇒ "hello.jhyy"）。

### 聊天里的历史会话一直是空的

三个原因，都修了：

- `claude --resume` **只是把对话接上，不会把历史消息再吐一遍** ⇒
  历史得由 IDE 自己存、自己还原（现在历史条目里带着整段对话 ✓）。
- 而且以前**用户消息整个被忽略**了 ⇒ 就算 CLI 回吐了也进不了界面。
- sessionId **是 IDE 自己生成的**（`--session-id`），本来根本不用等 CLI 的
  `system/init` 事件 —— CLI 万一没初始化（比如模型名不被它认），那个事件永远不来。

现在：历史条目里带着整段对话（存在 localStorage ✓ 重启还在），
点一下就填回界面 ✓，同时 `--resume` 把 CLI 的上下文接上 ✓。

### 跑 `while true` 那种程序，整个 IDE 卡死

程序在无限打印，而 IDE 在**无上限地拼接**它的输出 ⇒ 内存被吃光 ⇒
机器开始换页 ⇒ 谁都动不了。

现在每个流的输出**有上限**（512 KB），超了**立刻杀掉程序**，并在状态栏说
「程序输出过多，已终止」。输出也是**边跑边显示**的（像 VS Code 的任务终端）。

VS Code 为什么不会卡？因为它跑的是**真 PTY**（Windows 上是 ConPTY）：
伪终端缓冲固定，输出比读快时**写端会阻塞**（程序自己慢下来），
xterm.js 也是边收边渲染、滚动缓冲有上限 ⇒ 内存始终有界。

## 块视图

### 块是空的 / 什么都不画

Blockly 的 `workspace.render()` 只是**排队**等下一个动画帧才画，窗口没焦点时什么都不画。
IDE 用 `Blockly.renderManagement.triggerQueuedRenders(workspace)` 强制刷。

### 块接不上

Blockly 13 里 `setNextStatement(true)` **不再建** previousConnection。
语句块必须同时调 `setPreviousStatement(true)`。而且 `<statement>` 容器装的是
**一条链** —— 连着放好几个块意味着要吐 `<next>` 元素。

### 块视图一打开就崩（`Attempt to connect incompatible types`）

Blockly 里**一个块不能既输出又前后连接**。它灌 XML 时给子块挑连接口的顺序是
**先 output、再 previous**（它分不清 `<statement>` 和 `<value>`）——
所以一个「两种位置都能用」的块（赋值 / if / match / 逃生舱）必须**拆成两个**：
语句形态（`jhyy_set`）和值形态（`jhyy_set_val`）。

反编译器要是把语句形态的块放进**表达式位置**（值输入），或者把两种形态混用，
就会撞上这个错，块视图整个崩掉。
`tests/renderer/blockWorkspace.test.ts` 把**所有样例**都灌一遍，少一个定义就红。

### 不透明块的源码丢了

每个字段都要**显式给名字**。Blockly 的 `getField('CODE')` 对没名字的字段返回 `null`，
逃生舱的载荷跟着一起丢。

### 文本视图改了，块却没动

这是设计如此：块是**切到块视图时**才重建，不是每敲一个键就重建（每键重建画布没法用）。
切一次视图就追上来了。块过期的时候 🧩 按钮上会冒个小圆点。

### 布局一变，块画布就空了 / 尺寸不对

这里有两个坑：

- **Blockly 13 没有 `ResizeObserver`。** 它只在*窗口*变尺寸时重新量。
  应用内部的布局变化（折叠聊天侧栏、打开面板、切视图）都会让画布尺寸过期 ——
  所以 IDE 自己盯着容器，调 `Blockly.svgResize(workspace)`。
- **千万别用 `display: none` 藏块面板。** `svgResize` 读的是容器的 `offsetWidth`，
  藏起来就是 0，画布会变成 0×0。IDE 改用 `visibility: hidden` + `inert` ——
  布局盒子还在。

### 动了块，源码自己变了

不该变 —— 但以前会，原因值得知道：从 XML 把块读回来时用的是 `querySelector`，
它搜的是**所有后代**。嵌套的同名输入会**遮蔽**外层的那个，
于是 `fib(n - 1) + fib(n - 2)` 读回来变成了 `fib(n - 1) + 1`。
现在每次查找都只认直接子节点（`:scope >`），`tests/renderer/blockXml.test.ts` 钉住了这条。

## Claude Code

工具权限和 MCP 的问题见 [Claude Code](Claude-Code.zh-CN#疑难)。

## 安装

### Windows SmartScreen 拦安装包

安装包**没有代码签名**。选"更多信息 → 仍要运行"。

### IDE 打开了，但每次编译都失败

九成是 gcc 不对或没有 —— 看这一页最上面。
