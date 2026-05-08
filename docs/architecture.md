# Architecture

mtoc is a single-pass static translator: numbl source goes in, a self-contained
C source file comes out. The pipeline is linear with one fixed-point inside
specialization caching.

## Pipeline

```
.m source  ─┐
            │  lexer       (vendored from numbl)
            ▼
          tokens
            │  parser      (vendored from numbl)
            ▼
          AST   (typed discriminated unions: Stmt, Expr)
            │  lowering    (mtoc's own pass)
            ▼
          IR    (typed discriminated unions: IRStmt, IRExpr, IRFunction)
            │  codegen
            ▼
        C source string
            │  CLI         (translate/run)
            ▼
        .c file → cc → executable
```

## Stages

### Lexer / parser (vendored)

Live under `src/lexer/` and `src/parser/`. Both come straight from numbl with
one tiny patch (a local `offsetToLine`) so the parser has no cross-module
dependency. Treat them as read-only — bugs go upstream to numbl.

The parser produces a typed AST whose root is `AbstractSyntaxTree`. Every node
carries a `Span` (file + offset range).

### Lowering (`src/lowering/`)

This is mtoc's own pass and the bulk of the work. The `Lowerer` class owns
per-scope state (env, assignedVars, params, output var, output C-name); the
per-construct logic is split into small `this`-typed helper files
(`lowerIf`, `lowerFor`, `lowerWhile`, `lowerBinary`, `lowerUnary`,
`lowerFuncCall`, `lowerTensorLiteral`).

Lowering does several jobs in one walk:

- **Type inference**: every expression gets an `MType`. Sign and shape flow
  through arithmetic / comparisons / function calls. See `type_system.md`.
- **Validation**: anything outside the supported subset raises
  `UnsupportedConstruct` (or `TypeError` for type-domain violations) with the
  offending span.
- **Lazy specialization**: user-function calls trigger fresh body lowering keyed
  by a SHA-256 of the canonical argument-type tuple. See `specialization.md`.
- **Branch handling**: the env is snapshotted at `if`/`while`/`for` entry,
  each branch lowers from the snapshot, and a `mergeBranchEnvs` step joins the
  per-branch envs at the merge point (using the predeclared-zero default for
  variables that fall through unassigned). It's currently single-pass;
  oscillating loops can be sound-but-imprecise, documented in the merge.
- **C-name mangling**: every `IRExpr.Var` / `IRStmt.Assign` / `IRFunction` param
  / loop-counter carries a `cName` field computed once via `cNameFor`. Codegen
  never re-mangles. The synthetic prefix `_mtoc_` is reserved.
- **IR validation**: a small post-lowering walk (`validateIR`) catches structural
  invariants the codegen depends on (e.g., tensor literals only as `Assign`
  RHS) so codegen-time errors stay rare and "internal".

### IR (`src/lowering/ir.ts`)

A discriminated-union IR. Two trees:

- `IRExpr` — `NumLit`, `Var`, `TensorLit`, `Call`, `Binary`, `Unary`. `Call`
  carries a `callee: CallTarget` discriminator (`libm` / `runtime` /
  `userFunc`) — codegen no longer does string lookups against the runtime
  registry.
- `IRStmt` — `Assign`, `ExprStmt`, `Disp`, `If`, `While`, `For`, `Break`,
  `Continue`, `ReturnFromFunction`, `TensorElemwise`. `TensorElemwise` is the
  per-element loop emitted for tensor-result assignments; codegen has *one*
  expression visitor that renders multi-element `Var`s differently when an
  iter-stack is active.

The IR carries enough information that codegen never has to re-derive types or
re-mangle names — every `Var` / `Assign` / param has its `cName` baked in.

### Codegen (`src/codegen/`)

`emit.ts` walks an `IRProgram` and produces a single C source string.
Responsibilities:

- Activate runtime helpers on demand (one walk; see "Runtime" below).
- Predeclare every `assignedVars` entry at the top of `main()` and inside each
  function body (scalars as `double x = 0.0;`, tensors as
  `double _mtoc_<name>_data[N]; mtoc_tensor_t <name> = { … };`).
- Emit user-function specializations ahead of `main`, each with a header
  comment showing the source span and the inferred type signature.
- Map operators to C with a precedence-aware printer; nested unary operands
  parenthesize so `--x` never appears.

### Runtime (`src/codegen/runtime/` + `src/codegen/runtime.ts`)

Each runtime helper lives in its own `.h` file so it can be edited with normal
C tooling. The TypeScript loader parses `#include` lines out of each file,
deduplicates them, and resolves a small dependency graph
(`mtoc_disp_tensor` depends on `mtoc_format_double` and `mtoc_tensor_t`, etc.).
Helpers are activated on-demand; only what's used appears in the output.

### CLI (`src/cli.ts`)

Two subcommands:

- `translate <in.m> <out.c>` — write the C file.
- `run <in.m>` — translate to a temp directory, invoke `cc` (or `$CC`), exec
  the binary, stream stdout/stderr through. Exit code propagates.

## Workspace (`src/workspace/`)

A small registry layer sitting between the parser and the lowerer.

- `Workspace` — file table, local-function table, `resolve(name)` which routes
  to either the builtin registry or a user-function entry.
- `builtins.ts` — typed builtin signature DSL (`BuiltinSig` with
  `params`, `result`, `emit`). See `builtins.md` and `extending.md`.
- `constants.ts` — the `pi` / `eps` / `Inf` / `NaN` / `true` / `false` table.

## Why these splits

- Lowering and codegen don't share state directly — they communicate through
  the IR. That keeps each pass free to refactor without coupling.
- The runtime is data, not code. Dropping a `.h` file plus one registry entry
  is enough to add a helper. Codegen activates it; the rest is mechanical.
- Builtins are also data — a `BuiltinSig` value carries its own `result` and
  `emit` closures, so adding a builtin doesn't require touching lowering or
  codegen if it fits the existing factories.
- Test scripts are auto-discovered. Adding a new `.m` file in
  `test_scripts/<category>/` is the entire process for a new cross-runner test.
