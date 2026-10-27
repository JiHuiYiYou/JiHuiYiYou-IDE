# CLAUDE.md

JHYY IDE —— 给 **JHYY（机会翼游）** 做的桌面 IDE。

## 这是什么

一个 Electron 桌面应用，三件事合在一起：

1. **拖块编程**（Blockly）—— 入门友好
2. **正常写代码**（CodeMirror 6）—— 承担完整语言能力
3. **内嵌 Claude Code 对话** —— 直接对话本机的 `claude` CLI，能读写项目文件

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
npm test          # 359 个测试，含 278 个真实编译器的往返验证
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
    watcher.ts         监听外部改动
  preload/             contextBridge 窄接口
  renderer/            UI
    editor/            CodeMirror 6 + JHYY 语言模式
    blocks/            Blockly 块定义 + 适配器
    panes/             各个面板
    sync/              块 ↔ 文本同步
  shared/              主/渲染共用的类型
```

## 命令

```bash
npm run dev          # 开发
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # 测试（359 个）
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
- **编译器没有错误恢复**，第一个错就 bail —— 所以每次编译只有一条诊断。
- **编译器的跨阶段临时文件走相对 CWD 的路径**（`compiler/build/obj/…`），
  而它**不会自己创建那个目录** —— IDE 得给编译器一个可写的 CWD。
- **子进程的 PATH 只「追加」，绝不「替换」**（语言仓库 W-156 的教训）：
  继承来的 PATH 一个字都不能丢 —— CI 上 setup-msys2 把 MSYS2 装在
  `$RUNNER_TEMP\msys64`，整个替换掉 ⇒ windres 找不到 ⇒ 几百个测试全挂。
  见 `src/main/compiler/env.ts`。
- **Blockly 13 里 `setNextStatement(true)` 不再创建 previousConnection**，
  语句块必须显式 `setPreviousStatement(true)`。
- **Blockly 的字段必须显式给名字**，否则会建出空名字的字段，读回来时找不到。
- **Blockly 的 `workspace.render()` 只是排队**（rAF）—— 窗口没焦点时不画，
  要 `Blockly.renderManagement.triggerQueuedRenders()` 强制刷一次。
- **Claude Code 2.1.302 没有 `--max-turns`、也没有 `--permission-prompt-tool`**。
  用 `--max-budget-usd` 和 `--allowedTools` 代替。
- **Claude Code 的 `--system-prompt` 会替换掉内置 system prompt**（工具用法说明会丢）——
  要用 `--append-system-prompt`。

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
