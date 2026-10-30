# CLAUDE.md

JHYY IDE —— 给 **JHYY（机会翼游）** 做的桌面 IDE。

## 这是什么

一个 Electron 桌面应用，**VS Code 式的工作台**：

1. **正常写代码**（CodeMirror 6）—— 承担完整语言能力
2. **拖块编程**（Blockly）—— 入门友好。**独占整个编辑区**，跟代码编辑器**不同时显示**
   （`Ctrl+Shift+B` 切）
3. **内嵌 Claude Code 对话**（右侧栏）—— 直接对话本机的 `claude` CLI，能读写项目文件
4. **底部面板** —— 问题 / 输出 / 终端。**默认隐藏**，点「检查」或「运行」才弹出来

外壳照着 VS Code 抄：自绘标题栏（菜单栏 / 命令中心 / 布局开关）、命令面板、状态栏、
一整套快捷键。**菜单、命令面板、快捷键从同一张命令表生成**（`src/renderer/commands/`）。

## 三条铁律

### ① AST 是唯一的真相

块视图和文本视图**共用同一个 AST**：

```
源码 ──parse──▶ AST ──decompile──▶ 块树 ──▶ Blockly 工作区
                 ▲                                │
                 └──────────── 块树 ◀─────────────┘

块树 ──compile──▶ AST ──print──▶ 源码
```

- `src/lang/` 是**纯 TypeScript**（零 Electron / 零 Node / 零 Blockly 依赖）——
  解析器、打印器、块转换器都能在 Node 里跑单测。
- `src/renderer/blocks/` 只做「块树 ↔ Blockly 工作区」的适配。
- **不要在两边各写一套代码生成逻辑** —— 那样两边迟早对同一份代码产生不同输出。

### ② 打印出来的代码必须能被真实编译器接受

`jhyy.exe` 是唯一的裁判。任何改动 `src/lang/` 之后，必须跑：

```bash
npm test          # 432 个测试，含 278 个真实编译器的往返验证
```

`tests/conformance/examples.test.ts` 会把语言仓库的 **277 个示例**逐个走
「IDE 解析 → IDE 打印 → 真实 `jhyy.exe` 编译」，一个不过就是回归。

> **语料口径跟上游一致**：以 `_` 开头的文件**不进语料**
> （`mcp-jhyy/jhyy_regress.py:786`、`mcp-jhyy/server.py:453`、
> `scripts/dev/audit_test_assertions.py:302` 三处都排除）。
> 那 9 个文件断言的是**跟机器绑定**的事实 —— 比如 `_jh_gcc_p1.jhyy` 期望
> gcc 在 `C:\msys64\ucrt64\bin\gcc.exe`，CI 机器上那个路径压根不存在
> （setup-msys2 装在 `$RUNNER_TEMP\msys64`）⇒ 必假红。
> **别把它们放回来** —— 除非上游也放回来。

`tests/conformance/run.test.ts` 更狠：编译 + **运行** + 比对 `// EXPECT:` 指令。
全量跑（约 25 分钟）：

```bash
JHY_CONFORMANCE_FULL=1 npx vitest run tests/conformance/run.test.ts
```

### ③ 语言规则以编译器为准，不是以文档为准

JHYY 的编译器在 `../JiHuiYiYou/compiler/src0/`（**用 JHYY 自己写的**，自举）。
规范在 `../JiHuiYiYou/docs/abis/jhyy-lang-spec-v4.0.0.md`。

几条容易踩的：

| 规则 | 说明 |
|---|---|
| 入口是 `fn main_jhyy() -> i32` | **不是 `main`**（`#[no_std]` 才用 `main`） |
| `type X = struct {...}` 结尾**不能**带 `;` | 带了就报 `unexpected token ';' in expression` |
| `import vec;` | 模块名**不带** `std::` 前缀 |
| 整数 ↔ 浮点**不能**隐式转换 | 必须写 `as` |
| `if/else` 是表达式 | 分支体是表达式不是语句块 |
| `match` 的区间是**闭**区间，`for` 的是**半开** | 方向相反，容易搞错 |
| `&&`/`\|\|` 是短路逻辑，`&`/`\|`/`^` 是位运算 | |
| `as` 的优先级跟 `*` 一样 | 跟大部分语言不同 |
| 参数类型**必须**显式标注 | |
| 闭包不能捕获外层变量 | |
| 没有 `print` 内建 | 用 `extern fn printf(...)` |

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
    terminal.ts        终端会话（管道上的 shell）
    watcher.ts         监听外部改动
  preload/             contextBridge 窄接口
  renderer/            UI
    workbench/         标题栏 · 菜单栏 · 命令面板 · 面板 · 状态栏
    commands/          ★ 命令表（菜单 + 命令面板 + 快捷键共用一份）
    editor/            CodeMirror 6 + JHYY 语言模式
    blocks/            Blockly 块定义 + 适配器（+ 纯 DOM 的 xml.ts）
    panes/             各个面板（代码 / 块 / 对话 / 输出 / 问题 / 终端）
    state/             布局状态（存 localStorage）
    sync/              块 ↔ 文本同步
  shared/              主/渲染共用的类型
```

## 命令

```bash
npm run dev          # 开发
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # 测试（432 个）
npm run conformance  # 只跑一致性测试
npm run dist         # 打 NSIS 安装包
npx vite-node scripts/claude-smoke.ts   # Claude 集成冒烟（会消耗 API 额度）
```

## 几处反直觉的实现细节

- **`jhyy run` 不捕获 stdout**（只管道 stderr，stdout/stdin 直接继承）。
  所以 IDE 是 `jhyy compile` + **自己 spawn 产物**。
- **编译器的诊断是自由文本** stderr（`file:line:col: error: msg`），
  只有 3 个带编号的错误码。正则必须**盘符感知**（`^(.*):(\d+):(\d+):`），
  否则 Windows 绝对路径会被解析失败。
- **编译器成功时 stderr 也有进度噪声**（`[1] imports start` 等）—— 要滤掉。
- **编译器会给 `--no-link` 回执一行**
  （`compile: --no-link set, skipping gcc link (.s kept at ...)`）——
  它是**编译器有意打的**（`compiler/src0/main.jhyy:1644`），不是它坏了；
  但 `--no-link` 是 **IDE 自己**传的，而且 `.s kept at` 指的是 **IDE 自己的临时目录**
  ⇒ 对用户是纯噪声，IDE 这边要滤掉。完整 stderr 仍在 `CompileResult.stderr` 里，
  一致性门匹配 EXPECT-ERROR 靠的就是它。
- **编译器没有错误恢复**，第一个错就 bail —— 所以每次编译只有一条诊断。
- **编译器的跨阶段临时文件走相对 CWD 的路径**（`compiler/build/obj/…`），
  而它**不会自己创建那个目录** —— IDE 得给编译器一个可写的 CWD。
- **子进程的 PATH 只「追加」，绝不「替换」**（语言仓库 W-156 的教训）：
  继承来的 PATH 一个字都不能丢 —— CI 上 setup-msys2 把 MSYS2 装在
  `$RUNNER_TEMP\msys64`，整个替换掉 ⇒ windres 找不到 ⇒ 几百个测试全挂。
  见 `src/main/compiler/env.ts`。
- **CodeMirror 6 自己一个 `user-select` 都不设** —— 它靠继承。
  所以 `body { user-select: none }` 会一路继承进编辑器的 contenteditable：
  **选不中、不能编辑、光标不走**（看着跟只读模式一模一样）。
  「界面不可选中」要**逐个外壳元素**地写，别写在 body 上。
  `tests/renderer/styles.test.ts` 钉着这条。
- **CodeMirror 的文档里永远是 LF** —— 它灌字符串时按 `/\r\n?|\n/` 拆行，
  **`\r` 会被丢掉**。而磁盘上的文件可能是 CRLF ⇒ 两边长度对不上 ⇒
  选区被算到**文档外面** ⇒ **"RangeError: Selection points outside of document"**
  ⇒ 整个 `<CodePane>` 崩掉（用户报过）。
  ⇒ **读文件时归一化成 LF**（`normalizeEol`），**存盘时还原原来的行尾**
  （`detectEol` / `toEol`）—— 既不崩，也不改用户的行尾。
- **选区有两层，高的那层会盖住低的那层** ——
  ① `drawSelection()` 把**浏览器原生**的选区设成 transparent ⇒ 看得见的选区
  **只有** CodeMirror 自己画的那一层（`.cm-selectionLayer`，z-index **-1**）；
  ② `highlightActiveLine()` 的当前行背景是**行 div 自己**的（内容层里）⇒
  **画在选区层上面** ⇒ 当前行的选区被整个盖住（用户报过两次）。
  ⇒ 当前行背景必须**半透明**；选区颜色要写 `!important`（base theme 的
  `.cm-editor.dark .cm-selectionBackground` 优先级更高）。
- **CodeMirror 的 `indentOnInput` 语言数据必须是「正则」，不能写 `true`** ——
  `indentOnInput()` 是个**事务过滤器**，每次输入都跑
  `rules.some(r => r.test(lineStart))`。写成 `true` ⇒ `true.test` 不是函数
  ⇒ **抛 TypeError** ⇒ **整个事务被丢掉** ⇒ **编辑器里的字打不进去**
  （界面完全正常，只是字进不去 —— 极难查！用户报过「编译器又变成只读的了」，
  就是这一行）。见 `src/renderer/editor/jhyyLanguage.ts` 的 `languageData`，
  `tests/renderer/jhyyLanguage.test.ts` 钉着这条。
- **Blockly 里一个块不能既输出又前后连接** —— 「灌 XML 时给子块挑连接口的顺序」
  是**先 output、再 previous**（它分不清 `<statement>` 和 `<value>`），
  所以一个「两种位置都能用」的块必须**拆成两个**（`jhyy_set` / `jhyy_set_val`）。
  混用 ⇒ **"Attempt to connect incompatible types."** ⇒ 块视图整个崩。
  见 `src/lang/blocks/tree.ts` 的 `BLOCK` 上那段说明。
- **比两棵块树不能直接 `JSON.stringify`** —— 「反编译出来的树」和
  「从工作区读回来的树」在**字段顺序**和**空的 inputs** 上不一样
  （读回来时每个输入名都有一项、没有的是 null）。
  直接比字符串会把同一棵树判成「变了」⇒ 白白重建工作区 ⇒ **视角被重置**，
  而且重建过程冒出来的假事件会把 Blockly 搞崩
  （"The block associated with the block move event could not be found"）。
  用 `src/renderer/blocks/canonical.ts` 的 `canonicalTree`。
- **Blockly 13 里 `setNextStatement(true)` 不再创建 previousConnection**，
  语句块必须显式 `setPreviousStatement(true)`。
- **Blockly 的字段必须显式给名字**，否则会建出空名字的字段，读回来时找不到。
- **Blockly 的 `workspace.render()` 只是排队**（rAF）—— 窗口没焦点时不画，
  要 `Blockly.renderManagement.triggerQueuedRenders()` 强制刷一次。
- **Blockly 13 没有 `ResizeObserver`** —— 它只在 `window resize` 时重新量尺寸。
  应用内部的任何布局变化都会让画布尺寸过期 ⇒ IDE 自己加 RO 调
  `Blockly.svgResize(workspace)`（它才会设 `<svg>` 的宽高；`workspace.resize()` 不会）。
- **藏起来的视图用 `visibility: hidden` + `inert`，不是 `display: none`** ——
  `display:none` 会给 Blockly 一个 0 尺寸的容器（`offsetWidth` 是 0），
  坐标系直接崩。见 `src/renderer/styles.css` 的 `.pane-cell[data-hidden]`。
- **从 XML 读回块时，查找必须用 `:scope >`** —— `querySelector` 搜的是**所有后代**，
  嵌套的同名输入会**遮蔽**外层的那个：`fib(n-1) + fib(n-2)` 里的 `fib(n-2)`
  会被读成 `1`，**用户的源码被悄悄改掉**。见 `src/renderer/blocks/xml.ts`。
- **Electron 默认应用菜单的 accelerator 会在渲染进程看到按键之前就被吃掉**
  （`F5`/`Ctrl+R` 重载、`Ctrl+W` 关窗、`Ctrl+C/V/Z/A`）⇒ 主进程**必须**
  `Menu.setApplicationMenu(null)`。菜单是我们自己在渲染进程画的。
- **窗口没有原生边框**（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：
  标题栏自己画，右侧要留 ~138px 给系统窗口按钮；
  `-webkit-app-region: drag` 会**吞掉所有点击**，可交互元素要标 `no-drag`。
- **终端没有 PTY**（这台机器没有 MSVC，`node-pty` 给 Electron 编不出来）⇒
  管道跑 shell，**没有全屏 TUI 程序**；而且**自己做 CRLF 归一**（管道的 echo 里是裸 `\n`）。
  PowerShell 要显式设 `[Console]::OutputEncoding/InputEncoding = UTF8`
  —— 否则 **stderr 是 OEM 代码页（GBK）**，中文报错全是乱码。
- **终端默认用 MSYS2 的 bash，不是 PowerShell** —— 因为 **bash 的 readline 在管道下有
  真正的行编辑**（退格会真的擦掉、方向键能移动、历史能翻、**增量回显**）；
  而 **PowerShell 在管道下没有**：PSReadLine 会把 BS 字节原样吐回，
  **甚至把整个 shell 卡死**（实测：行首一个退格，shell 就不再响应了）。
  没有 MSYS2 才退回 PowerShell（那时退格要发 BS(0x08) 而不是 DEL(0x7f)）。
- **终端里「显示」和「输入」是两条道** —— 程序的输出必须走 `display()`
  （只写显示层）；走 `write()` 会被 shell 当成**输入的命令**执行掉。
- **IDE 跑完命令后要让 shell 重打一遍提示符** —— 否则终端里少
  `user@host ~/dir` 那一行（用户报过）。办法是往 shell 的 **stdin** 发一个空行
  （回车）—— shell 执行完空行会**自己**把提示符打出来（各家 shell 的提示符格式
  和转义序列都不一样，自己画必然对不上）。
  ⚠️ **用户正在敲命令时不能发** —— 那会把半截命令执行掉
  （`TerminalSession` 里记着「当前这一行有没有输入」）。
- **终端的文字复制不出来** —— xterm 默认把 `Ctrl+C` 当 SIGINT 吃掉
  （`preventDefault`），浏览器的原生复制**永远不触发**。
  要用 `attachCustomKeyEventHandler`：有选区时返回 false，把 `Ctrl+C` 让给浏览器。
- **脏标记不要存布尔值** —— 拿「当前内容」跟「上次保存的内容」比（VS Code 的做法），
  撤销回保存点小圆点就自动消失。「块视图已过期」同理。
- **Blockly 的静态标签要用「没有名字」的 `FieldLabel`** ——
  `Field.isSerializable()` 对没有名字的字段返回 false ⇒ 它不会被写进 XML ⇒
  块树一个字节都不变。（给了名字的话，XML 里就多一个字段。）
- **Claude Code 2.1.302 没有 `--max-turns`、也没有 `--permission-prompt-tool`**。
  用 `--max-budget-usd` 和 `--allowedTools` 代替。
- **Claude Code 的 `--system-prompt` 会替换掉内置 system prompt**（工具用法说明会丢）——
  要用 `--append-system-prompt`。
- **Claude 的一轮结束 = `status.turnComplete`**，**不是**「收到带 text 的
  assistant 消息」—— 模型可能先写一段文字、再调工具、再写一段（用户报过
  「ai 没处理完也会标已完成」）。⇒ 折叠「已完成」只发生在 `turnComplete` 时 ✓。
  而且正文要**兜底**用流式增量（有些 CLI 版本只发增量、不发完整消息 ⇒
  只看完整消息会把回答**整个吞掉**）。
- **Claude 会话的 sessionId 是「后到的」** —— 第一条消息是在 `claude.start()`
  返回**之后**才发出去的，而 CLI 的 `system/init` 事件（带 sessionId）**那时候
  还没到**。所以「有消息就存历史」必须**同时等 sessionId**，否则历史一次都存不下来
  （用户报过「即使有 ai 的历史对话，也不会显示出来」）。
  ⚠️ 而且 sessionId **是我们自己生成的**（`--session-id`）⇒ 根本不用等 CLI ——
  CLI 万一没初始化（模型名不被它认之类），那个事件就永远不来 ⇒ 历史永远存不下来。
- **`claude --resume` 不会把历史消息再吐一遍** —— 它只是把对话**接上**。
  ⇒ **历史对话得由 IDE 自己存、自己还原**（`SavedSession.turns` ⇒ localStorage ✓）。
  也**不要** `--replay-user-messages`：它的作用只是「把用户消息再吐回来确认一下」
  （CLI 自己的 help 原文），留着只会让界面多出重复的一轮。
- **抓子进程的输出**必须**有上限** —— 用户报过「运行 `while true` 的程序时整个
  IDE 卡死」。原因是程序无限打印，而我们在**无上限地拼接**输出 ⇒ 内存被吃光 ⇒
  机器开始换页。⇒ 每个流的上限（`MAX_CAPTURE`），超了**立刻杀掉程序**。
  VS Code 不会卡是因为它跑的是**真 PTY**（输出比读快时写端会阻塞）。
- **程序的 stdin 必须接管成管道** —— 默认接的是**空设备** ⇒ 读 stdin 的程序
  立刻拿到 EOF ⇒ `scanf` 直接返回、程序跑过去了（用户报过「scanf 是坏的，
  他根本就不会让我读，直接就跳到后面了」）。
  ⇒ 跑程序时 `stdinPipe: true`，并把 `writeStdin` 接到**终端**上
  （`TerminalSession.setProgramInput`）—— 用户在终端里敲的字就喂给程序 ✓。
  ⚠️ 写 stdin 的能力要在**进程刚起来**时交出去（等 promise resolve 就太晚了 ——
  那时程序已经跑完，scanf 早就 EOF 了）。
  ⚠️⚠️ **但一致性门必须显式 `stdinPipe: false`**（接空设备 = EOF）——
  语料的判据就取 **EOF 路径**（`compiler/tests/examples/input.jhyy` 的注释：
  「regress harness 跑测试时 stdin=subprocess.DEVNULL，所以 `scanf("%d", &x)`
  恒立刻读到 EOF，返回 EOF(-1) 且**不写** x」）⇒ 接管管道的话 `scanf` 一直等
  ⇒ 程序跑到超时被杀 ⇒ stdout 空 ⇒ **门红**（v0.2.1 的 CI 就是这么红的）。
  ⇒ 而且**读 stdin 的例子必须留在默认子集里**（`REPRESENTATIVE`）——
  那次红的时候子集里一个都没有 ⇒ `npm test` 全绿、放出去才炸。
- **Blockly 的字段渲染在「自己那个孔」的前面** —— 所以「运算符放中间」的正确做法是
  **把它挂到右边那个输入上**（`[a] [+] [b]`）；挂左边就变成 `[+] [a] [b]` ✗。
  只有一个孔的块（类型转换 / 取字段）没法把字段排在孔后面 ⇒ 只能两行。
- **Blockly 的 `FieldDropdown` 会拒绝「不在选项里」的值** —— 而且是**静默**的
  （只打一条 console warning，值保留成旧值）⇒ 用户的代码被悄悄改掉。
  所以「类型」「printf 格式串」这种取值空间很大的字段，下拉的选项必须
  **动态带上当前值**（见 `DynamicDropdown`）。
- **磁盘改动要分「内部」和「外部」** —— Claude（IDE 自己的 agent）用 Edit/Write
  改的文件是**内部改动** ⇒ **直接应用到编辑器**；别的程序改的才是**外部改动**
  ⇒ 才提示用户。而且 IDE 自己保存的文件**根本不该报出来**
  —— ⚠️ `fs.watch` 在 Windows 上一次写入可能触发**好几个**事件，
  所以「自己写的」要用**时间戳**记（不能用「一次性的 Set + 第一个事件就删掉」，
  否则第二个事件漏出去 ⇒ 每次保存都误报）。
  见 `src/main/index.ts` 的 `selfWrittenFiles` / `claudeWrittenFiles`。

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
