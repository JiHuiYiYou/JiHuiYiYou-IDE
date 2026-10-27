# 贡献者指南

> JHYY IDE 项目的贡献者门槛 —— 提交规则、PR 流程、AI agent 协作约定。
>
> **详细约定**：[`CLAUDE.md`](CLAUDE.md)（架构 + 三条铁律 + 语言规则）+
> [`docs/blocks-subset.md`](docs/blocks-subset.md)（块子集边界）。

## 入门

1. **读 [`README.md`](README.md)** —— 项目是什么、怎么跑、当前在哪
2. **读 [`CLAUDE.md`](CLAUDE.md)** —— **必读**。三条铁律（AST 是唯一真相 / 打印结果必须被真实编译器接受 /
   语言规则以编译器为准）都写在里面了
3. **把编译器仓库 checkout 在本仓库的兄弟目录** —— 一致性测试需要它：

   ```
   coding/
   ├── JiHuiYiYou/          ← 编译器仓库
   └── JiHuiYiYou-IDE/      ← 本仓库
   ```

   跑 `npm test` 时一致性套件会**真的**调 `jhyy.exe` 编译 —— 没有编译器仓库的话，
   那两个套件会**静默跳过**（这是最坏的情况：门看着是绿的，其实什么都没验）。

## 提交流程

### 1. 改前

- **从 main 拉新分支**：`git checkout main && git pull && git checkout -b feat/<short-name>` 或 `fix/<short-name>`
- **改动前 `git status` 看是否有 stale 文件** —— 避免误提交上次的临时产物
- **确认 git identity**：`git config --local user.name "JHYY"` +
  `git config --local user.email "15901598712@163.com"`（只动 `--local`，不动 `--global`）
- **改 doc 前先 fact-check** —— 限制是否仍存在 / 是否已 ship / 措辞是否过时

### 2. 改中

- **TypeScript**：`strict` 零错误，`npm run typecheck` 必须过
- **最小化改动范围**：不顺手 refactor，不加"将来可能有用"的代码
- **`src/lang/` 保持纯 TS** —— 不许引入 Electron / Node / Blockly 依赖（那是它能单测的前提）
- **不改 AI 内部指令**：`CLAUDE.md` + `~/.claude/projects/.../memory/` 是给 AI agent 的本地指令，
  不属公共贡献范畴

### 3. 改后必跑

| 改的文件 | 必跑 |
|----------|------|
| `src/lang/**`（解析器 / 打印器 / 块转换） | `npm test`（**含 287 个真实编译器一致性门**） |
| `src/renderer/**` | `npm run typecheck` + `npm test` + 手动起 `npm run dev` 看一眼 |
| `src/main/**` | `npm run typecheck` + `npm test`（含真实编译器集成测试） |
| `tests/**` | `npm test` |
| `docs/**` | `npm run typecheck`（代码引用变了要同步） |

> **`src/lang/` 的改动必须过一致性门。** 那一层是整个 IDE 的地基 ——
> 打印出来的代码如果真实编译器不认，IDE 生成的一切都是废的。

### 4. 提交

- commit message 用中文或英文都行，但**要说清"改了什么、为什么"**
- 结尾带 trailer：

  ```
  Co-Authored-By: MiniMax-M3 <noreply@MiniMax>
  ```

- 提交完**直接 push**，不用问"要 push 吗"
- push 前确认 `git show <sha> --no-patch` 的 `Author:` 是 `JHYY <15901598712@163.com>`

### 5. Ship

- 版本号进 `package.json` + `CHANGELOG.md`（**本文件加一节**，不要新建 `changelog-vX.Y.Z.md`）
- 打 tag `vX.Y.Z` → CI 会构建安装包并创建 GitHub Release
- **门没绿就发不出去** —— release 是 CI 的一个 job，不是独立 workflow

## 加一个新块

详见 [`CLAUDE.md`](CLAUDE.md) 的"加一个新块"一节。要点：

1. `src/lang/blocks/tree.ts` 里登记块类型 + 字段 / 输入 / 容器
2. `src/renderer/blocks/definitions.ts` 里写块定义
3. `src/lang/blocks/decompile.ts` 里反编译
4. `src/lang/blocks/compile.ts` 里编回
5. `src/renderer/blocks/definitions.ts` 的 `buildToolbox()` 里放进工具箱
6. **一个块不能既是值块又是语句块** —— 两种位置都要用就做两个变体
7. 跑 `npm test`
8. 更新 [`docs/blocks-subset.md`](docs/blocks-subset.md)（块子集边界变了）

## CI 的门

| 门 | 验的是什么 |
|---|---|
| `check` | 类型检查 + 单测（不含一致性） |
| `conformance` | 语言仓库的 284 个例子：IDE 解析 → IDE 打印 → 真实编译器编译 → 运行 → 比对 `// EXPECT:` |
| `release` | 打 tag 时构建安装包 + 创建 GitHub Release |

**CI 门必须真的走到它要验的路径。** 一道因为缺前置条件而**静默跳过**的门，
比没有门更隐蔽 —— run 是绿的，但什么都没验。改 CI 时注意这一点。

## AI agent 协作

- 本仓库的 `CLAUDE.md` 是**给 agent 的项目指令**，跟编译器仓库的同一份约定对齐
- agent 改代码时**必须跑门**（上面那张表），不许"看起来对就交"
- 报告结果要**忠实**：测试失败就说失败，别用"应该没问题"盖过去
