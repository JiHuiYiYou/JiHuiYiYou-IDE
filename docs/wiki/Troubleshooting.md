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

## The terminal

### The terminal is empty, or the shell never starts

The terminal is **lazily spawned**: the shell process only starts the first time you
switch to the **终端** tab. If the tab stays blank, look at the panel's action buttons —
there is no error toast. The most common cause is a shell that is not where the IDE
expects it: the MSYS2 bash lives at `C:\msys64\usr\bin\bash.exe` (the `ucrt64` one does
**not** exist).

### Backspace moves the cursor but doesn't delete anything

That was PowerShell. **Over a pipe, PowerShell's line editor (PSReadLine) is broken** — it
eats the backspace byte raw, and a backspace at the start of the line can wedge the whole
shell. The IDE therefore **defaults to MSYS2's bash**, whose readline does real line
editing over a pipe: backspace erases, the arrow keys move, history works, and you see
what you type as you type it.

If you switch the terminal to PowerShell, backspace is sent as `BS (0x08)` instead of the
`DEL (0x7f)` that xterm.js normally emits — that is what PowerShell expects.

### The program's output gets executed as commands

Not any more. The IDE used to write the program's stdout into the shell's **stdin** (which
is *input*). Output now goes to the display only.

### `vim` / `top` / other full-screen programs do not work

The terminal runs the shell over **pipes, not a PTY**. Without a PTY the child process
does not think it is on a terminal, so programs that take over the screen refuse to run.
Everything line-oriented works fine — `dir`, `gcc --version`, `jhyy run foo.jhyy`, pipes,
redirection.

A real PTY needs `node-pty`, which needs a C++ toolchain to build for Electron. This
machine has no MSVC, so the IDE does not depend on it.

### Chinese output in the terminal is mojibake

It should not be — the IDE forces UTF-8 on the shell it starts, and detects the OEM
code page for `cmd`. If you see mojibake in the **terminal**, check that you are not
looking at a `cmd` session whose messages come from the system in the OEM code page.

(Mojibake in the **output panel** is a different story — see below.)

### The terminal doesn't show a prompt after the IDE runs a program

The missing bit is the `user@host ~/dir` line. When the IDE runs a command it only
**echoes** it into the terminal (like VS Code's task terminal) — the shell itself never
learns that the command finished, so it stops printing prompts.

The IDE now sends an empty line to the shell's **stdin** after the command, so the
**shell itself** prints the prompt (every shell formats and escapes its prompt
differently, so drawing it by hand would never match).
⚠️ The IDE does **not** do this while you are **typing a command** — that would run
your half-typed command.

## The window and the shell

### `Ctrl+C` / `Ctrl+V` / `Ctrl+Z` do nothing, or `F5` reloads the window

That is Electron's **default application menu** stealing the accelerators. The IDE calls
`Menu.setApplicationMenu(null)` in the main process for exactly this reason — if you ever
remove that call, `F5` will reload the whole IDE and `Ctrl+C` will stop working.

### The window has no title bar / the buttons are in the wrong place

The window is frameless on purpose (`titleBarStyle: 'hidden'` + `titleBarOverlay`): the
IDE draws the title bar itself and the OS draws the minimise/maximise/close buttons on
top of it. The title bar keeps ~138px free on the right for them.

### You cannot type in the editor — it looks read-only

Everything looks normal (you can select, scroll, the caret is there) but **not a single
character gets in**.

That is CodeMirror's `indentOnInput()` extension **throwing**: it is a **transaction
filter**, and on every input it runs `rules.some(r => r.test(lineStart))`. If the
language data declares `indentOnInput` as `true` instead of a **regular expression**,
`true.test` is not a function ⇒ TypeError ⇒ **the whole input transaction is dropped**
⇒ nothing you type ever lands.

Rule: `languageData.indentOnInput` **must be a RegExp** (CodeMirror's own words:
*which must hold a regular expression*). `tests/renderer/jhyyLanguage.test.ts` pins
this — it asserts directly that "an input transaction does not throw".

### A selection within a single line is almost invisible

Two causes stack up:

- **The active-line background covers the selection.** `highlightActiveLine()`
  puts the background on the **line div itself**, which lives in the **content
  layer** — **above** the selection layer (whose z-index is -1). Opaque ⇒ the
  selection on the cursor's line is completely hidden. The IDE makes the active
  line **translucent**.
- **The selection colour is overridden by CodeMirror's own theme.**
  `drawSelection()` sets the **browser-native** selection to transparent ⇒ the
  only visible selection is the one CodeMirror draws itself, and that uses the
  base theme's dark blue-grey `#222`/`#233`. The IDE's accent colour
  `rgba(0, 212, 170, 0.34)` needs `!important` to win.

### Opening a CRLF file crashes (`RangeError: Selection points outside of document`)

When CodeMirror loads a string it splits it on `/\r\n?|\n/` ⇒ **the `\r` is
dropped**. So the document is **always LF**, while the file on disk may be CRLF ⇒
the two lengths disagree ⇒ the selection is computed **outside the document** ⇒
the transaction throws and the whole editor goes down.

The IDE **normalises to LF when reading and restores the original line endings
when saving** — no crash, and your files keep their line endings.

### The chat's history list is always empty

Three causes, all fixed:

- `claude --resume` only **reconnects** the conversation — it does **not** replay
  the history messages. ⇒ the IDE has to keep the conversation itself and put it
  back (the history entries now carry the whole dialogue ✓).
- And user messages used to be **dropped entirely**, so even a replay wouldn't show up.
- The session id is generated **by the IDE itself** (`--session-id`) ⇒ we never
  needed to wait for the CLI's `system/init` event at all. If the CLI fails to
  initialise (an unrecognised model name, say), that event never arrives.

The history entries now carry the whole dialogue (stored in localStorage ✓,
survives a restart); clicking one fills the chat back in ✓ while `--resume`
reconnects the CLI's context ✓.

### Running a `while true` program freezes the whole IDE

The program prints forever and the IDE concatenates its output **without any
limit** ⇒ memory is eaten ⇒ the machine starts paging ⇒ nothing responds.

Each stream's output is now **capped** (512 KB); past that the IDE **kills the
program** immediately and says "输出过多，已终止" in the status bar. The output
is also **streamed** as it arrives (like VS Code's task terminal).

VS Code doesn't freeze because it runs a **real PTY** (ConPTY on Windows): the
pseudo-terminal has a fixed buffer, so when the program writes faster than the
reader consumes, the **write blocks** (the program slows itself down), and
xterm.js renders incrementally with a bounded scrollback ⇒ memory always stays
bounded. We have no PTY, so we add the cap ourselves.

## The block view

### The blocks are empty / nothing renders

`Blockly`'s `workspace.render()` only **queues** a render for the next animation frame,
so nothing is drawn when the window does not have focus. The IDE forces it with
`Blockly.renderManagement.triggerQueuedRenders(workspace)`.

### Blocks do not connect

In Blockly 13, `setNextStatement(true)` **no longer creates a previous connection**.
Statement blocks must call `setPreviousStatement(true)` as well. And a `<statement>`
container holds a **chain** — several blocks in a row means emitting `<next>` elements.

### The block view crashes on open (`Attempt to connect incompatible types`)

In Blockly, **a block cannot have both an output connection and previous/next
connections**. When it loads XML it picks the child's connection **output first, then
previous** (it cannot tell `<statement>` from `<value>`) — so a block that is valid in
both positions (assignment / if / match / the escape-hatch block) has to be **split in
two**: a statement shape (`jhyy_set`) and a value shape (`jhyy_set_val`).

If the decompiler puts a statement-shaped block into an **expression position** (a value
input), or the two shapes get mixed up, you hit this error and the whole block view
crashes. `tests/renderer/blockWorkspace.test.ts` loads **every sample** so that a
missing definition turns the test red.

### An opaque block lost its code

Every field needs an **explicit name**. Blockly's `getField('CODE')` returns `null` for
an unnamed field, and the escape hatch's payload is gone with it.

### The text view changed but the blocks did not

That is by design: blocks are rebuilt when you **switch to the block view**, not on
every keystroke (rebuilding on every keystroke makes the canvas unusable). Switch views
once and they catch up. The 🧩 button grows a dot while the blocks are stale.

### The block canvas is empty or mis-sized after a layout change

Two things bite here:

- **Blockly 13 has no `ResizeObserver`.** It only re-measures when the *window* resizes.
  Any in-app layout change (collapsing the chat sidebar, opening the panel, switching
  views) leaves the canvas at a stale size — so the IDE watches the container itself and
  calls `Blockly.svgResize(workspace)`.
- **Never hide the block pane with `display: none`.** `svgResize` reads the container's
  `offsetWidth`, which is `0` when it is hidden, and the canvas ends up 0×0. The IDE
  hides the inactive view with `visibility: hidden` + `inert` instead, which keeps the
  layout box alive.

### The source changed by itself after touching the blocks

It should not — but it used to, and the cause is worth knowing: reading a block back
out of the XML used to use `querySelector`, which searches **all descendants**. A nested
input with the same name shadowed the outer one, so `fib(n - 1) + fib(n - 2)` came back
as `fib(n - 1) + 1`. The reader now scopes every lookup to direct children
(`:scope >`), and `tests/renderer/blockXml.test.ts` pins it down.

## Claude Code

See [Claude Code](Claude-Code#troubleshooting) for the tool-permission and MCP issues.

## The installation

### Windows SmartScreen blocks the installer

The installer is **not code-signed**. Choose "More info → Run anyway".

### The IDE opens but every compile fails

Almost always a missing or wrong `gcc` — see the top of this page.
