# Architecture

## The shape of it

```mermaid
flowchart TB
    file["<b>.jhyy file</b><br/>on disk"]
    blocks["<b>Block view</b><br/>Blockly 13 workspace"]
    text["<b>Text view</b><br/>CodeMirror 6"]
    core["<b>src/lang/ — the language core</b><br/>lexer · parser · printer<br/>blocks: tree · decompile · compile"]
    tree["<b>BlockTree</b><br/>the IR between the AST and Blockly"]
    adapter["<b>Blockly adapter</b><br/>block tree to workspace (XML)"]
    main["<b>Electron main process</b><br/>compiler · claude · file watcher"]
    jhyy["<b>jhyy.exe</b><br/>compile · run"]
    claude["<b>claude CLI</b><br/>stream-json · MCP"]

    file -->|parse| core
    core -->|print| text
    core -->|decompile| tree
    tree -->|compile| core
    tree <--> adapter <--> blocks
    blocks -->|regenerate the source| core
    text -->|parse on view switch| core
    core -->|diagnostics| main
    main -->|compile · run| jhyy
    main -->|conversation| claude
```

## The layers

| Layer | Where | Role |
|---|---|---|
| Language core | `src/lang/` | lexer · parser · printer · block transforms |
| Block tree | `src/lang/blocks/tree.ts` | the IR between the AST and Blockly, plus the block catalogue |
| Decompiler / compiler | `src/lang/blocks/decompile.ts` / `compile.ts` | AST → block tree / block tree → AST |
| Blockly adapter | `src/renderer/blocks/adapter.ts` | block tree ⇄ Blockly workspace |
| Text editor | `src/renderer/editor/` | CodeMirror 6 + the JHYY language mode |
| Main process | `src/main/compiler/`, `src/main/claude/` | drives `jhyy.exe` and the `claude` CLI |
| Bridge | `src/preload/index.ts` | `contextBridge` — the renderer's only privileged surface |

## Three rules

### 1. The AST is the single truth

The block view and the text view are two projections of **one** tree:

```
source ──parse──▶ AST ──decompile──▶ block tree ──▶ Blockly workspace
                 ▲                                      │
                 └──────────── block tree ◀─────────────┘

block tree ──compile──▶ AST ──print──▶ source
```

`src/lang/` is **plain TypeScript** — no Electron, no Node, no Blockly — so the parser,
the printer and the block transforms are all unit-testable in plain Node.

Never write a second code generator for the block view. Two generators mean two
interpretations of the same program, and they will drift.

### 2. Printed code must be accepted by the real compiler

`jhyy.exe` is the referee. Every change to `src/lang/` has to survive the conformance
gate: the language repository's own example programs are parsed by the IDE, printed back
to source, and handed to the real compiler — then compiled, run, and compared against
their own `// EXPECT:` directives.

```
IDE parse ──▶ IDE print ──▶ real jhyy.exe ──▶ run ──▶ compare against // EXPECT:
```

### 3. The language rules come from the compiler, not from the docs

The compiler lives in `../JiHuiYiYou/compiler/src0/` and is **written in JHYY itself**.
When the documentation and the compiler disagree, the compiler wins.

## Where to change what

| You want to… | Touch |
|---|---|
| support a new syntax in the text view | `src/lang/lexer.ts`, `src/lang/parser.ts`, `src/lang/printer.ts` |
| give a construct a block | `src/lang/blocks/tree.ts` → `src/renderer/blocks/definitions.ts` → `decompile.ts` → `compile.ts` → `buildToolbox()` |
| change how the compiler is invoked | `src/main/compiler/` |
| change how Claude is invoked | `src/main/claude/` |
| change what the UI looks like | `src/renderer/` |

The IDE never re-implements the language. It parses the source, prints it back, and lets
the real compiler decide.

## Synchronisation semantics

| Direction | When | What happens |
|---|---|---|
| blocks → text | immediately (debounced) | the source is regenerated and the text view is replaced; the cursor is mapped back by longest common prefix/suffix |
| text → blocks | when you switch to the block view | the file is re-parsed and the blocks are rebuilt |

Rebuilding blocks on every keystroke would make the canvas jitter and be unusable, so it
only happens on the view switch. Anything that cannot be expressed as blocks becomes an
opaque block — and the IDE tells you when that happened.

## Process model

The Electron **main process** owns every privileged operation: running the compiler,
spawning the compiler's output, driving the `claude` CLI, watching files. The **renderer**
only draws and runs the pure-TypeScript language core. They talk through a narrow
`contextBridge` surface in `src/preload/index.ts` — `contextIsolation` on,
`nodeIntegration` off.
