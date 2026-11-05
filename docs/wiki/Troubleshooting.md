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

**Fixed** — the terminal now runs on a **real PTY** (`node-pty` → Windows ConPTY) ⇒ the
child process really is on a terminal (`isatty(1)` is TRUE) ⇒ full-screen TUI programs
start normally ✓.

⚠️ `node-pty` is a **native module**: it only ships prebuilt binaries for **Node's**
ABI, and Electron needs its own ⇒ it has to be compiled, which needs the **MSVC
Build Tools** (one UAC prompt: `winget install Microsoft.VisualStudio.2022.BuildTools`).
The IDE's `postinstall` (`scripts/prepare-node-pty.mjs`) does that rebuild
automatically.

⚠️ **Without MSVC the IDE still installs and runs** — it falls back to the pipe backend
(below), where everything line-oriented works fine (`dir`, `gcc --version`,
`jhyy run foo.jhyy`, pipes, redirection) — only the TUI programs are out of reach.

### `node` / `go` are missing in the terminal — your tool paths are gone

The IDE does not start from a **login shell** ⇒ it inherits **the IDE's own**
environment ⇒ everything you added to `.bashrc` / `.bash_profile`
(**nvm, rbenv, pyenv, conda init, your own tools on PATH**) is missing.

The IDE now exports the environment from a **login shell** (`env -0`) in the
background at startup, caches it, and layers it onto the terminal's
environment ⇒ those tools come back ✓.

⚠️ Exporting takes ~0.5–1 s, so it happens **at startup in the background**,
not when you open the terminal ⇒ **editing `.bashrc` needs an IDE restart**.

### The terminal is "fake" — why `vim` / `top` refuse to run

**No longer true** — the terminal runs on a **real PTY** (`node-pty` → Windows
ConPTY) ⇒ the child gets a **console device** (`GetFileType(stdout) == 2`) ⇒
`isatty(1)` is TRUE ⇒ full-screen TUI programs run ✓ and the window size is tracked
live (`stty size` matches the terminal) ✓.

The backend is an **interface** (`PtySession` in `src/main/pty.ts`) with two
implementations:

| backend | when | what you get |
|---|---|---|
| **node-pty (ConPTY)** | default (MSVC installed) | real console, TUI programs, live resize, the console echoes what you type |
| **pipe** (`child_process.spawn`) | fallback — no MSVC ⇒ no native build | everything line-oriented works; no TUI, no live resize, and stdout is a **pipe** ⇒ the C runtime **fully buffers** it |

⇒ The `setvbuf(stdout, NULL, _IONBF, 0)` in the **language repository**
(`compiler/runtime/runtime.c`) stays as the **belt-and-braces** fix ⇒ the prompt is
visible wherever you run the program, pipe or not ✓.

### Chinese output in the terminal is mojibake

It should not be — the IDE forces UTF-8 on the shell it starts, and detects the OEM
code page for `cmd`. If you see mojibake in the **terminal**, check that you are not
looking at a `cmd` session whose messages come from the system in the OEM code page.

(Mojibake in the **output panel** is a different story — see below.)

### The terminal doesn't show a prompt after the IDE runs a program

**It does now** — the prompt comes back, and the terminal stays alive.

**How it used to work**: the IDE ran the program with VS Code's **task terminal**
model, i.e. the command was the shell's **launch argument**
(`bash -c "…"` / `powershell -Command "…"`) ⇒ the shell **ran the command and
exited** ⇒ a shell that exits never gets to print a prompt ⇒ you saw the command
line the IDE writes itself (`> jhyy compile …`), then the compiler's output and the
program's output — and **no prompt**.

**How it works now**: the IDE **types the commands into the terminal you already
have** ⇒ the program is a **child of that shell** ⇒ when it exits, the shell prints
its prompt again and **keeps running** ⇒ you can keep using the terminal.

⚠️ The IDE still **never** asks the shell for a prompt: writing a bare carriage
return into the shell's stdin would be a **real Enter keystroke** ⇒ the shell would
run **another whole prompt cycle** ⇒ you'd get **one prompt too many** (see the next
entry).

### Clicking "Run" prints nothing at all

**Symptom**: clicking **Run** shows the command line in the terminal, but the program's
output **never appears** (and the run may stay "running" forever).

Two causes, both fixed now — but they explain the symptom if you ever see it again:

① **PowerShell needs the call operator.** `'C:\…\prog.exe'` is a **string** in
PowerShell, not a command ⇒ the parser rejects the whole line ⇒ **the program never
starts**. (bash happens to accept it, because a quoted word that contains `/` is
treated as a path ⇒ **only the default shell was affected**.)

② **The pty host process never got the command.** The IDE prefers running the real
console in a **separate helper process** (so a native-module crash can't take the IDE
down). That request has to carry the command with it ⇒ if it doesn't, the helper starts
an ordinary **interactive** shell ⇒ **the command never runs** and the terminal never
exits ⇒ "running" stays lit. (Only that one path was affected ⇒ **whether the bug
appeared depended on whether node-pty was installed**.)

**Now**: the call operator is added (`& 'C:\…\prog.exe'`), and the command is passed
to the helper process too ⇒ the program runs and its output shows up ✓.

⚠️ **bash must NOT get the `&`** — in bash `&` is the **background operator** ⇒ the
compiler would run in the background ⇒ the shell would return to the prompt at once
⇒ the exit code would be a lie and the program would start before the artifact even
exists ⇒ **it always breaks**. `buildShellCommand()` gets this right per shell ✓.

### Clicking "Run" wipes the program's output from the terminal, leaving only a prompt

**Symptom**: with no terminal open, clicking **Run** starts the program, but its output
**vanishes** from the terminal and all you see is a `(base) PS C:\…>` prompt — while
the program is **still running**.

**Cause**: the IDE has two ways to run a program ——
① the program is a **child of the shell** (its output really is on the console
screen ⇒ a terminal repaint can't wipe it) ✓
② the program runs in **its own pty** and its output is *injected* into the terminal
⇒ ②'s output is **not** on the console screen ⇒ **a console repaint (resizing the
terminal) wipes it** ✗

Used to happen when you had **no terminal at all**: the IDE then had to create one,
and that terminal is **cold** (PowerShell has to boot, and your profile loads conda
⇒ the first prompt takes several seconds) ⇒ the IDE only waited **2 seconds** for the
shell integration ⇒ it usually timed out ⇒ it silently took route ② ⇒ output wiped.

**Now**: the program is **always a child of the shell** ⇒
⇒ the compiler output, the program output and the prompt are **all in one stream**
⇒ **the output survives** ✓
⇒ and the run is settled by the shell integration reporting "command finished"
⇒ so the IDE **waits for the integration to come up** before it types anything
(⇒ no output is written into a terminal that can't report back) ✓

⇒ If the shell integration is **not available** (that's `cmd`, or you set
`JHY_IDE_NO_SHELL_INTEGRATION=1`), the IDE falls back to the **task terminal**
model: it opens a separate terminal named **运行** / **检查**, and the command is the
shell's launch argument ⇒ the run still works, but **that terminal dies when the
command is done** ⇒ **degraded, and visible on purpose** ✓
⇒ The same fallback kicks in when your current terminal is **busy** (you are running
something yourself) ⇒ the IDE **never types into a busy terminal** ⇒ your command
isn't disturbed ✓

### The prompt shows up **again** after the program's output

**Symptom**: the program finishes, the terminal shows its output and then **another**
`(base) PS C:\…>` prompt — as if the prompt was printed twice.

**Cause**: the IDE used to have a "make the shell redraw its prompt" mechanism —
implemented by writing a **bare carriage return** (`\r`) into the shell's stdin. That
is a **real Enter keystroke** ⇒ the shell runs **another whole prompt cycle** ⇒ the
terminal ends up with **one prompt too many**.

Worse: in **PowerShell** that empty Enter creates an **empty history entry** ⇒ the
shell reports "command finished, exit code 0" ⇒ the IDE **finished the pending run
early with exit code 0** ⇒ **the program's real exit code was reported as 0**.

**Now**: that mechanism is **gone** — **the shell's prompt is the only prompt**
(same model as VS Code: the IDE never asks for a prompt). And the compile and the
program are **one command** (`jhyy compile "file" && <product>`) ⇒ the compiler
output, the program output and the prompt are **all in one stream** ⇒
**exactly one prompt per command** ✓.

### Closing a terminal still leaves "running" in the top right

**Symptom**: the program is running, you close that terminal ⇒ the program keeps
running and the UI still says "running".

**Cause**: the run wasn't **bound to its terminal**. On the fallback path (no shell
integration) the program runs in **its own pty** ⇒ closing the terminal **doesn't
kill it** ⇒ the IDE's result **never arrives** ⇒ "running" stays lit forever.

**Now**: the run **is bound to its terminal** (VS Code's model: the task is settled
by the **terminal's exit event**) ⇒ closing the terminal **kills the program** ⇒ the
run settles ⇒ the state clears ✓.
The "running" spinner lives on the **terminal tab** (spinner / ✓ / ✗) — the
bottom-right status bar shows **no program behaviour at all** ✓

### The program does not wait for input — `scanf` reads nothing

The IDE used to give the program the **null device** on stdin (immediate EOF) ⇒
any program reading stdin got EOF right away ⇒ `scanf` returned at once and the
program carried on.

Now the program runs **in a PTY** (a real console) and the IDE **feeds it whatever
you type in the terminal** ✓ (like VS Code's "run in terminal") — switch to the
**Terminal** tab, type, press Enter, and the program receives it ✓.

⚠️ Type into the **terminal** tab, not the **Output** tab — the output tab is the
read-only program output. What you type is **echoed** by the **console itself**
(a real console echoes the characters it receives — correctly, cursor position and
wide characters included) ⇒ the IDE must **not** echo it a second time, or every
character would appear twice.
(On the pipe fallback backend there is no TTY ⇒ the IDE echoes by itself.)

A program that has not finished after 60 seconds is **killed by the timeout**
(waiting for input has to leave you time to type); a program that prints forever is
killed by the **output cap** (512 KB) ✓.

### The program's prompt only shows up **after** you typed the answer

**Fixed** — the IDE runs the program in a **real console** (ConPTY) ⇒ the C runtime
does not buffer a console's stdout ⇒ the prompt shows up **at once** ✓.

The underlying rule (it explains why this ever happened) is **stdio buffering**: the
C runtime buffers stdout according to whether it is an **interactive device** —

| stdout is | buffering | `printf("enter a number: ")` |
|---|---|---|
| a console (`CONOUT$` in a real terminal) | line-buffered / unbuffered | **shows up at once** |
| a pipe (CI / `jhyy run \| less` / the IDE's pipe fallback) | **fully buffered** (4 KB at a time) | held back until the program exits |

So "`jhyy run` in cmd is fine, in the IDE it is not" was never about jhyy — it was
that the terminal hands the program a **console** while the IDE handed it a **pipe**.

⇒ Belt and braces: the fix also lives in the **program's own runtime**
(`compiler/runtime/runtime.c` is the C bridge every JHYY program links in): one
`setvbuf(stdout, NULL, _IONBF, 0)` at the entry point ⇒ stdout is unbuffered ⇒ the
prompt is visible wherever you run it ✓.

⚠️ That change is in the **language repository** (`JiHuiYiYou`), not in the IDE — the
IDE just links the compiler built from that runtime.

(Side effect: unbuffered stdout means one sentence can arrive in several pieces, so
the IDE **re-assembles the lines** itself — the prompt still shows up as one whole
line in the Output panel ✓)

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

### "Save As" selects the whole file name (extension included)

The Windows save dialog selects the **entire contents** of the "File name" box
(extension included) ⇒ you cannot edit just the base name.

The IDE now passes **only the directory, no default name** ⇒ the box starts empty
⇒ there is no selected extension ✓. **Everything else is unchanged**: the filter
still applies and the extension is still appended — type "hello" ⇒ "hello.jhyy".

### `Ctrl+V` does not paste in the editor

The global shortcut handler calls `preventDefault()` + `stopPropagation()` in the
**capture phase** on `window` ⇒ the browser therefore **never fires the `paste`
event** ⇒ the editor's own paste handling (CodeMirror 6's `handlers.paste`) never
receives anything ⇒ nothing gets pasted.

Rule: **do not steal keys the editor/browser handles natively**. The paste command
is flagged `native` (see `src/renderer/commands/types.ts`) ⇒ the global handler
lets it through and the browser dispatches `paste` itself — which is also faster
(it reads `event.clipboardData` directly, no IPC round trip).

`tests/renderer/paste.test.ts` pins this down: pressing Ctrl+V must **not** end up
`preventDefault`ed.

### A new, unsaved file shows up as "no file open" in the chat

An untitled file has **no path** (it does not exist on disk yet) ⇒ looking at
"is there a filePath?" cannot tell "the user has no file open" apart from "the user
opened a file that was never saved".

The chat panel's file chip now shows the **file name** (`未命名-1.jhyy`) ✓, and
Claude's system prompt carries the name plus **the content the user is editing**
(the disk copy does not exist, so without it Claude would only be guessing) ✓.

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

### A history session shows a sentence from the thinking process instead of the final answer

Models often open with "let me look at this file" (that is a **complete** assistant
message), call a tool, and only then produce the final answer. The rule for "which
text do we show" used to be `answer ?? streaming` — which **always prefers the older
complete message** ⇒ when the final answer arrives as a delta only (some CLI
versions send deltas and nothing else), the chat showed the opening sentence.

Now the **newest** text wins: a delta that arrived after the last complete message
takes precedence ✓.

On top of that, the history used to be saved only when the **number of turns**
changed ⇒ what got stored was the turn **while it was still being written** ⇒
restoring it showed half a conversation. Now it is saved whenever the content
changes (debounced) ✓.

### Clicking a history session takes several seconds to connect

Three causes, all fixed:

- **The main process was blocked**: finding "which python has fastmcp installed" used
  `execFileSync` (**synchronous**) ⇒ for the few seconds `import fastmcp` takes, the
  **whole IDE froze** (reported as "really slow and laggy"). It is asynchronous now
  and **warmed up in the background at startup** ✓.
- **Stopping the old session waited a fixed 1.5 s**: it now waits for the CLI to
  **exit on its own** (and moves on as soon as it does) ✓.
- **The UI waited for the connection before showing anything**: the history is now
  **filled in first**, the CLI is reconnected in the background ✓.

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
bounded. **We now run a real PTY too** — but the cap stays, because a program that
prints forever would still eat the IDE's memory (the PTY only bounds the *writer*,
not what we keep for the output panel).

### The program "crashed": `NTSTATUS0xC000013A` (exit code -1073741510)

**That is not a crash — it is you pressing Ctrl+C.**

`0xC000013A` is `STATUS_CONTROL_C_EXIT`: the process was terminated by Ctrl+C. Now that
the program runs in a **real console**, Ctrl+C really does kill the foreground
program (that is the point of a real console — before, the byte was just written into
a pipe and the program never noticed).

⇒ The IDE now says **"程序已中断"** instead of "程序崩溃" ✓.
(The IDE's **Stop** button kills the program the same way, so it reports the same thing.)

### The terminal is sometimes real and sometimes not

**Fixed, and now visible.** The status bar carries a small badge:

| badge | meaning |
|---|---|
| **PTY** | a **real console** (ConPTY) ⇒ TUI programs run, the window size is live, the program's prompt shows up at once |
| **管道** | the **pipe fallback** ⇒ no real TTY. The tooltip says why and what to do |

Two things used to make the terminal silently degrade to the pipe version:

1. **The native module is loaded lazily** — `require('node-pty')` does not touch
   `build/Release/conpty.node`; the **first spawn** does. And `npm install`
   **deletes** that file (node-pty's own `postinstall` wipes `build/Release` — its
   bug). The IDE now **warms it up at startup**, so the module is in Node's module
   cache and a later `npm install` cannot break the running IDE ✓.
2. **A working directory that no longer exists** — `CreateProcess` fails, node-pty
   throws, and the whole terminal quietly fell back to pipes. The IDE now looks for
   an existing directory **before** starting the process ✓.

If the badge says **管道**, run `npm install` once (the `postinstall` rebuilds
node-pty against Electron's ABI) and restart the IDE.

### The terminal spits out a bunch of empty prompts

**Fixed.** The root cause: the IDE ended the commands it sent to the shell with
**`\r\n`** — and to a shell that is **two** Enters (readline's two accept-lines) ⇒
the shell prints **two** prompts, with a blank line in between. Changing the
directory added two empty prompts; a few of those and you have the pile you saw.

⇒ The line ending now follows the backend: `\n` for the pipe, `\r` for the real
console — **`\r\n` is never sent**.

Two more holes are closed:

- **Prompts are not force-printed back-to-back** — one is only added after the
  IDE wrote something to the terminal (the echoed command / the program's output),
  and not at all when the terminal is already sitting at a prompt.
- **Nothing is added while you are not looking at the terminal** — running ten
  commands in the background no longer piles up ten empty prompts; you get **one**
  when you switch back to the **Terminal** tab.

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
