# Troubleshooting

## The compiler

### "compiler not found" / the Problems panel stays empty

The IDE needs `jhyy.exe`. It looks in this order: the path in the IDE settings → the
`JHY_EXE` environment variable → `../JiHuiYiYou/compiler/build/bin/jhyy.exe` →
`C:\Program Files\JHYY\bin\jhyy.exe` → `jhyy.exe` on `PATH`.

The fastest fix is to clone the [compiler
repository](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler) **as a sibling** of the IDE
repository:

```
coding/
├── JiHuiYiYou/          ← the compiler repo
└── JiHuiYiYou-IDE/      ← this repo
```

### "gcc link failed" — and no error message

The compiler links with `gcc`, and it needs a **real MSYS2 UCRT64 gcc**:

- Install MSYS2 and the `mingw-w64-ucrt-x86_64-gcc` + `mingw-w64-ucrt-x86_64-binutils`
  packages.
- **Never** use the MinGW gcc that ships with Git Bash
  (`C:\Program Files\Git\mingw64\bin\gcc.exe`) — it cannot link PE, and it fails
  *silently* (exit code 1, zero bytes of output).
- `gcc` must be reachable as a **Windows-style path**. A PATH that only contains MSYS-style
  entries (`/c/msys64/ucrt64/bin`) is not understood by the `cmd.exe` the compiler
  spawns.

### The compiler writes junk into my project

It does not — but it does need a **writable working directory**, because its
cross-stage temporary files use paths relative to the current directory
(`compiler/build/obj/…`) and the compiler does not create that directory itself. The IDE
gives it a scratch directory under the system temp folder. If you run `jhyy.exe` by hand
from a read-only directory, that is what you will see.

## Diagnostics

### The Problems panel shows the position as empty

The compiler's diagnostics are free text on stderr:

```
C:\path\to\file.jhyy:12:8: error: type mismatch in let
```

The regular expression has to be **drive-letter aware** (`^(.*):(\d+):(\d+):`). The
pattern used by the language repository's MCP server (`^([^:]+):`) cannot cross the
colon in `C:` — the position silently comes out empty.

### Only one error is shown

The compiler has **no error recovery**: the parser and the semantic analyser bail at the
first error. One compile ⇒ one diagnostic. Fix it, compile again.

### The compiler's progress messages pollute the output

On success the compiler still writes progress noise to stderr (`[1] imports start`,
`[4] codegen done`, …). The IDE filters those out — if you see them in a raw
`jhyy.exe` invocation, that is expected.

## The block view

### The blocks are empty / nothing renders

`Blockly`'s `workspace.render()` only **queues** a render for the next animation frame,
so nothing is drawn when the window does not have focus. The IDE forces it with
`Blockly.renderManagement.triggerQueuedRenders(workspace)`.

### Blocks do not connect

In Blockly 13, `setNextStatement(true)` **no longer creates a previous connection**.
Statement blocks must call `setPreviousStatement(true)` as well. And a `<statement>`
container holds a **chain** — several blocks in a row means emitting `<next>` elements.

### An opaque block lost its code

Every field needs an **explicit name**. Blockly's `getField('CODE')` returns `null` for
an unnamed field, and the escape hatch's payload is gone with it.

### The text view changed but the blocks did not

That is by design: blocks are rebuilt when you **switch to the block view**, not on
every keystroke (rebuilding on every keystroke makes the canvas unusable). Switch views
once and they catch up.

## Claude Code

See [Claude Code](Claude-Code#troubleshooting) for the tool-permission and MCP issues.

## The installation

### Windows SmartScreen blocks the installer

The installer is **not code-signed**. Choose "More info → Run anyway".

### The IDE opens but every compile fails

Almost always a missing or wrong `gcc` — see the top of this page.
