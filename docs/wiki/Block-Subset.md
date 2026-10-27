# Block Subset

The block view covers the **introductory** part of JHYY. Everything else still works —
it just lives in an **opaque block** that carries the original source text.

## What has blocks

| Area | Blocks |
|---|---|
| Variables | `let` (with `mut` and an optional type annotation), assignment |
| Literals | numbers, strings, chars, booleans, array literals |
| Operators | `+ - * / %`, `== != < > <= >=`, `&& \|\|`, `& \| ^ << >>`, unary `- ! ~`, casts (`as`) |
| Access | field access, index |
| Calls | plain calls and `module::function` calls |
| Control flow | `if` / `else`, `while`, `for i in a..b`, `return`, `break`, `continue` |
| Declarations | functions (with parameters), structs (with fields), enums (with variants), `type` aliases, `import` |
| Patterns | `match` with literal / range / enum-variant / wildcard arms |
| Output | `printf` |

The catalogue lives in `src/lang/blocks/tree.ts` (`BLOCK`, `BLOCK_FIELDS`, `BLOCK_INPUTS`,
`BLOCK_STATEMENTS`) — that file is the **single source of truth** for what a block is and
what its fields are.

### Two shapes for the same thing

In Blockly a block cannot be both a value block (has an output connector) and a statement
block (has previous/next connectors). In JHYY a call, an assignment, an `if` and a `match`
can appear in **both** positions — so each of them exists twice:

| Value form | Statement form |
|---|---|
| `jhyy_call` | `jhyy_call_stmt` |
| `jhyy_qcall` | `jhyy_qcall_stmt` |
| `jhyy_set_val` | `jhyy_set` |
| `jhyy_if_val` | `jhyy_if` |
| `jhyy_match_val` | `jhyy_match` |

`jhyy_expr_stmt` wraps a value expression used in statement position (evaluated, result
discarded).

## What is the escape hatch

Anything the block subset cannot express becomes an **opaque block**: a single block
whose payload is the original source text of that subtree.

That covers, among others:

- generics and turbofish (`max::<i32>(…)`), generic structs and functions
- closures
- pointers, references, borrows, slices
- `defer`, `asm!`, attributes (`#[inline]`, `#[no_std]`, …)
- `Cap<T>` / `PhantomData<T>` in type positions
- `sizeof` / `alignof`, `null`, `volatile`

The payload round-trips **losslessly**: the escape hatch stores the exact source slice,
with newlines and backslashes escaped, and restores it byte for byte when the blocks are
printed back to text. As long as you do not touch the opaque block, that code never
changes.

When the IDE has to fall back to opaque blocks, it tells you — you are never silently
losing code.

## Adding a new block

1. **`src/lang/blocks/tree.ts`** — add the type name to `BLOCK`, and register its fields
   (`BLOCK_FIELDS`), inputs (`BLOCK_INPUTS`) and statement containers (`BLOCK_STATEMENTS`).
2. **`src/renderer/blocks/definitions.ts`** — write the block definition (`init()`).
3. **`src/lang/blocks/decompile.ts`** — teach the decompiler to produce it from the AST.
4. **`src/lang/blocks/compile.ts`** — teach the compiler to build it back into the AST.
5. **`src/renderer/blocks/definitions.ts`** — put it into `buildToolbox()`.
6. **`npm test`** — the conformance gate has to stay green.
7. Update [`docs/blocks-subset.md`](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/blob/main/docs/blocks-subset.md)
   in the repository.

Two rules that keep biting:

- **A block cannot be both a value block and a statement block.** If both positions need
  it, make two blocks (see the table above).
- **Every field needs an explicit name.** Blockly's `getField('CODE')` returns `null` for
  an unnamed field — the opaque block's payload would then be lost on the round trip.

## Blockly 13 gotchas

If you are hacking on the block layer, these are the ones that cost real time:

- `setNextStatement(true)` **no longer creates a previous connection**. Statement blocks
  must call `setPreviousStatement(true)` explicitly, or nothing connects into the
  containers.
- A `<statement>` container holds a **chain**: putting several blocks in means emitting
  `<next>` elements, not several children.
- `workspace.render()` only **queues** a render (on the next animation frame). If the
  window has no focus, nothing is drawn — call
  `Blockly.renderManagement.triggerQueuedRenders(workspace)` to force it.
- The supported load path is **XML** (`Blockly.Xml.domToWorkspace` /
  `workspaceToDom`), not manual `newBlock` + `connect`.
