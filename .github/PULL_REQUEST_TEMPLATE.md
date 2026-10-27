## What changed（改了什么）

<!-- One or two sentences. 说清楚改了什么、为什么。 -->

## Why（为什么）

<!-- The problem this solves, or the bug it fixes. 解决什么问题 / 修什么 bug。 -->

## How it was verified（怎么验的）

<!-- The gates are real — say which ones you ran and what they printed.

     npm run typecheck
     npm test
     JHY_CONFORMANCE_FULL=1 npx vitest run tests/conformance/run.test.ts

     A change under src/lang/ MUST pass the full conformance gate: the IDE
     prints code that the real compiler has to accept. 改 src/lang/ 的必须过
     全量一致性门 —— 打印出来的代码真实编译器得认。 -->

- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes
- [ ] the full conformance gate passes — **required** if `src/lang/**` changed

## Checklist（自查）

- [ ] no new code-generation path outside `src/lang/blocks/` — the block view and the text view must keep sharing one AST
- [ ] `src/lang/**` stays pure TypeScript (no Electron / Node / Blockly imports)
- [ ] docs touched if the behaviour changed (`README.md` / `README.zh-CN.md` / `docs/`)
- [ ] wiki pages under `docs/wiki/` updated if the user-visible behaviour changed
