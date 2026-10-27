# JHYY IDE — Wiki

**Block-based. Code-based. Talks to Claude Code.**

[JHYY IDE](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) is a desktop IDE for
[JHYY (机会翼游)](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) — a self-hosted,
statically typed, expression-oriented systems programming language.

It puts three things side by side:

| View | What it is | Who it is for |
|---|---|---|
| **Block view** | [Blockly](https://blockly.google.com/) workspace — drag blocks to program | beginners, and anyone who prefers a visual surface |
| **Text view** | [CodeMirror 6](https://codemirror.net/) — write code like in any editor | anyone who wants the full language |
| **Claude Code** | the `claude` CLI that is already on your machine, embedded | anyone who wants an AI pair programmer |

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
| [Getting Started](Getting-Started) | install, open a file, run it, the three views in practice |
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
