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
dependency. Treat them as read-only — bugs go upstream to numbl, then sync.

The parser produces a typed AST whose root is `AbstractSyntaxTree`. Every node
carries a `Span` (file + offset range).

**Sync mechanism.** `NUMBL_VERSION` records the numbl SHA the vendored sources
were last copied from. `scripts/sync_from_numbl.ts` re-syncs:

```
npx tsx scripts/sync_from_numbl.ts            # report drift
npx tsx scripts/sync_from_numbl.ts --check    # exit 1 if drifted (CI)
npx tsx scripts/sync_from_numbl.ts --apply    # rewrite mtoc, bump pin
```

After `--apply`, run `npx tsc --noEmit`, the vitest suite, and the cross-runner
before committing — the lowerer's exhaustive switches over the AST union are
where upstream parser changes will surface as mtoc compile errors.

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
  by an FNV-1a 32-bit hash of the canonical argument-type tuple. See
  `specialization.md`.
- **Branch handling**: the env is snapshotted at `if`/`while`/`for` entry,
  each branch lowers from the snapshot, and a `mergeBranchEnvs` step joins the
  per-branch envs at the merge point (using the predeclared-zero default for
  variables that fall through unassigned). It's currently single-pass;
  oscillating loops can be sound-but-imprecise, documented in the merge.
  The control-flow helpers also bump `controlDepth` so an incompatible
  reassignment inside a branch falls through to an error rather than the
  variable-splitting path (next bullet).
- **Variable splitting**: at top level (`controlDepth === 0`), if a
  reassignment's new type can't share a single C variable with the
  prior binding (different category — scalar↔tensor or real↔complex),
  the lowerer allocates a fresh `_mtoc_<cName>__v<N>` C identifier and
  starts a new `assignedVars` entry. Subsequent reads of the same
  MATLAB name resolve to the new binding via `currentBindingCName`.
  Two assignments at the same coarse type (e.g. two row vectors at
  different runtime sizes) DO share storage — the codegen handles the
  shape change at the assignment site via free + realloc. Inside
  control flow the category-change conflict throws, with a message
  pointing the user at hoisting or renaming.
- **C-name mangling**: every `IRExpr.Var` / `IRStmt.Assign` / `IRFunction` param
  / loop-counter carries a `cName` field computed once via `cNameFor`. Codegen
  never re-mangles. The synthetic prefix `_mtoc_` is reserved.
- **IR validation**: a small post-lowering walk (`validateIR`) catches structural
  invariants the codegen depends on (e.g., tensor literals only as `Assign`
  RHS) so codegen-time errors stay rare and "internal".
- **Element-wise lift**: when every param of a builtin is `shape: "scalar"`
  but the call site passes a multi-element tensor, lowering widens the
  `Call`'s result type to the broadcast shape; codegen's existing
  per-slot iter loop (the same one that drives tensor `+ - .* ./`)
  renders the call once per element with each tensor arg collapsed to
  `<v>.real[<iter>]`. See `docs/builtins.md` for details. `.^` and
  comparison operators (`==`, `<`, etc.) ride the same path.
- **Broadcasting (`emitBroadcastAssign`)**: when multi-element operands
  have _differing_ static shapes (row vec + col vec, matrix +
  column-broadcast, 3-D + 2-D), `emitTensorAssignFromExpr` dispatches
  to a nested-loop emitter that computes the output shape via
  `mtoc_broadcast_dim` chains and precomputes a per-operand linear
  index inside the inner loop. A statically-`one` axis drops out of
  the index expression (the operand reuses one element while the loop
  advances on that axis); `unknown` axes take a runtime `?:` against
  the operand's dim field. Same-shape operands still use the legacy
  flat-iter path so the byte-for-byte form of all pre-existing tests
  is preserved.
- **ANF normalization (`src/lowering/anf.ts`)**: a post-lowering pass that
  hoists every owned-producing sub-expression (TensorLit, IndexSlice,
  string concat, user-function call returning an owned kind) out of
  larger expressions into its own synthetic
  `_mtoc_anf_<N> = <producer>;` Assign, registered in the enclosing
  scope's `assignedVars`. After ANF, owned producers appear at exactly
  one position: the full RHS of an owned-LHS Assign. That tight
  invariant collapses what used to be a patchwork of context-sensitive
  consume-site rules into a single `mtoc_<kind>_assign(&lhs, producer)`
  path, with the existing liveness / scope-exit free walks managing
  every temp's lifetime uniformly. Arbitrary nesting like
  `helper(helper(x))`, `bump(helper(x), 7)`, `sum(helper(x))`,
  `disp(helper(x))`, `[1 2] + 1`, `v(1:3) + 1`, `(a + b) + c`
  (strings), etc. all decompose into a sequence of well-formed
  Assigns automatically.
- **Function-file entry**: when the source has no top-level script
  statements but at least one function definition, `lower()` adopts
  the first function's body as the script body. The function still
  registers as a local so cross-calls work; the entry must take zero
  parameters. Mirrors numbl's "first-function call with 0 args".

### IR walkers (`src/lowering/walk.ts`)

Generic visitors over the typed IR — `forEachSubExpr` (pre-order over
every sub-expression of an `IRExpr`), `findInExpr` (first match),
`forEachTopLevelExpr` (every expression a stmt directly holds), and
`forEachStmtInTree` (every stmt in a body, parents before children).
Every analysis or validation pass that used to roll its own
exhaustive switch on `IRExpr.kind` / `IRStmt.kind` now expresses
itself as a per-node visitor on top of these helpers — adding a new
IR variant means updating one switch (the walker) plus any visitor
that genuinely needs to look at the new kind.

### IR (`src/lowering/ir.ts`)

A discriminated-union IR. Two trees:

- `IRExpr` — `NumLit`, `Var`, `TensorLit`, `Call`, `Binary`, `Unary`. `Call`
  carries a `callee: CallTarget` discriminator (`libm` / `runtime` /
  `userFunc`) — codegen no longer does string lookups against the runtime
  registry.
- `IRStmt` — `Assign`, `ExprStmt`, `Disp`, `If`, `While`, `For`, `Break`,
  `Continue`, `ReturnFromFunction`. `Assign` carries any RHS — scalar,
  `TensorLit`, or any other multi-element expression; codegen dispatches on
  RHS kind/shape and emits a per-element loop when needed. The expression
  visitor maintains an iter-stack so multi-element `Var`s render as
  `<cName>.real[<iter>]` while a loop is active.

The IR carries enough information that codegen never has to re-derive types or
re-mangle names — every `Var` / `Assign` / param has its `cName` baked in.

### Codegen (`src/codegen/`)

The codegen is split across one orchestrator and several topical
modules:

- `emit.ts` — top-level `emitC(prog, opts)` driver. Builds the
  `EmitState`, runs the analysis pre-walk, and assembles headers +
  runtime snippets + function blocks + main into the final C string.
- `emitState.ts` — `EmitState` interface plus the small helpers that
  every other module needs (`useRuntime` / `useRuntimeByName` /
  `pushStmt` / `indent` / `builtinEmitFacade`).
- `emitFormat.ts` — pure formatters (`formatNumLit`,
  `formatStringLit`, `formatCharLit`, op tables, precedence). No
  state; no side effects.
- `emitExpr.ts` — `emitExpr` (and its complex / arg-copy helpers)
  plus `analyzeExpr` (the header-flag pre-walk).
- `emitStmt.ts` — `emitStmt` (the per-IRStmt dispatch) plus
  `analyzeStmts`, the elementwise-loop and tensor-literal Assign
  emitters, the shape-source walkers, and the early-free emission.
- `emitOwned.ts` — `emitDeclarations` / `emitScopeExitFrees` /
  `functionFreeOnExitSet`. All three walk a `{cName → VarBinding}`
  table and dispatch through the `ownedKinds` registry.
- `emitFunction.ts` — `emitFunction` and `emitFunctionBody`, plus
  the per-specialization header comment.
- `ownedKinds.ts` — registry mapping each owned MType (string, char
  array, real-or-complex tensor) to its C helper names. New owned
  kinds plug in by adding one entry.
- `irRender.ts` — `renderStmt` / `renderExpr`: best-effort numbl
  pretty-printer for IR nodes. `emitStmt` drops the rendered string
  as a `/* ... */` comment above each emitted statement so a reader
  of the generated C can follow the original program shape without
  going back to the `.m` source.

`emit.ts` walks an `IRProgram` and produces a single C source string.
Responsibilities:

- Activate runtime helpers on demand (one walk; see "Runtime" below).
- Predeclare every `assignedVars` entry at the top of `main()` and inside each
  function body. Scalars: `double x = 0.0;` (real) or
  `double _Complex z = 0.0;` (complex). Tensors are predeclared empty —
  `mtoc_tensor_t v = mtoc_tensor_empty();` — and the assignment site
  consumes a freshly-built tensor via `mtoc_tensor_assign(&v, ...)`,
  which frees the previous backing and installs the new one in one
  helper call. The RHS is one of: a literal helper
  (`mtoc_tensor_from_row` / `_complex` / `mtoc_tensor_from_matrix` /
  `_complex`), an `mtoc_tensor_copy` of a source variable, or an
  alloc'd elementwise result (`mtoc_tensor_alloc` + a loop that fills
  the slots). Every tensor argument to a user-function call is also
  wrapped in `mtoc_tensor_copy(...)` so the callee owns its
  parameter. `mtoc_tensor_free(&<name>)` (or `mtoc_string_free` for
  strings) is emitted as soon as the value is no longer needed —
  driven by a backward "future-touch" dataflow over the IR
  (`src/codegen/liveness.ts`) parameterized by the `isOwned` predicate
  — and a scope-exit free walk before every `return` site picks up
  anything not freed early on the linear path. Cleanup is exercised
  by every test, not just large ones.
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

### Top-level entry (`src/translate.ts`)

`translateProject(files, activeName, opts?)` is the single composed entry
point used by both the CLI and the web IDE. It accepts a multi-file project
and returns `{c} | {error}` — never throws on user-program errors.
Cross-file resolution is live: a call to `helper(x)` in the entry file
resolves to the primary function of a sibling `helper.m` per numbl's
MATLAB-faithful rules (see "Workspace" below). Errors from all three
stages (`SyntaxError`, `UnsupportedConstruct`, `TypeError`) are
normalized into one `TranslateError` shape with optional
`{startOffset, endOffset, fileName}` for editor-marker placement.

### CLI (`src/cli.ts`)

A thin shell over `translateProject`. Two subcommands:

- `translate <in.m> <out.c>` — write the C file.
- `run <in.m>` — translate to a temp directory, invoke `cc` (or `$CC`), exec
  the binary, stream stdout/stderr through. Exit code propagates.

When the CLI translates an entry file, it scans `dirname(entry)` for
sibling `.m` workspace files using numbl's vendored `scanMFiles` (the
same scan numbl's own CLI runs) and hands the file list to
`translateProject`. Workspace-function names are derived from each
file's basename by stripping the search-path prefix.

## Workspace (`src/workspace/`)

A small registry layer sitting between the parser and the lowerer. The
heavy lifting — function-name indexing, MATLAB precedence,
`+pkg/`/`@Cls/`/`private/` directory recognition — is delegated to a
vendored copy of numbl's resolver (`src/numbl-core/`, see below).

- `Workspace` — thin adapter over numbl's `LoweringContext`. Tracks the
  main file, the search paths used to derive workspace-function names,
  and a side cache of `{name → source}` for codegen header comments.
  `resolve(name, callSite, span)` delegates to
  `numbl-core/functionResolve.ts::resolveFunction` and translates the
  rich result back into mtoc's narrow `{kind: "userFunction" | "builtin"}`
  shape. Unsupported kinds (class methods, private functions, JS user
  functions, package-qualified calls) fail with a span-attributed
  `UnsupportedConstruct` at the call site — the v1 fence-posts.
- `builtins.ts` — typed builtin signature DSL (`BuiltinSig` with
  `params`, `result`, `emit`). See `builtins.md` and `extending.md`.
- `constants.ts` — the `pi` / `eps` / `Inf` / `NaN` / `true` / `false` table.

### Vendored numbl resolver (`src/numbl-core/`)

A handful of numbl's own resolution sources are vendored verbatim and
kept in sync via `scripts/sync_from_numbl.ts`:

- `functionResolve.ts` — `resolveFunction(name, argTypes, callSite, index)`,
  the pure pre-/post-condition function that turns a call name + caller
  context into a `ResolvedTarget`.
- `lowering/loweringContext.ts` — `LoweringContext` owns the
  `WorkspaceRegistry` (workspace files, classes, private files, search
  paths) and builds the `FunctionIndex` that drives resolution.
- `lowering/classInfo.ts`, `lowering/itemTypes.ts`,
  `lowering/constants.ts`, `workspace/types.ts`,
  `runtime/specialBuiltinNames.ts`, `externalAccessDirective.ts` —
  pulled along as transitive deps.
- `src/numbl-cli/cli-scan.ts` — numbl's filesystem scan used by the
  CLI to discover workspace files.

Four tiny mtoc-owned shims sit at the import paths the vendored code
reaches for but that point at numbl's interpreter/runtime (which mtoc
doesn't have):
`src/numbl-core/runtime/runtimeHelpers.ts` (just the `CallSite` type),
`src/numbl-core/runtime/specialBuiltins.ts` (re-export),
`src/numbl-core/interpreter/builtins/index.ts` (empty `IBuiltin`
registry), and `src/numbl-core/helpers/registry.ts` (bridge to mtoc's
own builtin name list). Sync skips them — they're listed in
`MTOC_OWNED` in `sync_from_numbl.ts`.

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
