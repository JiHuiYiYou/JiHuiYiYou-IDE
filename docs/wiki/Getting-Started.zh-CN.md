# 快速上手

## 1. 安装

### IDE 本身

去 [Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) 下安装包
（`JHYY-IDE-x.y.z-x64-setup.exe`）。目前只有 Windows x64 —— 也是唯一构建并验证过的平台。

> 安装包**没有代码签名**，所以 Windows SmartScreen 会拦一下。
> 选"更多信息 → 仍要运行"。

也可以从源码构建：

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE
npm install
npm run dev        # 开发
npm run dist       # 打 NSIS 安装包 → release/
```

### 编译器

IDE **需要** `jhyy.exe` —— 每次编译、每条诊断都由它裁决。IDE 按这个顺序找：

1. IDE 设置里配的路径
2. 环境变量 `JHY_EXE`
3. `../JiHuiYiYou/compiler/build/bin/jhyy.exe` —— 开发构建，在本仓库旁边
4. `C:\Program Files\JHYY\bin\jhyy.exe` —— 官方安装版
5. `PATH` 上的 `jhyy.exe`

语言的官方安装包在[编译器仓库](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler)。
把那个仓库 clone 成**本仓库的兄弟目录**，第 3 步就能零配置找到编译器：

```
coding/
├── JiHuiYiYou/          ← 编译器仓库
└── JiHuiYiYou-IDE/      ← 本仓库
```

> **编译器要一个能用的 gcc。** 链接是 MSYS2 的
> `mingw-w64-ucrt-x86_64-gcc` 干的。**千万别用** Git Bash 自带的 MinGW gcc
> （`C:\Program Files\Git\mingw64\bin\gcc.exe`）—— 它链不了 PE，而且失败时
> **一个字都不吭**。

## 2. 打开一个程序

`File → Open…` 任意 `.jhyy` 文件。最小的例子：

```rust
extern fn printf(fmt: *u8, val: i32) -> i32;

fn main_jhyy() -> i32 {
    let mut total: i32 = 0;
    for i in 0..10 {
        total = total + i;
    }
    printf("total = %d\n", total);
    total
}
```

按 **运行**（或 `Ctrl+R`）。你会看到：

- **输出** —— 程序的 stdout / stderr，以及退出码
- **问题** —— 编译器自己的诊断，`file:line:col: error: …`

退出码就是 `main_jhyy` 的返回值 —— 语言的回归套件就是这么断言行为的，IDE 也一样。

> JHYY **没有** `print` 内建。用 `extern fn printf` 或 `io::std_io_print`。

## 3. 三个视图

### 文本视图

一个正常的编辑器：语法高亮、括号匹配、自动补全、`Ctrl+F` 搜索、补全、悬停文档，
以及实时诊断（停手约 600ms 后编译器会检查一遍 —— 那次检查跳过链接，所以很快）。

### 块视图

同一个程序的可拖拽块形态。块覆盖入门子集 —— 变量、算术、`if`/`else`、
`while`/`for`、函数、结构体、枚举 + `match`、`printf`。

- **块 → 文本**是实时的：拖一下块，文本就跟着变。
- **文本 → 块**发生在你切回块视图时（每敲一个键就重建块，画布会抖到没法用）。
- 块子集表达不了的语法会变成一个**不透明块**，里面装着原始源码。
  挪它、删它都行 —— 只要你别动它，那部分代码**逐字节**往返无损。

### Claude Code

右边的面板在跟你机器上的 `claude` CLI 说话。它能读写项目文件；当你正盯着看的文件
被它改了，IDE 会重新加载（如果你有未保存的改动，它会先问一句 ——
绝不会悄悄覆盖你的活儿）。

细节见 [Claude Code](Claude-Code.zh-CN)，包括 Claude 怎么自己去跑 `jhyy_check`。

## 4. 下一步

- [架构](Architecture.zh-CN) —— 各部分怎么拼在一起
- [块子集](Block-Subset.zh-CN) —— 什么能块化、什么不能
- [疑难排查](Troubleshooting.zh-CN) —— 不顺的时候
