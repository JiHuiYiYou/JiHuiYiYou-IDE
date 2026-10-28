# Contributing

Thanks for looking at the IDE. The full rules live in
[`CONTRIBUTING.md`](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/blob/main/CONTRIBUTING.md)
in the repository; this page is the short version.

## Setup

```bash
git clone https://github.com/JiHuiYiYou/JiHuiYiYou-IDE.git
cd JiHuiYiYou-IDE
npm install
```

You also want the **compiler repository as a sibling** — the conformance gate runs the
real compiler:

```
coding/
├── JiHuiYiYou/          ← the compiler repo (clone this too)
└── JiHuiYiYou-IDE/      ← this repo
```

Without it, the conformance suites **silently skip** — which is the worst outcome: the
gate looks green and verified nothing.

## The gates

| Gate | What it verifies |
|---|---|
| `check` | type check + unit tests + the compile-only conformance gate |
| `conformance` | every example program: IDE parse → IDE print → **real compiler** → run → compare against `// EXPECT:` |
| `release` | on a `v*` tag: build the NSIS installer and create the GitHub Release |

A gate that skipped itself is worse than no gate — the run is green but nothing was
verified. Keep that in mind when you touch CI.

```bash
npm test                                  # the whole default suite
npm run typecheck                         # strict TypeScript, zero errors
JHY_CONFORMANCE_FULL=1 npx vitest run tests/conformance/run.test.ts   # the full gate
```

### The corpus

The conformance gate runs the language repository's `compiler/tests/examples/`
programs — **277 of them**. Files whose name starts with `_` are **not** part of the
corpus, which is the language repository's own rule (its regression harness, its MCP
server and its assertion audit all exclude them). Those files assert machine-specific
facts — for example that the compiler finds gcc at `C:\msys64\ucrt64\bin\gcc.exe` — which
is simply not true on a CI runner.

## Conventions

- **`src/lang/` stays pure TypeScript** — no Electron, no Node, no Blockly. That is what
  makes the language core unit-testable.
- **Do not write a second code generator** for the block view. Two generators means two
  interpretations of the same program.
- **The compiler is the referee.** The IDE never decides whether a program is valid.
- Comment and UI text may be in Chinese; the README and the wiki are bilingual
  (English + 简体中文).

## Where the wiki comes from

The wiki pages are **files in this repository**, under `docs/wiki/` — so they are
reviewed like everything else. When you change one, publish it:

```bash
npm run publish:wiki
```

That pushes `docs/wiki/*.md` to the GitHub wiki repository, and **generates the wiki
sidebar** (`_Sidebar.md`) from the file list — so the sidebar never goes stale.

> The wiki repository itself was created once from the web UI (GitHub only creates it
> there — the API has no wiki endpoints and a bare `git push` is rejected). That has
> already been done for this repo; from here on, `npm run publish:wiki` is enough.

## Commit messages

Say **what changed and why**. The repository uses Chinese or English, both fine.
