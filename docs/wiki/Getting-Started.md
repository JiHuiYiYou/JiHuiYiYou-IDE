# Getting Started

## 1. Install

### The IDE

Download the installer from
[Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) (`JHYY IDE-x.y.z-x64-setup.exe`).
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

Press **Run** (or `Ctrl+R`). You get:

- **Output** — the program's stdout / stderr, and its exit code
- **Problems** — the compiler's own diagnostics, `file:line:col: error: …`

The exit code is the value `main_jhyy` returns — that is how the language's regression
suite asserts behaviour, so the IDE asserts the same way.

> `print` is **not** a builtin. JHYY has no `print`/`println`; output goes through
> `extern fn printf` or `io::std_io_print`.

## 4. The three views

### Text view

A normal editor: syntax highlighting, bracket matching, auto-close, `Ctrl+F` search,
completion, hover documentation, and live diagnostics (the compiler is asked to check
the file ~600 ms after you stop typing — that check skips linking, so it is fast).

### Block view

The same program as draggable blocks. Blocks cover the introductory subset — variables,
arithmetic, `if`/`else`, `while`/`for`, functions, structs, enums + `match`, `printf`.

- **Block → text** is live: drag a block, the text updates.
- **Text → blocks** happens when you switch back to the block view (rebuilding blocks on
  every keystroke would make the canvas unusable).
- Anything the block subset cannot express shows up as an **opaque block** holding the
  original source. Move it, delete it — but as long as you leave it alone, that code
  round-trips byte for byte.

### Claude Code

The right-hand panel talks to the `claude` CLI on your machine. It can read and write
project files; when it changes a file the IDE is watching, the editor reloads it (and
asks first if you have unsaved changes — it never silently overwrites your work).

See [Claude Code](Claude-Code) for the details, including how Claude gets to run
`jhyy_check` itself.

## 5. Where to go next

- [Architecture](Architecture) — how the pieces fit together
- [Block Subset](Block-Subset) — what is blockable and what is not
- [Troubleshooting](Troubleshooting) — when something does not work
