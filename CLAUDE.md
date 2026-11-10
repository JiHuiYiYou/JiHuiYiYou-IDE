# CLAUDE.md

JHYY IDE —— 给 **JHYY（机会翼游）** 做的桌面 IDE。

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
| 切片区间**没有开区间** | `a[1..]` 编译器拒绝（`unexpected token ']'`）⇒ `SliceRangeNode.rangeEnd` 不是可空的 |
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
- **编译器的输出**别过滤 —— 用户明说「你是不是过滤编译器输出了，其实不用的」
  ⇒ 进度噪声（`[1] imports start`）、`--no-link` 的回执、结尾摘要 ⇒ **原样显示**
  ⇒ 只是**不进「问题」面板**（那不是诊断）✓（`diagnostics.ts` 的 `parseDiagnostics`）
- **编译器会给 `--no-link` 回执一行**
  （`compile: --no-link set, skipping gcc link (.s kept at ...)`）——
  它是**编译器有意打的**（`compiler/src0/main.jhyy:1644`），不是它坏了。
  ⚠️ **以前 IDE 这边把它当噪声滤掉了** ⇒ 用户看不到 ⇒ 用户明说「不用过滤」
  ⇒ 现在**原样显示**（它只是不进「问题」面板）✓
  完整 stderr 仍在 `CompileResult.stderr` 里，一致性门匹配 EXPECT-ERROR 靠的就是它。
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
- ⚠️⚠️ **块视图会**回写**用户的源文件** ⇒ 块树表达不了的东西就**没了** ——
  `onBlockChange` ⇒ `blocksToSource(tree)` ⇒ 直接替换编辑器里的内容 ⇒
  ⇒ **块树是「有损」的**（泛型参数、turbofish 实参、`#[inline]` 属性、
  `for x in slice`、短枚举名的绑定…… 每加一种块能力之前它就多丢一样东西）✗
  ⇒ ⇒ **必须有一道兜底的闸**：`isLosslessForBlocks(source)`（`src/renderer/sync/doc.ts`）
  判「文本视图和块视图**能不能一字不差**」⇒ 不能 ⇒ **不许回写**（状态栏说明原因）✓
  ⇒ ⇒ **回归网**：`tests/blocks/blockVsText.test.ts` ——
  拿语料逐个走「源码 → 块 → 源码」，断言**两条路打印出来的一字不差** ✓
  （这条测试一加，当场抓出 9 个 bug：`for x in slice` 被改成 `..0`、
  短枚举名 `Some(v)` 变成 `Some`（绑定丢了）、字面量的 `KIND` 下拉没用、
  `let x;` 不是合法 JHYY、`defer` 语句凭空消失、泛型参数 / turbofish /
  `#[inline]` / `#[no_std]` 全丢、`else { if }` 与 `else if` 形状不一致）
  ⇒ ⇒ **加块能力时先跑它** ✓
- **块树要承载「块子集表达不了的东西」** —— 泛型参数（`TYPEPARAMS`）、
  turbofish 实参（`TYPEARGS`）、属性（`ATTRS`）、区间/切片（`FORM`）——
  ⇒ 少一个，块视图就会**静悄悄改坏用户的代码** ⇒ 都登记进 `tree.ts` 的
  `BLOCK_FIELDS`（**字段名必须跟 Blockly 那边对上**，否则读回来就没了）✓
  ⇒ 「有值才显示」的字段用 `optionalField()`（`definitions.ts`）——
  ⚠️ **Blockly 13 没有 `Field.setOnChange`** ⇒ 只能**包一层 `setValue`** ✓
  （⚠️ 隐藏的 input 里的字段**照样进 XML** ⇒ 藏起来只是视觉上的 ✓）
- **Electron 默认应用菜单的 accelerator 会在渲染进程看到按键之前就被吃掉**
  （`F5`/`Ctrl+R` 重载、`Ctrl+W` 关窗、`Ctrl+C/V/Z/A`）⇒ 主进程**必须**
  `Menu.setApplicationMenu(null)`。菜单是我们自己在渲染进程画的。
- **窗口没有原生边框**（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：
  标题栏自己画，右侧要留 ~138px 给系统窗口按钮；
  `-webkit-app-region: drag` 会**吞掉所有点击**，可交互元素要标 `no-drag`。
- **终端跑在真 PTY 上**（`node-pty` ⇒ Windows 上就是 ConPTY）⇒
  子进程拿到的是**控制台设备**（`GetFileType(stdout) == 2`）⇒
  `isatty(1)` 是 TRUE ⇒ **全屏 TUI 能跑**、`stty size` 跟终端对得上、
  程序自己写的提示立刻可见 ✓。
  ⚠️ **node-pty 是可选依赖**（原生模块要按 **Electron 的 ABI** 重编 ⇒ 要 MSVC）
  ⇒ 装不上也不能让 `npm install` 失败 ⇒ `postinstall` 跑
  `scripts/prepare-node-pty.mjs`（打三个补丁 + 调 node-gyp；失败就退回管道版）✓。
  ⚠️ **打包时不要让 electron-builder 再重编**（`build.npmRebuild: false`）——
     它会 `@electron/rebuild` 重编 node-pty ⇒ **IDE 正开着的时候那个 .node 是被
     锁着的** ⇒ `EPERM: unlink` ⇒ **打包直接失败**（实测踩过）。
     而正确的二进制 `postinstall` 已经编好了 ⇒ 直接打包即可 ✓。
     （以后加别的原生依赖 ⇒ 得让 electron-builder 重新编 ⇒ 那时再把这条打开。）
  ⚠️ **打包时要排掉两坨**（`build.files`）：
     - `node-pty/prebuilds/`（58 MB）—— 那是**各平台各 ABI** 的预编译产物
       （darwin/win32-arm64/…），Electron 一个都用不上（ABI 不对）。
     - **`release/`**（420 MB！）—— 那是**上一版**打包留下的产物目录（0.1.0 的
       安装包 + 一整份 win-unpacked）⇒ 被 `**/*` 扫进 asar 里了。
       ⚠️ **electron-builder 不读 .gitignore** ⇒ 自定义了 `files` 就得自己排。
     ⇒ 不排的话安装包从 ~90 MB 涨到 ~370 MB（实测）✓。
  ⇒ **终端后端是接口**（`src/main/pty.ts` 的 `PtySession`：spawn/write/
  resize/onData/onExit/kill）⇒ 真控制台版是 `ptyNode.ts`、管道版是 `ptyPipe.ts`、
  `ptyFactory.ts` 按「node-pty 能不能加载」自动挑 ⇒ **上层一行不用改** ✓。
  ⚠️ **测试要显式 `backend: 'pipe'`** —— 否则「装没装 node-pty」会决定
  真控制台自己回显（IDE 就不回显了）⇒ 断言全反。
  ⚠️ **管道版**（兜底）要**自己做 CRLF 归一**（管道的 echo 里是裸 `\n`）；
  PowerShell 还要显式设 `[Console]::OutputEncoding/InputEncoding = UTF8`
  —— 否则 **stderr 是 OEM 代码页（GBK）**，中文报错全是乱码。
- **ConPTY 的代码页默认是系统 OEM（中文机器 = CP936）** ⇒ 程序 printf 出去的
  **UTF-8 字节**会被控制台当成 GBK 解释 ⇒ 中文全变乱码
  （实测「请输入一个数字: 」→「璇疯緭鍏ヤ竴涓鏁瓧」）。
  ⇒ 修在**语言仓库**的 `compiler/runtime/runtime.c`：stdout 是控制台时
  `SetConsoleOutputCP(CP_UTF8)` + `SetConsoleCP(CP_UTF8)`。
  ⚠️ **管道不受影响**（字节原样透传）⇒ IDE 按 UTF-8 解管道 ✓。
- **node-pty 的原生模块是「懒加载」的 ⇒ 启动时必须预热** ——
  `require('node-pty')` **不碰** `build/Release/conpty.node`，**第一次 spawn 时**
  才 require ⇒ 而 **`npm install` 会把那个文件删掉**（node-pty 自己的
  `postinstall` 拿**绝对路径**比 BUILD_FILES（相对文件名）⇒ 比不中 ⇒
  **把 build/Release 整个清空** —— 它的 bug）⇒
  那个窗口里起新终端就失败 ⇒ **静悄悄退回管道版** ⇒
  **「终端一会真一会假」**（用户报过）✓
  ⇒ `ptyNode.ts` 的 `warmUpNodePty()` 在启动时先起一个「马上就退出」的真控制台
  ⇒ 原生模块进 `Module._cache`（按**解析后的绝对路径**做键）⇒
  之后文件被删也不影响 ✓（实测：预热前缓存里没有 `.node`，预热后有了）。
- **终端退化必须是「看得见」的** —— 以前 `createPtySession` 是 `catch {}`
  （静悄悄）⇒ 用户只看到「终端怎么又变假了」⇒ 现在：日志里打原因 +
  **状态栏有个 PTY 徽章**（`PTY` = 真控制台 / `管道` = 兜底）+ tooltip 说怎么办 ✓。
- **cwd 不存在 ⇒ 整个终端退化** —— `CreateProcess` 的 `lpCurrentDirectory`
  不存在 ⇒ 进程起不来 ⇒ node-pty 抛 ⇒ **静悄悄退回管道版** ⇒
  ⇒ `ptyNode.ts` 的 `existingDir()` 在起进程**之前**往上找一个真存在的目录 ✓。
- **`0xC000013A` 不是崩溃，是「用户按了 Ctrl+C」** —— 真控制台里按 Ctrl+C
  会真的杀掉前台进程 ⇒ 它就带着这个码退出 ⇒ 以前它不在 NTSTATUS 表里 ⇒
  显示成 `NTSTATUS_0xC000013A` + `crashed = true` ⇒ IDE 一口咬定「程序崩溃」
  （用户报过「程序崩溃：NTSTATUS0xC000013A 是什么鬼」）⇒
  ⇒ 现在表里有 `CONTROL_C_EXIT`，且 `isControlCExit()` 单独判 ⇒
  状态栏说「**程序已中断**」✓（「停止」按钮杀它也是这个码 ⇒ 同一句话）。
- ⚠️⚠️ **「运行」的程序默认**不要**设超时**（用户报过：「长时间不理它会程序中断，
  我不希望它中断」）—— 那**不是程序自己断的**，是 **IDE 超时把它杀了**：
  超时 ⇒ 杀掉整个 ConPTY ⇒ 前台程序收到 `CTRL_CLOSE_EVENT` ⇒ 退出码
  **也是** `0xC000013A` ⇒ **跟「用户按了 Ctrl+C」一模一样** ⇒
  而超时**没往上传** ⇒ 状态栏只能按退出码判 ⇒ 显示成「程序已中断」⇒
  **看着像程序自己断的** ✗
  ⇒ 现在：**默认不超时**（VS Code 的任务终端就是这样：跑到自己结束，
  或者用户按「停止」）✓；真要超时走 `RunRequest.timeoutMs` ⇒
  而且**超时单独报**（`timedOut` ⇒ 「程序超时，已终止」），**不跟「中断」混** ✓
  ⚠️ 同理 **输出上限别太小** —— 512 KB 的话，一个正常打印表格的程序就被杀了 ⇒
  现在 8 MB（有了**背压**之后，IPC 队列是有界的 ⇒ 这个上限守的是内存）✓
  ⚠️ **那个 8 MB 的上限在 `terminal.ts` 的 `MAX_CAPTURE`** ——
  它守着**主进程攒的两份输出**（`pendingRun.output` / `captured`）⇒
  超了 ⇒ **打断正在跑的程序**（**不能杀 pty** —— 那是用户的 shell！）✗
  （以前这两份缓冲**无上限** ⇒ 疯狂打印 ⇒ 内存被吃光 ⇒ 机器换页 ⇒ 整机卡住 ✗）

- **`CreatePseudoConsole` 要用「命名管道」，不是匿名管道** —— 我们自己写的
  ConPTY 助手（已删，被 node-pty 取代）就是死在这儿：用 `CreatePipe` ⇒
  ConPTY 接不上客户端 ⇒ 孩子的 stdout **永远不是控制台**、渲染通道**一个字节都没有**；
  而 node-pty 用 `CreateNamedPipe` + `ConnectNamedPipe` ⇒ 一次就通 ✓。
  另外 node-pty 的 `CreateProcess` 是 `STARTF_USESTDHANDLES` + **三个 std 句柄都传 NULL**
  + `bInheritHandles = false`（真控制台由 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 接管）。
- **终端的 env 要用「登录 shell」那份** —— IDE 不是从登录 shell 起来的 ⇒
  用户的 `.bashrc`（nvm/rbenv/conda init）全丢 ⇒ 「终端里 node 找不到」。
  ⇒ 启动时**后台**起一个登录 shell 导 `env -0` 缓存住（`src/main/shellEnv.ts`）
  ⇒ 改了 `.bashrc` 要**重启 IDE**。
- **终端输出要攒批** —— 裸 `pty.onData(d => ipc.send(d))` 在 `cat` 大文件时
  会造出成千上万个 IPC 消息 ⇒ 渲染进程消化不完 ⇒ 内存被吃光
  ⇒ `OutputBatcher`（16ms ≈ 一帧）攒一批再发 ✓。
- **程序的 stdout 是管道 ⇒ C 运行时全缓冲** —— stdout 不是控制台时，
  `printf("请输入一个数字: ")` 会一直卡在 4KB 缓冲区里，**程序退出才吐出来**
  （用户报过：「输出在输入之前，却只会在输入之后打印」）。
  ⇒ **两条路都堵上了**：
  1. **语言仓库**的 `compiler/runtime/runtime.c`（每个 JHYY 程序都链它）：
     入口加 `setvbuf(stdout, NULL, _IONBF, 0)` ⇒ **兜底**（输出被重定向到
     文件时也生效）。
  2. **IDE 这边让程序跑在 shell 的那个 pty 里**（见下面那条「程序跑在 shell
     的 pty 里」）⇒ 程序的 stdout 是**控制台设备**（`FILE_TYPE_CHAR`）
     ⇒ CRT **不缓冲**它 ⇒ 提示立刻可见 ✓。
  ⚠️ 我一度以为「ConPTY 救不了这个」（以为 ConPTY 给子进程的仍是管道）——
  **错了**：ConPTY 里的程序**有真控制台**（Windows Terminal 就是这么跑的）✓。
  ⚠️ **无缓冲 ⇒ 一句话会被拆成好几段送过来**（实测「请输入一」/「个数」/「字: 」
  三截）⇒ IDE 这边得**自己攒行**（`src/renderer/sync/output.ts`），
  而且要**批量刷**（不然打印多的程序会把 React 拖死）。
- ⚠️⚠️⚠️ **「运行」在「当前那个活着的终端」里跑** —— 命令**敲进那个 shell 的 stdin**，
  程序是 **shell 的孩子** ⇒ 跑完 **shell 还活着**（提示符回来）⇒ **终端不死** ✓
  ⇒ 而且**不动 `activeId`** ⇒ **可见的终端页签不跳** ✓
  （用户报过：「点运行跳到别的终端」「跑完终端就死了」——两条都解决了 ✓）
  - 以前：程序跑在**自己的** pty 里，输出再**注入**到终端的显示层
    （`TerminalSession.display()`）。
  - **ConPTY 一 resize 就会把整块屏幕重画一遍** —— 实测发的是
    `ESC[H`（光标归位）+ 提示符 + **每行 `ESC[K\r\n`** ⇒
    **屏幕被逐行擦掉重画** ⇒
    **凡是「不在 conhost 屏幕里」的内容（= 注入的程序输出）全被抹掉**，
    而提示符是 conhost 自己画的 ⇒ **倒是不丢** ✗
    （用户报过：「拖分割线会把程序的输出卡没」「全屏↔下栏也会」——完全对上）
  - ⇒ 现在程序是 **shell 的孩子** ⇒ 输出**就在** conhost 的屏幕里
    ⇒ resize 重画是忠实的 ⇒ **输出不会没** ✓
    （实测：真 ConPTY + PowerShell，跑一个打印 50 行的命令 ⇒ resize 之后
      输出**还在** ✓）
  - ⇒ 顺带三个好处：**stdout 就是控制台**（不缓冲）✓、
    **stdin 就是终端**（`scanf` 读得到）✓、
    **「停止」= 给 shell 发 Ctrl+C**（不用杀进程、不动用户的终端）✓
  - ⚠️ **实现**：`src/main/liveRun.ts` 的 `runInLiveShell()` ⇒
    用 `TerminalSession.runCommand()`（`src/main/terminal.ts`）把命令写进
    **shell 的 stdin** ⇒ 退出码靠 shell 集成的 OSC 633 报回来 ⇒
    见下面「shell 集成」那条。命令序列由 `buildLiveSteps()` 生成。
  - ⚠️⚠️ **每条命令必须单独一行、且是「一条简单命令」** ——
    bash 的 DEBUG trap（它报「这条命令是什么」，OSC 633 的 `E;`）
    **一行只报第一条**（实测 `a && b && c` ⇒ 只报 `E;a`）⇒
    ⇒ 一行里塞 `&&` / `;` / 管道 ⇒ shell 报的 `E;` 里**没有**我们的 match
    ⇒ **永远匹配不上** ⇒ 「运行」永远挂着 ✗
    ⇒ ⇒ 所以「编译」「运行」是**两条命令、两次往返** ✓
  - ⚠️⚠️ **命令必须用 `buildShellCommand(shell, exe, args)` 拼** ——
    - **PowerShell 必须带 `&`**（`'C:\x.exe'` 是字符串不是命令 ⇒ 压根不执行）✗
    - **bash 不能带 `&`**（bash 的 `&` 是**后台算符** ⇒ 编译跑到后台 ⇒
      shell 立刻回提示符 ⇒ 退出码是假的、产物还没生成就去跑 ⇒ **必错**）✗✗
  - ⚠️⚠️ **cd 那一步必须在 scratch 目录** —— 编译器的跨阶段临时文件走
    **相对 CWD** 的路径（`compiler/build/obj/…`）且**编译器不会自己建那个目录** ⇒
    不然就在用户的项目里凭空造出垃圾 ✓
    ⇒ 「检查」跑完**要 cd 回原目录**（不然 shell 永远停在 scratch 目录）✓
  - ⚠️⚠️ **`state.cwd` 会滞后** —— bash 的 `P;Cwd` 跟 `D;` 是**两次写**
    ⇒ ConPTY 下 `P;Cwd` 可能晚一个 chunk ⇒ ⇒ **别在步骤之间回读它**，
    **自己一路记着** ✓
  - ⚠️⚠️ **输出要先 `stripAnsi`** —— `TerminalRunResult.output` **带 ANSI 颜色**
    ⇒ 不剥的话 `parseDiagnostics` 会把 `\x1b[31m` 吃进 **file** 字段
    ⇒ 「问题」面板里的路径点不开 ✗
  - ⚠️ **用户当前这一行有输入时 ⇒ 先 Ctrl+C 把那行清掉** ——
    不然命令会接在他的半截命令后面（`ls& 'C:\…'`）⇒ shell 报一个莫名其妙的错
    ⇒ 程序根本没跑 ✗ ⇒ **Ctrl+C 不会「执行」那行**（这正是上面那条
    「用户正在敲命令时不能发空行」要防的事）✓
    ⇒ ⚠️⚠️ **但管道版（没真控制台）清不掉**（bash 从管道读行时不做行编辑）
    ⇒ ⇒ 那种情况**退回老路**，别去破坏用户那半截命令 ✓
  - ⚠️⚠️ **「终端正忙」⇒ 退回老路**（`runInLiveShell` 的 pre-flight）——
    **用户自己的命令在跑 / 有半截命令没敲完 / 终端正忙** ⇒
    ⇒ **一个字都不写进用户的终端** ⇒ 直接走老路 ✓
    ⇒ ⚠️ **空闲怎么判** —— bash 报 `C`（命令开始）⇒ `state.idle` 变 false ✓；
    **PowerShell 故意不报 `C`**（CLAUDE.md：劫持 `PSConsoleHostReadLine`
    会把终端搞废）⇒ ⇒ 得靠「**用户提交了一行**」那个状态机
    （`TerminalSession.shellBusy`）✓
    ⇒ ⚠️⚠️ **「IDE 自己发的命令」也要算「忙」** ——
      上面那两个信号**都不覆盖它**（`userCommandRunning` 只记用户的按键；
      `C` PowerShell 不报）⇒ ⇒ **IDE 在 PowerShell 里跑程序时 `shellBusy` 恒为
      false** ⇒ 第二次「运行」把命令敲进还在跑程序的终端 ⇒ 两个运行互相踩
      ⇒ 而且 `runCommand` 会把**上一次**用 `finishRun(null, false)` 收掉
      ⇒ 上一次报一个假的「编译失败」✗✗ ⇒ `ideCommandRunning` 这个标记 ✓
  - ⚠️⚠️ **集成脚本加载失败 ⇒ 静悄悄地没有 OSC** ⇒ 「让 shell 跑命令」
    等不到结果 ⇒ **整个「运行」会挂住** ✗
    ⇒ 所以要能判断「集成**真的起来**了吗」⇒
    `TerminalSession.shellIntegrationReady`（收到过任何 OSC 633）
    ⇒ 等不到就**退回老路** ✓
    ⇒ ⚠️ 用户可以用 `JHY_IDE_NO_SHELL_INTEGRATION=1` 关掉集成 ⇒
    `supportsShellIntegration()` 得认这个环境变量 ✓
  - ⚠️⚠️⚠️ **老路（一次性终端）是「保底」** —— 命令 = **shell 的启动参数**
    （`bash -c "…"` / `powershell -Command "…"`）⇒ **shell 跑完就退出** ⇒
    ⇒ **判完成靠「终端进程退出」**、**退出码就是终端的退出码**
    ⇒ ⇒ **完全不需要 OSC 633** ⇒ 集成挂了也照样能跑 ✓
    ⇒ VS Code：`tasks/browser/terminalTaskSystem.ts:1334`（命令拼进
      `shellLaunchConfig.args`）+ `:971`（用 `terminal.onExit` 收任务）✓
    ⇒ ⚠️ **只有这四种情况才走它**：没有 shell 集成（cmd）/ 集成没起来 /
      终端正忙 / 终端死了 ⇒ ⇒ **正常路径一个一次性终端都不创建**
      ⇒ **终端列表保持干净**（用户抱怨的那个多余的死标签消失）✓
    ⇒ ⚠️ **保底时那个终端要起个能认出来的名字**（「运行」/「检查」）
      ⇒ 用户一看就明白「它换了个终端」⇒ **退化要看得见** ✓
      ⇒ ⚠️ **不写状态栏**（CLAUDE.md：状态栏只显示「坏」的事）✓
  - ⚠️⚠️ **跑命令的终端（保底路径）是「一次性的」，但它**留在终端列表里**、
    下次复用** —— VS Code 的 task 终端：跑完**不关**（输出能看）⇒
    下次跑**把 shell 重启一遍**（`terminalInstance.ts:1902` 的 `reuseTerminal`）⇒
    ⇒ **终端列表不会越攒越多** ✓ 而且「反复运行不新开」保住了 ✓
    ⇒ `TerminalSession.restart()` 重启会话（换 pty、重置 promise/解析器/攒的输出）
    ⇒ 复用时渲染进程要**清屏**（VS Code 也 `clearBuffer()` ⇒ `IPC.terminalRestart`）✓
    ⇒ ⚠️⚠️ **重启时「在等的运行」要先收场** ——
      `runCommand()` 给调用者的 promise **只有 `finishRun` 会 resolve** ⇒
      以前 `restart()` 直接 `pendingRun = null` ⇒ 那个 promise **永远不 settle**
      ⇒ `await session.runCommand(...)` **永远挂住** ✗✗
      （保底那条路的 IPC handler 也在等它 ⇒ 界面一直转圈）✓
    ⇒ 「检查」和「运行」**各用一个终端**（VS Code 也是两个不同的 task ⇒ 两个终端）
      ⇒ 否则点「检查」会把「运行」的输出冲掉 ✗
  - ⚠️ **「补提示符」那个机制整个删了** ——
    它的实现是**往 shell 的 stdin 写一个裸 `\r`** ⇒ 那是一个**真的回车键**
    ⇒ shell 会跑**一整轮额外的提示符** ⇒ **终端里多一个提示符** ✗
    ⇒ 而且那个空行在 **PowerShell** 里会造一条**空的历史记录** ⇒ 报 `D;0`
    ⇒ ⇒ `maybeFinishRun()` 跳过了匹配检查 ⇒ **正在等的那次运行被提前用
      **退出码 0** 收场** ⇒ **程序的真实退出码被报成 0** ✗
    ⇒ ⇒ **shell 的提示符是唯一的提示符**（VS Code 的模型）✓
    ⇒ ⇒ IDE 往终端里写内容时先写 `\n\x1b[G`（VS Code 的 `reuseTerminal` 也这么干）✓
    ⇒ ⇒ **回显**（`echoProgramInput`）**不能走 `display()`**（会加那个前缀 ⇒ 退格擦错位置）✓
  - ⚠️ **裸 `D`（没有退出码的那个）永远不结束一次运行** ——
    bash 的集成脚本里 `D`（无码）=「**这一行没跑过命令**」（空行）⇒
    拿它收场会把正在等的运行提前收掉、退出码报成 `null` ✗
  - ⚠️⚠️ **「停止」在活 shell 那条路上**只发 Ctrl+C、**绝不杀终端** ——
    活 shell 是**用户自己的** ⇒ 杀了 = 毁掉用户的会话（历史、conda、当前目录）✗✗
    ⇒ 只有保底路径（一次性终端）才 `kill()` ✓
  - ⚠️ **终端在跑程序期间死了 ⇒ 「运行」要能收场** ——
    保底路径靠**终端进程退出** ⇒ 终端死了 ⇒ `onExit` ⇒ `exited` resolve ✓
    ⇒ 渲染进程**必须监听 `terminalExit`** ⇒ 把那个终端的 `run` 状态清掉
    ⇒ 否则「运行中」永远亮着（用户报过）✗
    ⇒ ⚠️ **活 shell 那条路终端不会死** ⇒ ⇒ **主进程必须显式置
      `ok`/`failed`**（渲染进程的 `onExit` 只对一次性终端有效）✓
  - ⚠️ **输出爆量（16 MB）⇒ 活 shell 那条路不许杀 pty** ——
    pty 就是用户的 shell ⇒ 杀了 = 毁掉用户的会话 ✗ ⇒ 改成**打断程序** ✓
  - ⚠️ **渲染进程的 `doRun` 必须有 `catch`** ——
    以前只有 `try/finally` ⇒ IPC 一 reject（终端起不来、广播到已销毁的窗口 …）
    ⇒ 异常**逃出去** ⇒ 用户什么都不知道 ✗
- **xterm.js 6 删掉了 canvas 渲染器** —— 核心包里**只剩 DOM 渲染器**，
  而 DOM 渲染器**明确不支持 customGlyphs** ⇒ `─│┌┐└┘` 这种框线字符会走
  浏览器字体回退 ⇒ **字形和宽度都跟 VS Code 不一样**（看着就是「怪」）。
  ⇒ 必须装 **`@xterm/addon-webgl`**（VS Code 的 `gpuAcceleration: auto`
  就是它）⇒ 字形对了、滚动也不飘了。
  ⚠️ **要等容器真的有尺寸才能装**（面板折叠时容器 0×0）⇒ 在 `fit()` 前装。
  ⚠️ **GPU 不可用就退回 DOM**（`loadAddon` 会抛 ⇒ try/catch 掉）。
  ⚠️ `WebglAddon.dispose()` 会把核心的渲染器换回 DOM ✓（context 掉了就退）。
- **xterm 的宽度表是老的 ⇒ 中文会歪** —— 必须装 **`@xterm/addon-unicode11`**
  并设 `term.unicode.activeVersion = '11'` ⇒ 否则**中文/全角/emoji 的列宽
  算不对** ⇒ 中文输出错位、框线接不上（VS Code 装了这个）。
  ⚠️ **必须在任何数据写进来之前装** —— 装晚了已经算过的宽度不会回头改。
  ⚠️⚠️ **`term.unicode` 是 xterm 的「proposed API」** ⇒ `allowProposedApi`
  **默认是 false** ⇒ 一访问就抛「You must set the allowProposedApi option to
  true to use proposed API」⇒ **整个 `<TerminalPane>` 崩掉**（React 把它卸了
  ⇒ 终端直接没了）✗（用户在真应用里撞到过！）
  ⇒ **`allowProposedApi: true` 必须开**（`term.registerMarker()` 也是 proposed
  ⇒ SearchAddon / SerializeAddon 也要）✓
  ⇒ **选项放在 `src/renderer/panes/terminalOptions.ts`** —— 单测拿**同一份**
  把插件装一遍 ⇒ 少设一个选项那里就红（`tests/renderer/terminalOptions.test.ts`）✓
  ⚠️ **纯 Node 就能测**（`new Terminal()` 和 `loadAddon()` 都不碰 DOM）✓
  ⇒ **`tests/renderer/terminalPane.test.ts` 在 jsdom 里真的渲染一遍**
    `<TerminalPane>` ⇒ 「组件一挂载就崩」这类问题当场红 ✓
    （jsdom 要自己补 `ResizeObserver` 和 `window.matchMedia` —— xterm 都要）✓
- **shell 集成用 OSC 633（协议跟 VS Code 一样）** —— shell 往输出里插
  `ESC]633;…BEL`，IDE 从里面知道「当前目录」「空闲与否」「上一条命令的退出码」。
  ⇒ **别再猜**（老办法记「用户这一行有没有输入」⇒ 猜不准 ⇒ 终端里就出现
  「多一行空白」「一堆空提示符」）。
  - bash：`--init-file <脚本>` ⇒ ⚠️ 它**取代**了 `~/.bashrc` ⇒ 脚本自己
    把 `~/.bashrc` source 回来 ✓（VS Code 也这么干）。
  - PowerShell：`-Command "…; . '<脚本>'"` ⇒ 用户的 profile 照常加载 ✓。
  - ⚠️ **脚本必须是磁盘上的真文件** —— 打包后代码在 **asar** 里，
    **bash 读不了 asar 里的文件**（asar 是虚拟文件系统，只有 Electron 认）
    ⇒ 运行时写到临时目录 ✓。
  - ⚠️⚠️ **PowerShell 的 .ps1 必须带 UTF-8 BOM** —— Windows PowerShell 5.1
    **没有 BOM 就按系统 ANSI 代码页解码**（中文机器 = GBK）⇒ 脚本里的中文
    注释变成乱码 ⇒ **整个脚本被解析坏**（实测：提示符的 OSC 序列只剩一半，
    `A`/`B` 全丢了）⇒ 带 BOM 它就知道是 UTF-8 ✓。bash 没这问题（不加 BOM）。
  - ⚠️ **bash 的 DEBUG trap 不会传进函数**（除非 `set -T`）⇒ 只有**顶层**
    命令会触发 ⇒ 不会自激 ✓。但 **PROMPT_COMMAND 自己也是个顶层命令**
    ⇒ 也会触发 ⇒ 靠 **`$BASH_COMMAND`** 认出来（它就是「马上要执行的那条
    命令」）✓。`$?` 在 PROMPT_COMMAND 里**能**拿到上一条命令的退出码 ✓
    （bash 会把它保住）。
  - ⚠️ **`$PWD` 在 MSYS2 下是 `/c/Users/…`** ⇒ 要用 `cygpath -m` 换成
    Windows 路径，否则 IDE 那边**永远比不相等** ⇒ 每次都白白发 `cd`。
    比路径前先 `normalizeCwd()`（斜杠方向 / 大小写 / 尾斜杠都得归一）。
  - ⚠️⚠️ **报出来的 cwd 是「这台机器的」路径 ⇒ 别在测试里写死它** ——
    `cygpath -m /tmp` 在本地是 `C:/msys64/tmp`，在 CI 那台 runner 上是
    **`C:/Windows`**（那台机器的 MSYS2 就这么映射 `/tmp`）⇒
    ⇒ 断言「路径以 `/tmp` 结尾」⇒ **必假红** ✗
    ⇒ ⇒ **让 shell 自己说**：跑 `__jhyy_cwd`（集成脚本里那个函数）⇒
    拿它的输出跟 OSC 报上来的那个比 ✓（`tests/compiler/shellIntegration.test.ts`）✓
  - ⚠️⚠️ **「这条命令是什么」也要报**（OSC 633 的 `E;<cmd>`）——
    IDE 让 shell 跑程序时，**用户自己可能还有命令在跑** ⇒
    它的「命令执行完」会**先**到 ⇒ 不认一下就会把**用户的**退出码
    当成 IDE 的 ⇒ **张冠李戴** ✗
    ⇒ bash 从 DEBUG trap 的 `$BASH_COMMAND` 拿（⚠️ **只能在函数外拿** ——
    进了函数它就变成「函数自己」了 ⇒ 由调用方传进去）✓；
    PowerShell 从 `Get-History` 的 `CommandLine` 拿 ✓
    ⇒ ⚠️ **bash 的 DEBUG trap 对「子 shell」不触发**（实测：`(exit 42)` 不触发，
    `echo done` 触发）⇒ IDE 自己发的运行命令**必须是简单命令**
    （`& 'C:\path\prog.exe'` 就是）✓
  - ⚠️⚠️ **PowerShell 的退出码要取 `$LASTEXITCODE`**（原生程序的**真实**退出码）——
    VS Code 那套是「`$?` 的反面」（只有 0/1）⇒ 分不出
    「Ctrl+C 中断（0xC000013A）」和「真崩了」⇒
    用户报过「程序崩溃：NTSTATUS0xC000013A 是什么鬼」✗
    ⇒ 读完**立刻清掉** `$LASTEXITCODE`（免得下一条 cmdlet 读到过期值）✓
    实测：`& 'C:\path\prog.exe'` 退出码 42 ⇒ `$LASTEXITCODE = 42` ✓；
    Ctrl+C 打断 ⇒ `$LASTEXITCODE = -1073741510`（= 0xC000013A）✓
    ⚠️ **必须用调用运算符 `&`**（不带扩展名的命令名 PowerShell 会解析成别的
    ⇒ `$LASTEXITCODE` 是空的）
  - ⚠️⚠️ **cmdlet 的退出码靠 `$?` ⇒ 而 `$?` 必须在 `Prompt` 里**第一个**读** ——
    `$?` 反映的是**上一条命令**的结果，而函数里随便执行一条语句就会覆盖它 ⇒
    以前脚本先做了 `Set-StrictMode` + 两句赋值 ⇒ 读到时 `$?` 已是 True
    ⇒ **失败也报 0** ✗ ⇒ IDE 的「cd 失败 ⇒ 停下整条序列」那道护栏**永远不触发**
    ⇒ 编译会在**用户的项目目录**里跑 ⇒ 凭空造出 `compiler/build/obj/` 垃圾 ✗
    ⇒ ⇒ 脚本里**第一句**就是 `$ok = $?` ✓（实测：cd 失败 ⇒ `$ok` = False ✓）
  - ⚠️⚠️ **OSC 序列可能**跨块**（切在 `ESC` 和 `]` 之间）——
    `OSC` 是 `ESC ]` **两个**字符 ⇒ 一块数据正好以 `ESC` 结尾时
    `indexOf` 找不到前缀 ⇒ 以前那个 `ESC` 被当成正文冲掉了 ⇒ 下一块以 `]633;…`
    开头 ⇒ **整条 OSC 633 丢了** ✗ ⇒ `D;<code>` 永远不来 ⇒ **「运行」永远挂着**
    （跑产物那一步故意不设超时 ⇒ 没有兜底）✗
    ⇒ ⇒ 解析器要把**结尾那个孤零零的 `ESC` 留在 `pending` 里** ✓
    （`src/shared/shellIntegration.ts`）
  - ⚠️⚠️⚠️ **别劫持 `PSConsoleHostReadLine`**（VS Code 靠它报「命令开始执行」）
    —— **我们劫持不了** ⇒ 装得太早 ⇒ 抓到的**不是 PSReadLine 的那个**，
    而是 PowerShell 控制台主机的**默认实现**（返回空行）⇒
    ⇒ **一按回车，输入就没了**（命令压根不执行）⇒ **终端直接废掉** ✗✗✗
    （实测：装上钩子后发命令 ⇒ `633;E;` 是空的 ⇒ 命令没跑 ⇒
      「PowerShell 也会报…」那个测试当场红 ⇒ 才发现的）
    ⇒ 我们只报 `E;<cmd>`（从 `Get-History` 拿）⇒ 不报 `C` ⇒
    ⇒ **「shell 现在空不空」对 PowerShell 来说是猜的**（老问题，不是新引入的）
    ⇒ ⇒ 所以**别**在「shell 空闲时」做清行之类的动作（会把正在跑的程序杀掉）✗
    ⇒ **用户没敲完的那半行会被接在命令前面**（`ls& 'C:\…'`）⇒
      终端里会看到 PowerShell 的报错（**可见**，不是静悄悄地挂住）✓
      （靠 `E;<cmd>` 里**含不含**我们的片段来认出「这条命令是不是我们的」）✓
- **终端尺寸的去抖 = 抄 VS Code 的 `TerminalResizeDebouncer`** ——
  源码：`src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts`
  ⇒ 我们的移植在 `src/renderer/panes/terminalResizeDebouncer.ts` ✓
  ⚠️ **规则不是拍脑袋定的**（用户提醒过：直接翻 VS Code 的源码）——
  VS Code 的注释写得很清楚：
  > vertical resize is **cheap**, horizontal resize is **expensive due to reflow**
  ⇒ 而且 **xterm 自己的 resize 也放在去抖回调里**（不是先 `fit.fit()`）✓
  ⇒ 另外两条规则：**终端看不见时排到空闲再改** ✓、**刚变可见时 `flush()`** ✓
  - ⚠️⚠️⚠️ **但我们比 VS Code 激进：两个方向都去抖（100ms）** ——
    **这是故意的偏差**，理由是查了 xterm.js 6 的源码
    （`@xterm/addon-webgl` 的 `WebglRenderer.handleResize`）：
    **每一次 `term.resize()` 都会**
    ① 改 `canvas.width/height` ⇒ **清空画布**（HTML 规范）
    ② `_refreshCharAtlas()` ⇒ **整个字符图集重建**（很贵）
    ③ `_clearModel(false)` ⇒ 模型清空 ⇒ 整屏重画
    ⇒ ⇒ **每帧 resize 一次 = 每帧闪一次** ✗（用户报过：「还是一闪一闪的」）
    ⇒ 而 VS Code 那条「**缓冲区不到 200 行就不去抖**」的规则**对我们是反效果**
    —— 我们的缓冲区天生就小 ⇒ ⇒ **永远走「立刻改」那条路** ⇒ ⇒ 每帧都闪 ✗
    ⇒ ⇒ **拖动期间终端一次都不 resize** ⇒ 停手后**只 resize 一次** ⇒
    ⇒ ⇒ **只闪一次**（而且是内容正确的那一次）✓
    ⚠️ **代价**：拖动时终端的内容区**不跟着面板长高**（面板和分割线照样
    实时跟手）⇒ 停手后一次性贴上 ⇒ VS Code 的**横向**拖动就是这个手感 ✓
  - ⇒ **xterm 的去抖和 pty 的去抖是同一个 100ms** ⇒ ⇒ **两者一直同步**
    ⇒ ⇒ conhost 重画时 xterm 的行数已经对上了 ⇒ 内容**不会跳** ✓
  - ⚠️⚠️ **发给 pty 的尺寸要**单独**去抖（100ms）** ——
    **xterm 的尺寸立刻改**（画面跟手）⇒ **pty 的尺寸去抖** ⇒
    因为 **ConPTY 一 resize 就整屏重画**（很贵！）⇒ 每帧一次 =
    每帧一次整屏重画 + 一屏文本从 IPC 灌回来 ⇒ **反馈回路** ⇒ 卡死 ✗
    ⇒ 停手之后补发一次 ⇒ 只重画一次 ✓
    （见 `TerminalPane.tsx` 的 `notifyPtySize`）
  - ⚠️ **xterm 要知道对面是 ConPTY** ⇒ `term.options.windowsPty =
    { backend: 'conpty' }`（VS Code 在 `terminalInstance.ts:922` 就是这么干的）
    ⇒ 不设的话 xterm 按 **Unix 的规则**处理「终端变高」（把滚动缓冲**拉回
    视口**），而 ConPTY 其实是**在视口底部填空行** ⇒ 两边对不上 ⇒
    「行被替换导致丢数据」✗
    ⚠️ **只给 `backend`，不要给 `buildNumber`** —— 给了且 < 21376 的话
    xterm 会**关掉 reflow** ⇒ 更糟 ✓
  - ⚠️ **FitAddon 减的是「xterm 父元素」的 padding** ——
    ⇒ **padding 必须放在 xterm 挂的那个 div 上**（`.terminal-pane-inner`）
    ⇒ 以前放在外层 ⇒ 减的是 `.xterm` 自己的 padding（= 0）⇒
    **那 8px 压根没减掉** ⇒ **多算一行** ⇒ 最后一行被裁掉 ✗
  - ⚠️⚠️⚠️ **别用 `fit.proposeDimensions()`**（VS Code 也是自己算的 ——
    `TerminalInstance._evaluateColsAndRows`）。它有两个毛病：
    1. **每次都 `getComputedStyle()` ⇒ 强制同步布局** ⇒
       「读 → 写（resize）→ 再读」⇒ **布局抖动** ⇒ 每帧一次全页重排
       ⇒ **卡** ⇒ 而且**闪**（重排和重绘交错，一帧旧一帧新）✗
    2. **无条件减掉 14px**（`scrollback > 0` 时）—— 那是 **overview ruler**
       的宽度（**我们没有那个东西**）⇒ 终端比容器**窄 14px** ⇒
       画布和容器对不上 ⇒ 一动就「闪」✗
    ⇒ 改成：**尺寸从 `ResizeObserver` 的 `contentRect` 拿**
    （它**就是内容框** ⇒ 已经减掉 padding ⇒ 不用 `getComputedStyle` ⇒
    **不触发布局** ✓）**格子大小从 xterm 的字符度量拿**
    （`term._core._renderService.dimensions.css.cell` ——
    FitAddon 用的也是同一个，VS Code 也读 xterm 的内部 ⇒ 同一路子 ✓
    ⇒ 读它**不触发布局**（就是个属性）⇒ 每帧读都便宜 ✓）
    ⇒ 见 `TerminalPane.tsx` 的 `measure()` / `xtermCellSize()` ✓
- ⚠️⚠️ **拖动分隔条时**别写 React state**（用户报过「拖终端分割线卡卡的」）
  - 以前每个 `pointermove` 都 `setState` ⇒ **整个 React 树重渲染**
    （这个项目里**一处 `memo` 都没有** ⇒ CodeMirror / Blockly / ChatPane
    全跟着重渲染）⇒ 再加上 `useEffect(saveLayout)` 每次**同步写
    `localStorage`** ⇒ 拖一下就是几十次全树重渲染 + 几十次磁盘写 ✗
  - ⇒ 现在分两层（`src/renderer/hooks/useResizable.ts`）：
    `onResize`（**拖动中**，**rAF 节流** ⇒ 一帧最多一次）⇒ 调用方**直接改
    DOM 的 style** ⇒ 不进 React ✓；`onCommit`（**松手时**）⇒ 才写回 state
    （⇒ 一次重渲染 + 一次存档）✓
  - ⇒ 终端的 `ResizeObserver` **也要 rAF 节流**（照 `BlockPane.tsx` 的写法）✓
- **终端的流控（ack）**：VS Code 用 `terminalProcessManager.ts` 末尾的
  `AckDataBufferer` —— **按字符数**记账（`FlowControlConstants`：
  高水位 100000 字符 ⇒ **暂停 pty**；低水位 5000 ⇒ 恢复）。
  我们是**按序号**记账（效果等价：数据卡在主进程，不进 IPC 队列）✓
  ⚠️ **暂停 pty 那一半我们做不到** —— node-pty 没有这个 API（VS Code 用的是
  自己的 node-pty 分支）⇒ 我们的等价手段是「主进程先攒着、不往前推」✓
- **终端列表在面板头部右侧**（VS Code 那边是竖排在最右边；这里横排，跟这个
  IDE 的横排风格一致）—— 面板里**没有「输出」页签**：编译器和程序的输出都
  进**终端** ✓（VS Code 的任务终端就是一个样）
- **终端是「多个」的（VS Code 的模型）** —— `terminalRegistry.ts` 管着一张表：
  - IDE 启动时就**开好第一个终端** ⇒ 反复点「运行」**不新开**（VS Code 那样）✓
  - 能**开新的**（`Ctrl+Shift+\`` / 终端列表上的 `+`）、能**关旧的**（每个页签上的 `×`）✓
  - 「运行」用**当前那个**；**一个都没有就新开一个** ✓
    ⇒ ⚠️⚠️ **「运行」绝不改 `activeId`**（`activeOrCreate()` 复用时不改）⇒
    ⇒ ⇒ **可见的终端页签不会跳走** ✓（用户报过：「点运行跳到别的终端」）✓
    ⇒ ⇒ 保底路径（一次性终端）**才**会跳（它得让用户看到输出）⇒
    ⇒ ⇒ 那个终端**起名叫「运行」/「检查」** ⇒ 用户知道它为什么换了 ✓
  - ⚠️ **每个终端一个 xterm 实例** ⇒ 切来切去 scrollback 不丢 ⇒
    状态（背压序号、恢复队列、保存定时器）也**各自一份** ✓
  - ⚠️ **所有事件都要带「是哪个终端」**（`terminalId`）—— 否则渲染进程不知道
    该写进哪个 xterm ⇒ 数据/退出/状态事件全都要带 ✓
  - ⚠️ **「当前是哪个」由主进程说了算**（列表事件里带 `activeId`）⇒
    渲染进程只管跟着走 ⇒ 不会出现「两边以为当前的不是同一个」✗
- **终端的输出要走「背压」（ack）** —— 渲染进程**写完**（xterm 解析完）之后
  把序号回执给主进程 ⇒ 主进程只往前推一小段（512 KB）。
  ⇒ 没有它，终端狂打输出时 **IPC 队列无限涨** ⇒ 内存被吃光 ⇒ 整机换页 ⇒
  **整个 IDE 卡死**（用户报过：「运行 `while true` 的程序时整个 IDE 卡死」）✓
  ⚠️ **一批数据必须切成 64 KB 一块** —— 一次 pipe 的 'data' 事件能给出
  **好几 MB**（实测一次给了 7.9 MB）⇒ 不切的话「在途上限」形同虚设
  （**一批就超了**）⇒ 背压等于没有 ✓
  ⚠️ **窗口重载之后渲染进程是新的** ⇒ 它没回执过任何东西 ⇒ 主进程会一直
  卡在途 ⇒ **终端再也不出东西** ⇒ 渲染进程挂上来时要 `terminal.ready()`
  **重置**一下 ✓
- **终端跑在「pty 宿主进程」里**（VS Code 也是这个架构）——
  `utilityProcess.fork(out/main/ptyHost.js)` ⇒ 真控制台跑在**独立进程**里。
  - **node-pty 崩了不会把 IDE 带走** —— 它是原生模块，段错误 = 整个 Electron
    进程死 ⇒ 用户的文件、Claude 会话、终端**全丢** ⇒ 挪出去以后它崩了只是
    终端没了 ✓
  - ⚠️ **`process.env` 不能结构化克隆** ⇒ `postMessage` 会直接抛
    「An object could not be cloned.」⇒ **凡是发给宿主进程的东西都得先摊平成
    普通对象**（`{ ...process.env }`）✓（实测踩过：请求根本没发出去，终端
    「没反应」，而且 `catch {}` 把错误吞了 ⇒ 静悄悄地什么都不发生）✗
  - ⚠️ **宿主进程的 stdout 不一定透到主进程** ⇒ 想看它的日志得**发回主进程** ✓
  - 宿主进程起不来 ⇒ 退回「主进程里直接跑 node-pty」⇒ 再不行才退管道 ⇒
    **三层退路**，每一层都得**看得见**（状态栏徽章）✓
  - ⚠️⚠️ **宿主 ready 之前 ⇒ 「起会话」的请求要**先攒着** ——
    `available` 要求宿主**已经报过 `{t:'ready'}`**（它自己起来 + 加载 node-pty
    + 预热一个控制台 ⇒ 好几百毫秒）⇒ **IDE 刚启动时建的第一个终端**正好落在
    这个窗口里 ⇒ 以前它会**退回「主进程里跑 node-pty」** ⇒
    **第一个终端没有崩溃隔离**（node-pty 段错误 = 整个 IDE 死）✗
    ⇒ `PtyHost.create()` 在宿主没 ready 时**先把请求攒着**，ready 之后统一发 ✓
    ⇒ 挑后端要用 **`canCreate`**（不是 `available`）——
    「还没报 ready」⇒ **可以**（会先攒着）；「报过了、说 node-pty 不行」⇒ **不行**
    （得退回主进程，攒着就永远起不来）✓
  - ⚠️ **宿主崩了要能自愈** —— `onExit` 把 `child = null` ⇒ `available` 永远 false
    ⇒ 之后所有终端都退回「主进程里跑 node-pty」⇒ **段错误会带走整个 IDE**
    ⇒ `PtyHost.ensureStarted()` ⇒ 崩过之后重新起一个 ✓
  - ⚠️⚠️ **「kill 比 create 先到」⇒ 不能起一个没人管的孤儿 shell** ——
    宿主还没 ready 时创建请求是**先攒着**的 ⇒ 用户在等的期间把终端关了
    ⇒ `kill` 先到 ⇒ 宿主**压根不认识这个 id** ⇒ 那个 kill **是个空操作**
    ⇒ 随后 create 到达 ⇒ **shell 起来了，没人管** ✗✗（用户看不见，但一直占着进程）
    ⇒ ⇒ 两头都堵：主进程那边**撤掉**那个攒着的请求（压根不起）✓
    ＋ 宿主那边**记一笔「这个 id 杀过」**⇒ 起完立刻杀掉 ✓
- **管道后端 spawn 失败 ⇒ 也要通知退出回调** —— Node 在 spawn 失败时
  **只发 `'error'`、不发 `'exit'`** ⇒ 只在 `'exit'` 里通知的话 ⇒
  终端登记表**不知道这个终端死了** ⇒ 它**留在列表里**（僵尸标签）⇒ 还是「当前那个」
  ⇒ 下次「运行」看到 `running === false` ⇒ **在旁边再开一个** ⇒
  **终端标签越点越多** ✗ ⇒ `PipePtySession.notifyExit()` 只通知一次 ✓
- **终端数据不能只由「每个 view 订阅一次」** —— `onData` 以前是每个 xterm view
  自己订阅 ⇒ **视图建好之前到的数据没有任何人接** ⇒ 直接掉地上 ⇒
  **新终端的第一批输出（shell 的第一个提示符）很容易在这个窗口里到**
  ⇒ 用户看到「终端是空的」✗ ⇒ 改成**组件级订阅 + 按 `terminalId` 缓存**
  ⇒ view 建好时补给它（跟「恢复上次的内容」走同一条路 ⇒ 顺序不乱）✓
- **全局快捷键别抢浏览器/编辑器原生的键** —— 快捷键处理在 `window` 的
  **捕获阶段** `preventDefault()` + `stopPropagation()` ⇒ 浏览器因此**不再
  触发 `paste` 事件** ⇒ CodeMirror 的粘贴处理收不到东西 ⇒ **粘不上**
  （用户报过）。⇒ 这类命令标 `native`（见 `commands/types.ts`），直接放行。
- ⚠️ **按住 Shift 时 `KeyboardEvent.key` 会变** —— 反引号键在美式布局上
  按住 Shift 报的是 **`~`**（不是 `` ` ``）⇒ `Ctrl+Shift+Backquote`
  （新建终端）**永远匹配不上** ✗ ⇒ `KEY_ALIASES` 里**得有 `'~'`** ✓
  （更稳的是用 `event.code`，跟 Shift / 布局无关 —— VS Code 就是这么做的）
- ⚠️ **命令面板也要查 `enabled`** —— 菜单那条路查了（`App.tsx` 的 `runCommand`）
  ⇒ 命令面板不查 ⇒ 两个入口行为不一致 ✗
  （例：程序正在跑时「运行」是禁用的 ⇒ 从面板选它会**再起一个** ⇒ 两个运行互相踩 ✗）
- **主进程里别做同步的慢操作** —— `execFileSync` 探测 python 的 fastmcp 要好几秒
  ⇒ **整个 IDE 卡住**（用户报过「特别慢特别卡」）。⇒ 一律用异步，
  并且**启动时就在后台预热**。
- **终端默认用 PowerShell（跟 VS Code 一样）** —— ⚠️ **交互终端不要 `-NoProfile`**！
  用户自己的 profile 里通常有 starship / oh-my-posh ⇒ **提示符才跟 VS Code 里
  那个漂亮的 `(base) PS C:\...` 一模一样** ✓（用户明说要「跟 VS Code 那个感觉」）
  ⇒ shell 集成脚本是**包住**用户的 Prompt 函数（不是替换）⇒ 两边都保住 ✓
  ⚠️ **但保底路径那个一次性终端要 `-NoProfile`** ⇒
  ⇒ 它**不显示提示符** ⇒ profile 的**样式**没用 ⇒
  ⇒ 而 profile 的**环境变量**（conda init！）由主进程**导一次、缓存住**、注入进去 ⇒
  ⇒ ⇒ 启动从 ~10 秒变成 ~0.5 秒 ✓（见上面「任务终端别重新加载 profile」那条）
  ⇒ ⚠️ **「运行」现在跑在「当前那个终端」里** ⇒ 那个终端是**交互终端**
  ⇒ ⇒ **它照样加载 profile**（提示符要好看）⇒ 第一次跑可能要等 profile ✓
  ⚠️ **以前默认是 MSYS2 的 bash**，理由是「bash 的 readline 在**管道**下有真正的
  行编辑」⇒ 但那是**管道版**的问题 ⇒ 现在真控制台（ConPTY）跑起来了 ⇒
  **PSReadLine 在真控制台里是完整的** ⇒ 老理由不成立 ✓
  （管道兜底时 PowerShell 的退格仍有问题 —— 那是没有 node-pty 的少数机器）
- **往 shell 发「一整行命令」只能用 `\r` 或 `\n` 一个** —— **`\r\n` 是两个回车**
  （readline 的两个 accept-line）⇒ **shell 打两个提示符**（中间还夹一个空行）
  ⇒ 终端里就是「一堆空提示符」（用户报过：「有时候会打印一堆这种空的」）✓
  ⇒ 实测：管道版和真控制台版都是 `\r\n` ⇒ 2 个提示符；`\n` / `\r` ⇒ 1 个 ✓
  ⇒ **行尾按后端来**（`PtySession.lineEnding`）：管道 `\n`、真控制台 `\r` ✓。
- ⚠️⚠️⚠️ **「让 shell 重打一遍提示符」这个机制已经删了** ——
  以前 `TerminalSession.prompt()` 的实现是**往 shell 的 stdin 写一个裸 `\r`**
  ⇒ 那是一个**真的回车键** ⇒ shell 会跑**一整轮额外的提示符**
  ⇒ **终端里多一个提示符**（用户报过：「先打印程序输出，然后又打印一遍
  `(base) PS C:\…>`」）✗
  ⇒ 而且那个空行在 **PowerShell** 里会造一条**空的历史记录** ⇒ 报 `D;0`
  ⇒ ⇒ `maybeFinishRun()` 看到空命令行 ⇒ **跳过了匹配检查**
  ⇒ ⇒ **正在等的那次运行被提前用退出码 `0` 收场** ⇒ **程序的退出码被报成 0** ✗
  ⇒ ⇒ **VS Code 的模型**（`microsoft/vscode@main`）：
    `shellIntegrationAddon.ts` + `capabilities/commandDetectionCapability.ts`
    是个状态机（`A` 提示符开始 → `C` 命令开始 → `C` 命令已执行 → `D;<code>`）
    ⇒ **shell 的提示符是唯一的提示符，IDE 从来不「要」一个提示符** ✓
    ⇒ IDE 要往终端里写东西时写的是 **`\n\x1b[G`**（`terminalInstance.ts:1912`）✓
  ⇒ ⇒ **别再加回来**（`tests/compiler/terminalRun.test.ts` 有钉着的测试）✓
- ⚠️⚠️ **编译和运行都在「当前那个终端」里**（活 shell 那条路）——
  以前编译是 IDE 直接 spawn + 输出**注入**到终端 ⇒
  **注入的内容不在 conhost 的屏幕里** ⇒ 而 shell 的提示符**在它上面**
  ⇒ 用户看到「程序输出 + 又一个提示符」✗
  ⇒ 现在：编译、运行**都是敲进那个 shell 的命令** ⇒
  编译器输出、程序输出、提示符**全在同一条流里** ⇒ **提示符只出现一次** ✓
  ⇒ 诊断从**编译那一步**的输出里解析（`parseDiagnostics`，**先 `stripAnsi`**）✓
- ⚠️⚠️⚠️ **「跑产物」那一步必须用 `buildShellCommand(shell, exe, args)`** ——
  PowerShell 里 **`'C:\…\prog.exe'` 是「一个字符串」，不是命令** ⇒
  解析器直接 `ParserError`（`必须在"/"运算符后面提供一个值表达式`）⇒
  ⇒ **程序压根没跑** ⇒ **终端里一点程序输出都没有**（用户报过）✗
  ⇒ ⚠️ **PowerShell 要带调用运算符 `&`**，**bash 不能带**（`&` 是后台算符）⇒
  ⇒ ⇒ `buildShellCommand()` 已经按 shell 分好了 ⇒ **别手写** ✓
  ⇒ ⇒ **不能**用 `shellQuote`（那只是**引号包起来的字面量**）✗
  ⇒ 拼法在 **`buildLiveSteps`**（`src/main/terminal.ts`）⇒
  ⇒ **测试跟生产代码用同一个函数** ⇒ 不会再漂 ✓
  ⇒ ⚠️ **保底那条老路**用 `buildRunCommandChain`（还是一条链）✓
  - ⚠️⚠️ **保底那条链的 `cd` 后面必须用 `&&`，不能用 `;`** ——
    bash 里 `;` 和 `&&` **优先级相同、从左往右** ⇒
    `cd A; 编译 && cd B; 跑产物` 实际是「cd A → 编译 →（成功才）cd B → **跑产物**」
    ⇒ **编译失败产物照样跑**，而且跑在**错的目录**里 ✗✗
    ⇒ cmd.exe 更糟：它**根本不支持 `;`** ⇒ 整条命令塌成一条 `cd`
    ⇒ **编译器和程序都跑不了** ✗
    ⇒ ⇒ bash/cmd 用 `cd X && …`；**PowerShell 5.1 没有 `&&`** ⇒ 用嵌套
    `if ($LASTEXITCODE -eq 0) { … }` ✓
- ⚠️⚠️⚠️ **pty 宿主进程那条路必须传 `shellCommand`** ——
  「pty 宿主进程」是**首选后端**（真控制台跑在独立进程里）⇒
  ⇒ 但它以前**只收到 `shell`/`cwd`/`cols`/`rows`/`command`** ⇒
  ⇒ **`shellCommand` 被丢掉了** ⇒ 宿主起的是一个**普通的交互 shell** ⇒
  ⇒ ⇒ **那条命令压根没跑** ⇒ **终端里一点程序输出都没有**（用户报过）✗
  ⇒ ⇒ 而且**终端永远不退出** ⇒ 「运行中」永远亮着 ✗
  ⇒ ⚠️ **只有这条路会坏** —— 主进程里跑 node-pty 的退路、管道兜底**都正常**
    ⇒ ⇒ **机器上装没装 node-pty 会决定「运行」坏不坏** ⇒ 最坏的一种 ✗
  ⇒ ⇒ `PtyHostSpec` 里补上 `shellCommand`（`ptyHostCore.ts`），
    `ptyFactory.ts` 起会话时一起传过去 ✓
  ⇒ **测试**：`tests/compiler/ptyHost.test.ts` + `tests/compiler/runTaskChain.test.ts` ✓
- ⚠️⚠️ **任务终端别重新加载 profile**（VS Code 的 `useShellEnvironment`）——
  用户的 PowerShell profile 可能要 **9～11 秒**（这台机器上是 `conda init`）⇒
  ⇒ 「运行」/「检查」每次都等它 ⇒ **按钮点了半天才有反应** ✗
  ⇒ ⇒ VS Code 的任务终端是 `useShellEnvironment = true`
  ⇒ 用的是**算好的** shell 环境（profile 的 env **导一次、缓存住**）✓
  ⇒ ⇒ 我们也这么做：`shellEnv.ts` 导 **PowerShell 的 profile env**（NUL 分隔、
  UTF-8、超时放宽到 30 秒 —— profile 慢）⇒ 缓存 ⇒
  ⇒ ⇒ 任务终端加 **`-NoProfile`** ⇒ 启动从 ~10 秒变成 ~0.5 秒 ✓
  ⇒ ⚠️ **导不到就不加这个标志** ⇒ 不然用户的 conda 就没了（宁可慢）✓
  ⇒ ⚠️ **交互终端照样加载 profile**（提示符要跟 VS Code 那个 `(base) PS …` 一样）✓
- ⚠️ **PATH 的键名大小写** —— Windows 上 `process.env` 里常见的是 `Path`，
  导出来的是 `PATH` ⇒ **两份并存** ⇒ 后面挑「第一个」会挑错 ⇒
  ⇒ **用户 PATH 白导了** ✗ ⇒ `mergeShellEnv` 要**先删掉别的 PATH 变体** ✓
  ⇒ `buildSubprocessEnv` 挑 `extra` 里的 PATH 要取**最后一个**（后 spread 的赢）✓
- ⚠️ **PowerShell 的 `exit $LASTEXITCODE` 在 `$LASTEXITCODE` 是 `$null` 时退 0** ——
  「命令压根没跑起来」（路径写错了 ⇒ `CommandNotFoundException`）⇒
  ⇒ `$LASTEXITCODE` **从没被赋过值** ⇒ `exit $null` ⇒ **退出码 0** ⇒
  ⇒ IDE 以为「成功」而屏幕上只有一条红报错 ⇒ **最坏的一种** ✗
  ⇒ ⇒ `$null` ⇒ **退出码 1** ✓
- ⚠️⚠️ **「运行」那条路的两套测试** ——
  ⚠️ **活 shell 那条（现在的默认）** ⇒
  **`tests/compiler/liveRun.test.ts`**（真 bash + 假编译器：跑在当前终端、
  跑完终端还活着、退出码是程序自己的、终端正忙时一个字都不写进去…）
  ⇒ **`tests/compiler/liveRunReal.test.ts`**（**真编译器**、PowerShell（默认 shell！）
  + bash 各一遍）⇒ **`tests/compiler/liveSteps.test.ts`**（纯函数：每条命令都是
  「一条简单命令」、**bash 不带 `&`**、匹配串互不包含、程序步没有超时…）✓
  ⚠️ **保底那条（一次性终端）** ⇒ **`tests/compiler/runTaskChain.test.ts`**
  （端到端、真编译器、PowerShell + bash 各一遍）✓
  ⇒ ⇒ 上面的两个 bug（「`&` 丢了」「宿主没收到 `shellCommand`」）就是这么漏出去的 ✗
  ⇒ ⇒ **两条路都得有测试**（保底路径哪天会重新变成主路径也照样有网）✓
- ⚠️ **终端里「显示」和「输入」是两条道** —— 程序的输出必须走 `display()`
  （只写显示层）；走 `write()` 会被 shell 当成**输入的命令**执行掉。
  ⇒ `display()` 写之前会先写 `\n\x1b[G`（VS Code 的写法）⇒
  **回显**（`echoProgramInput`）**不能走 `display()`**（会加前缀 ⇒ 退格擦错位置）✓
- ⚠️⚠️ **运行要绑定到终端**（VS Code 的模型）——
  VS Code：任务由**终端的 exit 事件**驱动收场
  （`tasks/browser/terminalTaskSystem.ts:971`）⇒
  关掉终端 ⇒ 任务结束 ⇒ **「运行中」不会永远亮着** ✓
  （用户报过：「有的终端杀掉了右上角还是在运行中」）✗
  ⇒ 「停止」的 Ctrl+C 必须发给**真正跑程序的那个终端**
  （以前发给 `terminals.active()` ⇒ 用户切了个终端就 Ctrl+C 不到了）✗
  ⇒ 渲染进程**必须监听 `terminalExit`**（以前根本不听 ⇒ 状态挂着）✓
- ⚠️⚠️ **状态栏不显示程序行为**（用户明说：「右下角的状态栏戏太多了，
  人家用户根本就不需要知道程序行为」）⇒
  「运行中…」「退出码 42」「已保存…」「降级运行…」**全都不显示** ✓
  ⇒ **`Status.kind` 的类型限死成 `'bad'`** ⇒ 编译器替你把关 ✓✓
  ⇒ **运行状态在终端页签上**（转圈 / ✓ / ✗，VS Code 的 task 页签）✓
  ⇒ 编译诊断在**问题面板**里 ✓
  ⇒ ⚠️ **渲染进程不再有全局 `busy`** —— 它是**从各终端的 `run` 状态推出来的**
    ⇒ 老运行收场**只影响它自己那个终端** ⇒ 不会连累新运行 ✓
- ⚠️⚠️ **状态栏那条消息必须是「**当前的**问题」，不是「历史日志」** ——
  用户报过：「右下角的状态栏不带更新的，**一次编译失败就一直留着了**」✗
  ⇒ ⇒ **问题解决了就得撤掉** ✓
  ⇒ ⇒ 每条消息都带一个 `tag`（`compile` / `run` / `blocks` /
    `claude-overwrite` / `file`）⇒ 撤的时候**只撤同一类** ✓
    （编译成功**不该**撤掉「块视图只重建了一部分」那条 ✓）
  ⇒ ⇒ **撤除的逻辑在 `src/renderer/state/status.ts`**（纯函数，好测）✓
    `clearStatus(prev, ...tags)` / `clearWhenDiagnosticsClean(prev)`
  ⇒ ⇒ 什么时候撤：
    - 「检查」成功 ⇒ 撤 `compile`
    - 「运行」成功 ⇒ 撤 `compile` + `run`
    - **后台实时诊断干净了** ⇒ 撤 `compile`（**但只撤「有源码诊断」的那种** ——
      后台是 `--no-link` ⇒ 它**看不见链接错误** ⇒ 「链接失败」那条留着 ✓）
  ⇒ ⚠️ **「终端死了」那种什么都不知道 ⇒ 既不设也不撤** ✓
  ⇒ ⚠️ **打开文件（欢迎页 / 最近列表）也要 `setStatus(undefined)`** ——
    不然「先打开一个 .jhyy 文件」会一直挂着 ✗
- **终端的文字复制不出来** —— xterm 默认把 `Ctrl+C` 当 SIGINT 吃掉
  （`preventDefault`），浏览器的原生复制**永远不触发**。
  要用 `attachCustomKeyEventHandler`：有选区时返回 false，把 `Ctrl+C` 让给浏览器。
- **脏标记不要存布尔值** —— 拿「当前内容」跟「上次保存的内容」比（VS Code 的做法），
  撤销回保存点小圆点就自动消失。「块视图已过期」同理。
- ⚠️⚠️ **退出码不是「失败」的判据** —— JHYY 的入口是 `fn main_jhyy() -> i32`，
  **它的返回值就是进程退出码**（语言仓库 `compiler/runtime/runtime.c`：
  `return main_jhyy(argc, argv);`；规范 §1.1「返回值作为进程退出码」）
  ⇒ **返回什么由程序自己决定** ⇒ ⇒ **非 0 不等于出错** ✗
  （一致性门的语料里连 `// EXPECT-EXIT: 42` 都拿它当断言用！）
  ⇒ ⇒ 所以状态栏上**不能**用红/绿区分它（用户明说）⇒ 一律**中性** ✓
  ⇒ 真正该标红的只有：**编译失败 / 超时 / 输出过多 / 崩溃**（NTSTATUS）
  ⇒ ⚠️ **崩溃跟退出码是两码事** —— `0xC000013A` 是 **Ctrl+C**（不是崩溃），
  `0xC0000005` 才是崩溃 ⇒ 状态栏分开报（见上面「`0xC000013A` 不是崩溃」那条）✓
  ⇒ 终端页签上那个退出码徽章也一样**中性色**（用户明说）✓
- ⚠️ **「块视图已过期」不再有任何视觉提示** —— 标题栏的**小黄点**和状态栏的
  「块视图已过期」都**去掉了**（用户明说：「本来如果要用用户自然回去点，
  所以这个黄点就没有存在的意义」）⇒
  ⇒ `blocksStale` 现在**只**用来决定「切到块视图时要不要用当前源码重建」
  （`App.tsx` 的 `showBlocks`）⇒ **逻辑一个字没改，只是不再打扰用户** ✓
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
- ⚠️⚠️ **IDE 跑的程序：stdin 就是**终端**（不用接管管道了）** ——
  现在程序是 **shell 的孩子**（跑在 shell 的那个 pty 里 ⇒ 见上面那条）⇒
  它的 stdin **就是终端** ⇒ 用户在终端里敲的字直接喂给它 ✓
  ⇒ `scanf` 读得到东西 ✓（用户报过「scanf 是坏的，他根本就不会让我读」）
  ⇒ **「停止」按钮 = 给 shell 发 Ctrl+C**（`TerminalSession.interrupt()`）✓
  ⚠️ **真控制台才有效** —— 管道版没有控制台 ⇒ 0x03 只是个普通字节 ⇒
  打断不了 ✗（管道版是 node-pty 装不上时的兜底 ⇒ 少数机器）
- ⚠️⚠️ **一致性门必须显式 `stdinPipe: false`**（接空设备 = EOF）——
  语料的判据就取 **EOF 路径**（`compiler/tests/examples/input.jhyy` 的注释：
  「regress harness 跑测试时 stdin=subprocess.DEVNULL，所以 `scanf("%d", &x)`
  恒立刻读到 EOF，返回 EOF(-1) 且**不写** x」）⇒ 接管管道的话 `scanf` 一直等
  ⇒ 程序跑到超时被杀 ⇒ stdout 空 ⇒ **门红**（v0.2.1 的 CI 就是这么红的）。
  ⇒ 而且**读 stdin 的例子必须留在默认子集里**（`REPRESENTATIVE`）——
  那次红的时候子集里一个都没有 ⇒ `npm test` 全绿、放出去才炸。
  ⚠️ **这条只管一致性门**（`tests/conformance/run.test.ts` 走
  `runner.ts` 的**管道版** `runFile`）—— **IDE 自己的「运行」不走那条路** ✓
- **Blockly 的字段渲染在「自己那个孔」的前面** —— 所以「运算符放中间」的正确做法是
  **把它挂到右边那个输入上**（`[a] [+] [b]`）；挂左边就变成 `[+] [a] [b]` ✗。
  只有一个孔的块（类型转换 / 取字段）没法把字段排在孔后面 ⇒ 只能两行。
- ⚠️⚠️ **块上的参数字段（「类型」「printf 格式串」）= 下拉 + 双击自己填** ——
  - **单击 ⇒ 原来那个下拉**（`FieldDropdown`，一个字都没改）⇒ 常用值点一下就选中 ✓
  - **双击 ⇒ 自己填** ⇒ 格式串/类型这种「取值空间很大」的字段
    ⇒ 「**预填的下拉框覆盖不了所有情况**」（用户原话）⇒ 得能手填 ✓
    ⇒ 实现：`ParamField`（`definitions.ts`）—— 浮在字段上的一个 `<input>`
    （Enter 填完 / Esc 取消 / 点别处也填完）⇒
    ⚠️ **Blockly 的 `FieldInput`（带输入框的那套机器）没有导出** ⇒
    ⇒ 只能自己写这个输入框 ✓
    ⇒ ⚠️ **双击的判定要用 `pointerdown` + 时间窗自己判** ——
      ① Blockly 的点击走**手势**（`doFieldClick`）：
      `currentDropdownOwner !== startField && startField.showEditor(...)`
      ⇒ **单击那一下已经把 `currentDropdownOwner` 设成这个字段了**
      ⇒ ⇒ 双击的第二次点击**压根不会调 `showEditor_`** ⇒ ⇒
      **`MouseEvent.detail` 永远看不到** ✗（用户报过「一直只有单击效果」）
      ② 而且 Blockly 的手势在 pointerdown 上 `preventDefault()` ⇒
      **DOM 的 `click`/`dblclick` 事件根本不会触发** ⇒ ⇒ 连 `detail` 都拿不到 ✗
      ⇒ ⇒ **`pointerdown` 不会被吃掉** ⇒ ⇒ 自己判 ✓
      （探测器：`src/renderer/blocks/doubleClick.ts` 的 `DoubleClickWatcher`）
    ⇒ ⚠️⚠️ **监听要挂在「字段组」上，不是 `<text>`** ——
      **下拉字段是画在一个 `<rect class="blocklyFieldRect">` 背景上的**
      ⇒ ⇒ 点字段的**背景**时事件目标是那个 `<rect>`
      ⇒ ⇒ **`<text>` 是它的兄弟、不是祖先** ⇒ ⇒ **挂在 `<text>` 上的监听
      一次都收不到** ⇒ ⇒ 「双击一点反应都没有」（用户报过两次）✗
      ⇒ ⇒ 挂**字段组**（`fieldGroup_`，`<rect>`/`<text>`/箭头都是它的孩子）✓
    ⇒ ⚠️⚠️ **要挂「捕获阶段」才能抢在 Blockly 前面** ——
      Blockly 的手势（`doFieldClick`）挂在**工作区 SVG**上 ⇒ 那是字段组的
      **祖先** ⇒ ⇒ 它跑在**冒泡**阶段 ⇒ ⇒ 我们在**捕获**阶段挂 ⇒ ⇒ 先跑 ✓
      ⇒ ⇒ 双击时 `stopPropagation()` ⇒ **Blockly 压根看不到第二下**
      ⇒ ⇒ 不会「下拉又弹回来 / 把块拖走」✓
      ⇒ ⚠️ **DOM 规范在「at target」阶段只跑非捕获监听器** ⇒
      ⇒ 万一目标就是字段组本身 ⇒ 靠**冒泡阶段那个兜底** ✓
      ⇒ ⇒ 捕获 + 冒泡都挂 ⇒ `handle` 里**按事件对象去重**（同一个事件只算一下）✓
    ⇒ ⚠️ **双击时那一下单击已经把下拉打开了** ⇒ 得先关掉它 ⇒
    **`Blockly.DropDownDiv.hideIfOwner(this, true)`**（**不带动画**，
    不然它淡出 0.25 秒 ⇒ 跟输入框叠在一起 ✗）⇒
    ⚠️ 名字是 **`DropDownDiv`**（大写的 D）—— 不是 `DropdownDiv` ✗
    ⇒ ⇒ `hideIfOwner` 抛了也得 `hide()` 兜底（不然下拉**盖住输入框**
    ⇒ ⇒ 用户看着像「双击没反应」）✓
    ⇒ ⇒ 而且 Blockly 的 mouseup 那一轮会**重新打开下拉** ⇒ ⇒
    ⇒ 还要在**一小段时间内挡掉 `showEditor_`**（否则下拉盖住输入框）✓
    ⇒ ⚠️ **定位字段别用 `getTextElement()`** —— 它在没有 SVG 文字元素时
    **直接抛异常**（Blockly 13 里是断言不是返回 null）⇒ ⇒ 用
    **`getClickTarget_()`**（两种渲染器都有）✓
    ⇒ ⚠️ **SVG 的字是 `fill` 画的，不是 `color`** ⇒ 用 `computed.color`
    拿到的是继承来的 CSS color ⇒ 可能跟画出来的颜色对不上 ⇒ ⇒ 优先用
    **`computed.fill`** ✓（还要乘上 `getScreenCTM()` 的缩放系数）✓
    ⇒ ✅ **jsdom 里能测了** —— 手工塞一个字段组 + `field.initView()` 就能走
    真应用那条路（`tests/renderer/doubleClick.test.ts`）✓
  - ⚠️ **`FieldDropdown.setValue` 遇到「不在选项里」的值会直接拒绝**
    （只打一条 console warning，值保留成旧值）⇒ 反编译出来的 `*u8`
    会被**悄悄变成 i32** ⇒ 用户的代码被改掉 ✗
    ⇒ 所以要 `DynamicDropdown`：**把见过的、列表之外的值也留在选项里** ✓
    ⇒ 手填的值也是靠它才留得住 ✓
  - ⚠️ **格式串的选项必须是「字面的 `\n`」**（反斜杠 + n 两个字符）——
    格式串在源码里就是 `"%d\n"` ⇒ 选项里要是**真的换行**，
    `compile.ts` 原样插进引号 ⇒ **字符串字面量被截断** ⇒ 编译器报错 ✗
    （这条有单测钉着：`tests/renderer/dropdown.test.ts`）
- ⚠️ **编辑区的字体/字号走 CSS 变量**（`--editor-font-family` /
  `--editor-font-size`）—— React 把变量写在 `.code-pane` 的**行内样式**上 ⇒
  **CSS 变量是「活」的** ⇒ 改完**立刻生效，不用重建编辑器** ✓
  ⇒ 而 CodeMirror 的**主题只在建视图时生效** ⇒ 走主题就得用 compartment 重配
  （`readOnlyCompartment` 那套）⇒ ⇒ **变量更省事** ✓
  ⚠️ **字号要设在 `&`（编辑器根）上** —— 设 `.cm-content` 的话
  **行号那一栏还是 body 的字号** ⇒ 大小不一致 ✗（gutter 继承 `&` ⇒ 一起变 ✓）
  ⚠️ **字体要设两处** —— base theme 里 `.cm-content` 写死了自己的 font-family，
  它的选择器比 `&` 具体 ⇒ 只改 `&` 的话**正文还是老的字体** ⇒ 一起改 ✓
- ⚠️ **用户设置**存在 `src/renderer/state/settings.ts`（`jhyy-ide.settings.v1`）——
  跟 `layout.ts` 一个套路（load/save + 夹数值 + 坏 JSON 回落默认值）✓
  设置对话框：`src/renderer/workbench/SettingsDialog.tsx`，
  入口是命令表里的 **`view.settings`**（`Ctrl+,`，在「查看」菜单里）✓
  ⇒ **菜单 / 命令面板 / 快捷键都从命令表派生** ⇒ 改一处三处都跟着变 ✓
  ⚠️ **改了就立刻生效**（VS Code 的设置就是这样）—— 不点「确定」⇒ 边改边看 ✓
- ⚠️ **欢迎页的两个按钮要一模一样** —— 以前「打开文件…」是 `primary`
  （加粗/高亮）、「新建文件」不是 ⇒ 看着像两个不同的级别 ⇒
  ⇒ 现在**两个都是 `primary`** ⇒ 而且**都不要「…」** ✓
  （`WelcomeView.tsx`）
- **磁盘改动要分「内部」和「外部」** —— Claude（IDE 自己的 agent）用 Edit/Write
  改的文件是**内部改动** ⇒ **直接应用到编辑器**；别的程序改的才是**外部改动**
  ⇒ 才提示用户。而且 IDE 自己保存的文件**根本不该报出来**
  —— ⚠️ `fs.watch` 在 Windows 上一次写入可能触发**好几个**事件，
  所以「自己写的」要用**时间戳**记（不能用「一次性的 Set + 第一个事件就删掉」，
  否则第二个事件漏出去 ⇒ 每次保存都误报）。
  见 `src/main/index.ts` 的 `selfWrittenFiles` / `claudeWrittenFiles`。

### 大文件（打开慢 / 卡 / 卡死）

- ⚠️⚠️⚠️ **文本只存在编辑器里**（`src/renderer/editor/docStore.ts`）——
  以前 `App` 的 React state 里存着**三份全文**（`source` / `saved` / `blocksAt`），
  加上 CodeMirror 那一份 ⇒ **一个大文件在内存里躺了四遍** ⇒
  而且**每次按键**还要：
  - `doc.toString()` 重新物化一份（`codemirror.ts` 的 updateListener）
  - `normalizeEol(value)` 再跑一遍全文件正则（`CodePane` 的同步 effect）
  - `source !== saved` / `source !== blocksAt` 各比较一遍
  - 把整份源码**结构化克隆**一次过 IPC（发给 Claude 的上下文）
  ⇒ ⇒ **每敲一个字 ⇒ 五趟全文件遍历** ⇒ 10 MB 的文件几十毫秒/键 ✗✗
  ⇒ ⇒ 现在文本**只有一份**（在 `DocStore` 的 `EditorState` 里）⇒
  ⇒ **每次按键 O(1)**、**切标签 O(1)** ⇒ 要内容时（存盘/编译前）**按需取一次** ✓
  ⇒ 这就是 VS Code 的 **model ↔ view** 模型（`TextModel` 是真相，编辑器只是投影）✓
- ⚠️ **脏标记是「状态」，不是每次 render 派生的值** ——
  以前是 `source !== saved`（**每次 render 都全文比较一遍**）⇒
  ⇒ 现在由 `DocStore.noteChange()` 算：**编辑时置脏；撤销/重做时精确比一次** ⇒
  ⇒ 而且它**只在 true↔false 翻转的那一刻**才通知 React ⇒
  ⇒ **打字不引发任何 React 重渲染** ✓✓
  ⇒ ⚠️ **撤销/重做怎么认** —— CodeMirror 的 `history` 扩展给那次事务打
  `Transaction.userEvent = 'undo' / 'redo'` ⇒ 靠它认（`isHistoryJump`）✓
  ⇒ **别用 `undoDepth`** —— 它会饱和，而且「普通编辑」和「重做」都会让它变大 ⇒ 分不出来 ✗
- ⚠️⚠️ **切标签 = `view.setState(别的文件的 state)`**（不是「按内容 diff」）——
  以前切文件是拿新旧内容**逐字符**求最长公共前后缀 ⇒
  ⇒ 一个 10 MB 的文件 ⇒ **上千万次 JS 字符比较** ⇒ 切一下卡一下 ✗✗
  ⇒ 而且那个 dispatch **没带 `addToHistory: false`** ⇒
  ⇒ **切文件后按 Ctrl+Z 会把上一个文件的文本恢复进当前文件**（真 bug）✗
  ⇒ ⇒ 现在：**换 state** ⇒ O(1) ⇒ 撤销历史各归各的 ⇒ 那个 bug 自动没了 ✓
  ⇒ ⚠️ **但 `setState()` 会把滚动位置重置掉**（它建的是全新的 `ViewState`）⇒
  ⇒ **每个文件的滚动位置要自己记**（`CodePane` 的 `scrollMem`）✓
- ⚠️⚠️ **块树是懒建的** —— 以前**打开文件时**就 `sourceToBlocks(content)`
  ⇒ 1.4 MB 的文件光这一下就是 **1.2 秒** ✗✗（实测，见下面的基准）
  ⇒ ⇒ 现在：**切到块视图时才建** ⇒ 打开文件是 O(1) ✓
  ⇒ ⇒ 而且**块视图是懒挂载的**（第一次切过去才 `Blockly.inject`）⇒
  ⇒ 一直在文本视图里用的人**一分钱都不付** ✓
- ⚠️ **大文件模式**（`src/renderer/editor/largeFile.ts`）——
  超过阈值（默认 **1 MB**，设置里可调）就**自动关掉**三样东西：
  **后台实时检查**（编全文件，每 600 ms 空闲一次 ⇒ 机器被压满）、
  **拖块视图**（几千个块 ⇒ Blockly 趴窝）、
  **把整份源码送进 Claude**（每轮对话重发一遍 ⇒ token 爆炸）。
  ⇒ 标签上有个「**大**」的标记（用户得知道为什么少了几样功能）✓
  ⇒ **手动「检查」/「运行」仍然可用**（那是一次性的、用户明确要的）✓
  ⇒ 跟 VS Code 的 `editor.largeFileOptimizations` 一个路子 ✓
  - ⚠️⚠️ **每个功能还有自己的「硬上限」**（全局阈值管不了它们）——
    **拖块视图 256 KB**（`MAX_BLOCK_VIEW_BYTES`）：
    块视图**每改一次块**都要走 4 趟全文件（读工作区 → 反编译 → 打印 →
    **再解析一遍当前源码**判「回写会不会改坏代码」→ 再算一次 diff）⇒
    ⇒ 拖一个块时**每个鼠标移动都触发一次** ⇒
    ⇒ 实测 185 KB 的文件一次 ~100–250 ms ⇒ **拖起来是幻灯片** ✗✗
    ⇒ ⇒ 超上限就不给块视图（拖块是给初学者/小程序的 ⇒ 6000 行够用）✓
    ⇒ **Claude 源码 256 KB**（`claudeContextMaxKb`，设置里可调）⇒
    超了就只报路径，让 Claude 自己 `Read` 磁盘上的文件 ✓
    ⇒ ⚠️ **在块视图里切到一个超上限的文件 ⇒ 自动切回文本视图** ——
      否则块视图会显示**上一个文件**的块（配着新文件的名字）⇒ 骗人 ✗
- ⚠️ **自动换行默认关**（跟 VS Code 的 `editor.wordWrap: off` 一样）——
  自动换行是**大文件的头号性能杀手**（一行 5 万字符 ⇒ 几十万个视觉行盒子）⇒
  ⇒ 想开按 **Alt+Z**（命令 `view.toggleWordWrap`）✓
  ⇒ ⚠️ `EditorView.lineWrapping` **只在建视图时生效** ⇒ 运行时切必须走
  `lineWrapCompartment` 重配 ✓
- ⚠️ **光标位置不在 `App` 的 state 里**（`src/renderer/state/cursorStore.ts`）——
  以前光标一动就 `setState` ⇒ **每敲一个字、每按一次方向键，整棵 React 树重渲染**
  ⇒ 现在它在**自己的 store** 里，状态栏用 `useSyncExternalStore` 订阅 ⇒
  ⇒ **只有状态栏那二十来行 DOM 重渲染** ✓
- ⚠️ **`React.memo` 的前提是「回调得稳定」** ——
  这个项目以前**一处 `memo` 都没有** ⇒ `App` 一重渲染（后台诊断每 600 ms 一次！）
  ⇒ **CodeMirror + Blockly + xterm + 聊天面板**全跟着重渲染 ⇒ 卡 ✗✗
  ⇒ 现在重的组件都加了 `memo`（`TerminalPane` / `BlockPane` / `StatusBar` /
  `TabStrip` / `ProblemsPane` / `ChatPane`）⇒
  ⇒ ⚠️ **但 `App` 里传给它们的回调必须包 `useCallback`** ⇒
  ⇒ 不然每次都是新函数 ⇒ `memo` 白加 ✗
  ⇒ ⚠️ **别把「自己订阅的 store」挡掉** —— 状态栏的光标是 `useSyncExternalStore`
  ⇒ `memo` 只比 props ⇒ 内部 store 的更新**照样**进得来 ✓（`tests/renderer/memo.test.ts` 钉着）
- ⚠️ **别在 `App` 的 state 里镜像文本** —— V8 里字符串拼接是 `ConsString` ⇒
  「每次编辑都拼一次新字符串」会**强迫扁平化整份文档** ⇒ 每次编辑 O(n) ✗
  ⇒ ⇒ 文本**只在编辑器里**，谁要谁**按需取一次** ✓
- **基准**：`JHY_BENCH=1 npx vitest run tests/renderer/editorBench.test.ts`
  ⇒ 造大文件用 `node scripts/dev/make-big-jhyy.mjs 30000 out.jhyy` ✓
  （实测 1.4 MB / 12 万行：**打开 54 ms**（旧架构光建块树就 1264 ms）、
  **首屏 49 ms**（O(1)，跟文件大小无关）、
  **打 20 个字 100 ms**（旧架构 199 ms）⇒ 在 jsdom 里量的，**比值有意义** ✓）

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
