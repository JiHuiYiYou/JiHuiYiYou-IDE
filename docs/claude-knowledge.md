# 内嵌 Claude 会话：知识供给与评测

> 内嵌的 `claude` CLI 会话要**写得出能通过真实编译器的 JHYY 代码**。
> 这份文档说明两件事：**它靠什么知道 JHYY**（知识供给），以及
> **我们怎么知道它写得好不好**（评测）。

## 一、知识供给：三层

```
┌─ L1 常驻（system prompt，约 13.5k 字符）──────────────────┐
│  · 规范章节目录（25 章）—— 让模型知道该查哪一节              │
│  · 反直觉点（58 条）—— 规范里标了 ⚠ 的行                    │
│  · 附录 B「未实装」（15 项）+「已实装但受限」（19 行）      │
│  · 标准库公开 API（8 模块 / 45 函数）                        │
│  · 附录 D 的完整示例程序                                    │
└───────────────────────────────────────────────────────────┘
┌─ L2 按需（jhyy MCP 工具）──────────────────────────────────┐
│  jhyy_lang_ref   查规范（章节号精确查 / 关键词查）           │
│  jhyy_check      真编译，拿真实诊断                          │
│  jhyy_run        真跑                                        │
│  jhyy_workarounds 查已知坑台账                               │
└───────────────────────────────────────────────────────────┘
```

### L1 从哪来 —— **生成，不手写**

- **真相源**：语言仓的规范（`../JiHuiYiYou/docs/abis/jhyy-lang-spec-v4.0.0.md`）
  与标准库源码（`../JiHuiYiYou/compiler/src0/std/*.jhyy`）。
- **生成器**：语言仓的 `scripts/gen-knowledge.py` ⇒ 产物
  `../JiHuiYiYou/docs/generated/jhyy-knowledge.md`。
- 规范改了 ⇒ 重新生成 ⇒ **不会漂移**（手写第二份 = 制造漂移源）。

⚠️ **标准库 API 表以源码的 `// API:` 块为准**，**不抄规范 §15 那张表** ——
后者把 fmt 的内部 helper（`digit_char` / `hex_char`）和一个根本不是 stdlib 函数的
`ptr_add` 也列成了「公开 API」。

### L1 怎么进模型 —— **走文件通道**

- 知识包 + IDE 当前状态 → 写临时文件 → `--append-system-prompt-file`。
- ⚠️ **不能用 `--append-system-prompt` 内联传知识包**：Windows 整条命令行有
  **32767 字符**上限，知识包（中文 ~13.5k 字符）再加工具参数就贴上限了。
- ⚠️ `--append-system-prompt-file` 是**隐藏 flag**（`--help` 里没列）。
  实测本机 claude 2.1.302 支持，且与 `--append-system-prompt` **可共存**
  （两个通道的内容都进模型上下文）。

**验证**：`npm run eval:probe` —— 用一个只存在于提示文件里的标记串证明
「知识包确实进了模型上下文」。

### L3 编译回灌 —— **PostToolUse hook**

**模型一写完 `.jhyy`，IDE 立刻编译，把真实诊断喂回上下文。**

动机来自实测（轨迹归因，32 道题）：**「验证」占了 31~34% 的轮数**，
其中「模型自己想起来要去编译」这一段**可以由系统代劳**
⇒ 从「靠模型的自觉」变成「**系统的保证**」。

| 环节 | 位置 |
|---|---|
| 钩子脚本 | `scripts/jhyy-check-hook.mjs` |
| settings 生成 | `src/main/claude/hooks.ts`（`buildHookSettings`） |
| 接入 | `src/main/claude/session.ts`（`--settings` + `--include-hook-events`） |
| 打包 | `package.json` 的 `extraResources`（**必须放 asar 外面** —— asar 里的文件没法被外部 node 执行） |

**三条设计约束**：

1. **钩子永远 exit 0** —— 它只**提供信息**，绝不阻断会话（阻断用 exit 2，会让 IDE 看起来卡死）。
2. **没错误就不出声** —— 不注入噪音 = 不浪费上下文。
3. **要连链接一起做** —— 入口写成 `fn main`（该是 `main_jhyy`）是**链接期**错误；
   只查语法/语义会**整个漏掉它**。

⚠️ **已知缺陷（语言仓 W-226）**：链接失败时 gcc/ld 的真实原因被吞掉，
只剩「ld returned 1 exit status」⇒ 钩子补了一条针对性提示兜底
（编译器侧的正式修法要改 `compiler/src0/main.jhyy` ⇒ 属发版级改动，单独立项）。

**验证**：`npx vitest run tests/claude/hook.test.ts`（5 个测试：注入诊断 / 不出声 /
非 .jhyy 不出声 / 非写文件工具不出声 / 垃圾输入仍 exit 0）。

### 读不到语言仓时的降级

知识包读不到 ⇒ **不报错** ⇒ 退回手写速查表（`src/main/claude/jhyy-rules.ts` 里那 12 条）。

## 二、评测：把「写得好不好」变成数字

### 任务集长什么样

从回归语料里挑**能编译、有 EXPECT 判据**的文件，按一条反直觉规则**改坏一处**：

```
原文件（能跑、退出码 30）
   ↓ 变异（改坏一处）
坏版本（编译不过 / 或行为变了）
   ↓ 交给模型
题目 = 「把这段代码修好」
   ↓
判据 = 编译通过 **且** 退出码一致 **且** stdout **逐字**一致
```

⇒ 「删掉出错那行」「重写成 `return 0`」都蒙混不过。

**两种破坏方式**：

| 方式 | 含义 | 例 |
|---|---|---|
| `compile-break` | 变异后**编译不过** | `type X = struct {...};` 多个分号 |
| `behavior-break` | 变异后**还能编译，但行为变了** | `match` 的闭区间当半开 |

### 任务集怎么来的 —— **从语料长出来，不手写**

`npm run eval:tasks` ⇒ 挑语料 + 施加变异 + **逐题真编译真跑**，
验「原文件能过、变异后真坏」⇒ 挂不上的直接丢弃。

### 三个硬约束

1. **判据必须硬** —— 编译 + 退出码 + stdout 逐字，三条都要满足。
2. **CLI 没有 seed flag** ⇒ **单次结果不可信** ⇒ A/B 必须 n≥3 重复取中位数 + 报离散度。
3. **「知识包有效」不能做成硬门** —— 模型自己会变强，阈值断言迟早误红。
   硬门只该断言「评测有区分力」和「知识包自洽」。

### 跑一次要多少钱

一次平凡的 `claude -p` ≈ $0.085；带工具的真实任务 ≈ $0.3（10–30 轮）。
**32 道题 × 1 臂 ≈ $10 / 约 1 小时。** ⇒ 别在每次提交时跑。

## 三、实测得到的三条结论

> 数字见语言仓 `docs/internal/FACTS.md` § 8（会变的数字只写在那里）。

1. **模型的失败模式不是「不知道规则」，而是「多绕几圈」** ⇒
   知识包的价值是**让它少绕**，不是「再教一遍规则」（规则 MCP 已经能查）。
2. **规则级题目对现在的模型太简单** ⇒ 知识包要覆盖**规范不会主动告诉它**的东西：
   附录 B「未实装」清单（模型不会想到去查）、台账里的坑。
3. **按章标题查规范曾经查不到**（语言仓 W-225）⇒ 分节时丢掉空正文的 section
   把整段章吞了 ⇒ 已修 + 加了回归门 `mcp-jhyy/tests/test_spec_sections.py`。

## 四、文件清单

| 文件 | 干什么 |
|---|---|
| `src/main/claude/jhyy-rules.ts` | 常驻知识（知识包优先 / 手写速查表兜底） |
| `src/main/index.ts` | `writePromptFile()` —— 常驻提示写临时文件 |
| `src/main/claude/session.ts` | 支持 `systemPromptFile` → `--append-system-prompt-file` |
| `scripts/eval/mutations.ts` | 变异目录（8 种 / 2 种破坏方式） |
| `scripts/eval/tasks.ts` | 任务构建器（真编译验证） |
| `scripts/eval/grader.ts` | 判分器（编译 + 退出码 + stdout 逐字） |
| `scripts/eval/trajectory.ts` | 轨迹解析（版本重建 / 路径归一） |
| `scripts/eval/run-eval.ts` | harness（起 claude / 逐版判分 / 落盘 JSONL） |
| `scripts/eval/compare.ts` | A/B 对比 |
| `scripts/jhyy-knowledge-probe.ts` | 知识包注入探针 |
| `eval/tasks.json` | 任务集（进仓） |
| `tests/eval/trajectory.test.ts` | 门 2（mock 自检，不花钱） |
