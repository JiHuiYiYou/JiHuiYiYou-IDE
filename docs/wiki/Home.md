# JHYY IDE — Wiki

**Block-based. Code-based. Talks to Claude Code.**

[JHYY IDE](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) is a desktop IDE for
[JHYY (机会翼游)](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) — a self-hosted,
statically typed, expression-oriented systems programming language.

It is a **VS Code-style workbench**:

| Piece | What it is | Who it is for |
|---|---|---|
| **Text view** | [CodeMirror 6](https://codemirror.net/) — write code like in any editor | anyone who wants the full language |
| **Block view** | [Blockly](https://blockly.google.com/) workspace — drag blocks to program. **Full-screen and exclusive with the text view** (`Ctrl+Shift+B`) | beginners, and anyone who prefers a visual surface |
| **Claude Code** | the `claude` CLI that is already on your machine, embedded in the right sidebar | anyone who wants an AI pair programmer |
| **Bottom panel** | Problems / Output / a **terminal**. Hidden by default — it opens on **Check** or **Run** | anyone who wants to see what the compiler said |

The shell is drawn to match VS Code: a self-drawn title bar (menu bar, command centre,
layout toggles), a command palette on `Ctrl+Shift+P`, a status bar, and the usual chords.

## The one rule that makes it work

> **The block view and the text view share one AST.**
> Change a block and the text updates; change the text and the blocks rebuild.
> They can never disagree about what a program means.

Code that blocks cannot express (generics, closures, pointers, borrows, slices, `defer`,
`asm!`, attributes) survives as an **opaque block** holding the original source text — it
never silently disappears.

And the referee is always the real compiler: the IDE never guesses whether a program is
valid — it asks `jhyy.exe` and shows you the compiler's own diagnostics.

## Pages

| Page | What's in it |
|---|---|
| [Getting Started](Getting-Started) | install, open a file, run it, the workbench in practice |
| [Architecture](Architecture) | the layers, the data flow, and where to change what |
| [Block Subset](Block-Subset) | what has blocks, what is the escape hatch, how to add a block |
| [Claude Code](Claude-Code) | the embedded session, the MCP wiring, permissions |
| [Troubleshooting](Troubleshooting) | the failure modes you will actually hit |
| [Contributing](Contributing) | dev setup, the gates, the conventions |

## In one command

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE && npm install && npm run dev
```

You also need the **JHYY compiler** — the IDE looks for it automatically (see
[Getting Started](Getting-Started#the-compiler)).

## Links

- [Repository](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) ·
  [Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) ·
  [Issues](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/issues)
- [The JHYY compiler](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) ·
  [Language spec](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler/blob/main/docs/abis/jhyy-lang-spec-v4.0.0.md)
- [中文](Home.zh-CN)
