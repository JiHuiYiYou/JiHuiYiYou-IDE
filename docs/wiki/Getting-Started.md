# Getting Started

## 1. Install

### The IDE

Download the installer from
[Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) (`JHYY-IDE-x.y.z-x64-setup.exe`).
Windows x64 only — that is the only platform built and tested so far.

> The installer is **not code-signed**, so Windows SmartScreen will complain once.
> Choose "More info → Run anyway".

Building from source works too:

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE
npm install
npm run dev        # development
npm run dist       # NSIS installer → release/
```

## 2. The compiler

The IDE **needs** `jhyy.exe` — it is the referee for every compile and every diagnostic.
The IDE looks for it in this order:

1. the path you configured in the IDE settings
2. the `JHY_EXE` environment variable
3. `../JiHuiYiYou/compiler/build/bin/jhyy.exe` — the development build, next to this repo
4. `C:\Program Files\JHYY\bin\jhyy.exe` — the official installation
5. `jhyy.exe` on `PATH`

The official installer for the language is in the
[compiler repository](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler). If you clone
that repository as a **sibling** of this one, step 3 finds the compiler with no
configuration at all:

```
coding/
├── JiHuiYiYou/          ← the compiler repo
└── JiHuiYiYou-IDE/      ← this repo
```

> **The compiler needs a working gcc.** Linking is done by MSYS2's
> `mingw-w64-ucrt-x86_64-gcc`. Do **not** use the MinGW gcc that ships with Git Bash
> (`C:\Program Files\Git\mingw64\bin\gcc.exe`) — it cannot link PE and fails with no
> message at all.

## 3. Open a program

`File → Open…` any `.jhyy` file. A minimal one:

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

Press **Run** (or `F5`). You get:

- **Output** — the program's stdout / stderr, and its exit code
- **Problems** — the compiler's own diagnostics, `file:line:col: error: …`

The bottom panel is **collapsed every time the IDE starts** — **Run** opens it on the
Output tab, **Check** (`Ctrl+Shift+D`) opens it on the Problems tab. `Ctrl+J` toggles the
panel itself. It sits under the editor only; the chat sidebar keeps its full height.

The exit code is the value `main_jhyy` returns — that is how the language's regression
suite asserts behaviour, so the IDE asserts the same way.

> `print` is **not** a builtin. JHYY has no `print`/`println`; output goes through
> `extern fn printf` or `io::std_io_print`.

## 4. The workbench

### The title bar

The window has **no native frame** — the title bar is drawn by the IDE, just like VS
Code's:

- **文件 / 编辑 / 选择 / 查看 / 转到** — the menus. Every entry is generated from the
  same command table the shortcuts use, so the shortcut shown next to a menu item is
  always the one that actually works.
- **命令中心** — the search box in the middle. Click it (or press `Ctrl+Shift+P`) for
  the **command palette**: type a few letters, pick a command, done.
- **🧩** — toggle the block view. **💬** — toggle the chat sidebar. **▣** — the layout
  dropdown (menu bar / sidebar / panel / status bar).

### Keyboard shortcuts

| Chord | Action |
|---|---|
| `Ctrl+Shift+P` | 命令面板 |
| `Ctrl+Shift+B` | 切换 块视图 / 文本视图 |
| `Ctrl+S` / `Ctrl+O` | 保存 / 打开 |
| `F5` / `Shift+F5` | 运行 / 停止 |
| `Ctrl+Shift+D` | 检查 |
| `Ctrl+J` | 显示/隐藏 底部面板 |
| `Ctrl+Shift+M` / `Ctrl+Shift+U` | 问题 / 输出 |
| ``Ctrl+` `` | 终端 |
| `Ctrl+Alt+I` | 聊天 |

The **查看** menu and the command palette carry the full table.

### Text view

A normal editor: syntax highlighting, bracket matching, auto-close, `Ctrl+F` search,
completion, hover documentation, and live diagnostics (the compiler is asked to check
the file ~600 ms after you stop typing — that check skips linking, so it is fast).

Files open in **tabs** — opening a second file keeps the first one around, and each tab
remembers its own content, dirty state and blocks. The dirty dot is derived from the
content (like VS Code), so undoing back to the last saved version clears it.

### Block view

The same program as draggable blocks. Blocks cover the introductory subset — variables,
arithmetic, `if`/`else`, `while`/`for`, functions, structs, enums + `match`, `printf`.

- **The first toolbox category is "Getting started"** — function, print, call,
  number/string, variable, return and **C function declaration**. Every block you need
  for your first program is on that first screen, instead of hunting through six
  categories. The rest (variables / expressions / control flow / functions / types /
  raw code) follows.
- **C function declarations have a block.** The first line of every JHYY program is
  `extern fn printf(fmt: *u8, val: i32) -> i32;`, which used to mean typing it into a
  raw-code escape hatch. Now you drag a **"C function declaration"** block and pick
  `printf` / `puts` / `malloc` / `free` / `exit` from the dropdown — the parameter list
  and return type fill themselves in (and stay editable).
- **Expressions are one row with two holes** — `a + b` sits on **one** line with the
  operator **in the middle** (`[a] [+] [b]`), and assignment likewise
  (`[target] = [value]`).
- **Types are dropdowns** — pick `i8`/`i16`/`i32`/…/`bool` instead of typing it
  (and "（不写）" for `let x = 0`).
- **`printf` is its own block** — one format dropdown plus one value hole; **no**
  dragging "argument" blocks inside "argument" blocks.
- **There's a ready-made "read input" block** — `scanf("%d", &x)` is one block (the
  address-of is added by the block itself), and the C function declaration
  dropdown has a `scanf` preset.
- **Every container is labelled** — "成立时" / "否则" / "循环体" / "函数体" / "参数" /
  "字段" / "变体" / "分支" / "元素", so there's no guessing which is which.
- **The block canvas fills the whole editor area, and the code editor is gone.** They
  never share the screen. Toggle with the 🧩 button, `Ctrl+Shift+B`, or the command
  palette. Both keep their state while you switch — the canvas keeps its zoom and pan,
  the editor keeps its undo history and cursor.
- **Block → text** is live: drag a block, the text updates.
- **Text → blocks** happens when you switch back to the block view (rebuilding blocks on
  every keystroke would make the canvas unusable). The 🧩 button grows a dot when the
  blocks are stale.
- Anything the block subset cannot express shows up as an **opaque block** holding the
  original source. Move it, delete it — but as long as you leave it alone, that code
  round-trips byte for byte.

### Claude Code

The chat in the right-hand sidebar talks to the `claude` CLI on your machine. It can read
and write project files; when it changes a file the IDE is watching, the editor reloads
it (and asks first if you have unsaved changes — it never silently overwrites your
work).

See [Claude Code](Claude-Code) for the details, including how Claude gets to run
`jhyy_check` itself.

### Panel and terminal

The bottom panel holds three tabs:

- **问题** — the compiler's diagnostics. Click one to jump to that line and column.
- **输出** — the program's stdout / stderr and the compiler's own log, coloured by source.
- **终端** — a real shell (**MSYS2 bash** by default; PowerShell and `cmd` are available too).
  It starts in the directory of the file you have open.

> ⚠️ The terminal runs over **pipes, not a PTY**, so full-screen TUI programs
> (`vim`, `top`) will not work. Everything else does — and the output is UTF-8 even on
> a Chinese Windows.

Like VS Code's integrated terminal, it **mirrors the commands the IDE runs**: press
**Run** and the terminal shows `> jhyy compile "…"` followed by the program's output.

With no file open, the editor shows a **welcome page** (open / new file) rather than a
sample program.

## 5. Where to go next

- [Architecture](Architecture) — how the pieces fit together
- [Block Subset](Block-Subset) — what is blockable and what is not
- [Troubleshooting](Troubleshooting) — when something does not work
