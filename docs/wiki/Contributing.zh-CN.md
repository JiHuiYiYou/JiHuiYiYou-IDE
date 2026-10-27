# 贡献指南

谢谢你看这个 IDE。完整规则在仓库里的
[`CONTRIBUTING.md`](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/blob/main/CONTRIBUTING.md)，
这一页是精简版。

## 环境

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE
npm install
```

你还需要把**编译器仓库 clone 成兄弟目录** —— 一致性门要跑真实编译器：

```
coding/
├── JiHuiYiYou/          ← 编译器仓库（也 clone 一份）
└── JiHuiYiYou-IDE/      ← 本仓库
```

没有它，一致性套件会**静默跳过** —— 那是最坏的结果：门看着是绿的，其实什么都没验。

## 门

| 门 | 验的是什么 |
|---|---|
| `check` | 类型检查 + 单测 + 只编译的一致性门 |
| `conformance` | 每个示例程序：IDE 解析 → IDE 打印 → **真实编译器** → 运行 → 比对 `// EXPECT:` |
| `release` | 打 `v*` tag 时：构建 NSIS 安装包 + 创建 GitHub Release |

一道因为缺前置条件而**跳过自己的门，比没有门更隐蔽** —— run 是绿的，但什么都没验。
动 CI 的时候记住这点。

```bash
npm test                                  # 默认全套
npm run typecheck                         # strict TypeScript，零错误
JHY_CONFORMANCE_FULL=1 npx vitest run tests/conformance/run.test.ts   # 全量门
```

### 语料口径

一致性门跑的是语言仓库 `compiler/tests/examples/` 下的程序 —— **277 个**。
以 `_` 开头的文件**不进语料**，这是语言仓库自己的规则（它的回归 harness、
它的 MCP server、它的断言审计都排除）。那些文件断言的是跟机器绑定的事实 ——
比如编译器必须在 `C:\msys64\ucrt64\bin\gcc.exe` 找到 gcc —— 在 CI 机器上压根不成立。

## 约定

- **`src/lang/` 保持纯 TypeScript** —— 不依赖 Electron / Node / Blockly。
  这是语言核心能单测的前提。
- **不要写第二套代码生成器**给块视图。两套生成器 = 对同一份程序两种理解。
- **编译器是裁判。** IDE 从不裁决程序对不对。
- 注释和界面文案可以是中文；README 和 wiki 是双语的（English + 简体中文）。

## wiki 从哪来

wiki 的页面是**本仓库里的文件**，在 `docs/wiki/` 下 —— 所以它们跟别的代码一样被 review。
改了之后发布一下：

```bash
npm run publish:wiki
```

它把 `docs/wiki/*.md` 推到 GitHub 的 wiki 仓库。（**第一个** wiki 页面得在浏览器里
创建一次 —— GitHub 只从网页创建 wiki 仓库；之后 push 就好使了。）

## 提交信息

说清**改了什么、为什么**。中英文都行。
