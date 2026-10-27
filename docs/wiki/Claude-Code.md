# Claude Code

The right-hand panel of the IDE talks to the **`claude` CLI that is already on your
machine**. It is not a separate API integration — it is the same Claude Code you use in
the terminal, with the same account, the same MCP servers and the same skills.

That means: it can read and write your project files, run commands, and — because the IDE
mounts the `jhyy` MCP server — **check JHYY code against the real compiler** and fix its
own mistakes.

## How the session works

The IDE spawns the **native** `claude.exe` (not the npm `.cmd` shim — Windows `.cmd`
shims break `spawn` without a shell) and talks to it over a long-lived
`--input-format stream-json` / `--output-format stream-json` pipe.

```
IDE ──stdin──▶  {"type":"user","message":{…}}          one line per turn
IDE ◀──stdout──  {"type":"stream_event",…}              incremental text
                 {"type":"assistant","message":{…}}     a full message
                 {"type":"user","message":{…}}          a tool result
                 {"type":"result",…}                    the turn ended
```

The **same process** serves the whole conversation: the session id stays constant and
`result_index` counts the turns. Closing stdin (EOF) ends the session gracefully.

### The flags the IDE uses

| Flag | Why |
|---|---|
| `--input-format stream-json --output-format stream-json` | multi-turn over one pipe |
| `--verbose` | **required** by `--output-format stream-json` |
| `--include-partial-messages` | incremental text instead of one blob at the end |
| `--replay-user-messages` | echoes your message back, so the UI can confirm it landed |
| `--session-id <uuid>` | the IDE knows the session id before the process starts |
| `--resume <id>` | to continue an earlier conversation |
| `--permission-mode acceptEdits` | file edits are accepted automatically |
| `--permission-prompts none` | **never** block on a question the IDE cannot render |
| `--allowedTools Read,Edit,Write,MultiEdit,Glob,Grep,Bash,mcp__jhyy` | the tool surface |
| `--add-dir <dir>` | the project directory |
| `--mcp-config <json> --strict-mcp-config` | only the `jhyy` MCP server, nothing else |
| `--append-system-prompt "<JHYY cheat sheet>"` | teaches the model the language |

Two things worth knowing about Claude Code **2.1.302**:

- **There is no `--max-turns`.** Use `--max-budget-usd` if you need a ceiling.
- **There is no `--permission-prompt-tool`.** You cannot build an approval dialog inside
  the IDE; pre-approve with `--allowedTools` and let `--permission-prompts none` refuse
  everything else.
- `--system-prompt` **replaces** the built-in prompt (and with it the tool-use
  instructions). The IDE uses `--append-system-prompt` so the built-in behaviour survives.

## The jhyy MCP server

This is what makes the embedded Claude useful for JHYY: it can ask the real compiler
whether the code it just wrote is valid.

The IDE **reuses the `jhyy` MCP entry you already have** in `~/.claude.json`
(`mcpServers.jhyy`) — it does not hard-code a copy, so if you change your configuration
the IDE follows automatically. If there is no entry, it looks for `mcp-jhyy/server.py` in
the language repository and a Python that has `fastmcp` installed.

With it mounted, Claude can call:

| Tool | What it does |
|---|---|
| `jhyy_check` | parse + sema check, returns the compiler's diagnostics |
| `jhyy_run` | compile and run |
| `jhyy_compile` | compile only |
| `jhyy_lang_ref` | search the language specification |
| `jhyy_workarounds` | search the known-limitations ledger |

Ask it *"write me a Fibonacci program and run it"* and it will write the file, check it
with `jhyy_check`, and fix what the compiler complains about.

> **MCP tools have to be allowed explicitly.** `--permission-prompts none` refuses
> anything that would need a prompt — including MCP tool calls — unless the tool is
> listed in `--allowedTools`. That is why `mcp__jhyy` is in the list.

## Files, and who owns them

Claude can edit files in your project. The IDE watches them and reloads the open editor
when the file changes on disk.

- If you have **no unsaved changes**, the editor reloads silently.
- If you have **unsaved changes**, the IDE asks before touching anything.

Your buffer is never overwritten behind your back.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Claude answers but cannot call `jhyy_check` | `mcp__jhyy` is not in `--allowedTools` — it is, by default; check that the MCP server was found |
| The MCP server fails to start | the Python in your `~/.claude.json` entry must have `fastmcp` installed — the PATH `python` usually does **not** |
| Claude is slow to answer | the MCP server is started per session; give it a moment on the first turn |
| "Permission denied" style refusals | `--permission-prompts none` refuses anything not pre-approved — add the tool to `--allowedTools` |
| The conversation lost its context | the session was restarted — resume it with the session id shown in the panel |

See also: [Troubleshooting](Troubleshooting).
