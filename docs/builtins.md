# Builtins

The builtin registry is the typed-signature DSL in `src/workspace/builtins.ts`.
Each entry is a `BuiltinSig` value that owns its own type rule and its own
codegen.

## Anatomy

```
BuiltinSig {
  name        // numbl name, e.g. "sqrt"
  category    // "expr" | "stmt"
  params      // ParamConstraint[] — one per arg
  result      // (argTys: MType[]) => MType
  emit        // (argStrs: string[], state) => string  (the C call)
}
```

A `ParamConstraint` carries `shape` (`scalar` / `vector` / `tensor` / `any`),
`domain` (`nonnegative` / `positive` / `null`), `elem` (currently `"double"` or
`null`), and `complexDomain` (`real-only` / `real-or-complex` / `complex-only`,
defaulting to `real-only`). The lowerer reads `params[i].shape`/`.domain`/
`.complexDomain` to validate each argument; on violation it raises a
`TypeError` or `UnsupportedConstruct` with a span pointing at that argument.
The sign-domain check is skipped for complex args (sign is meaningless on
complex per the type-system invariant; the complex sibling implementation is
total).

`result` and `emit` are first-class closures — there is no magic-string
indirection. A reduction like `sum` whose result sign tracks its argument's
sign is just `result: ([t]) => scalarDouble(isNumeric(t) ? t.sign : "unknown")`.
Codegen for any builtin is whatever `emit` returns.

The `emit` closure also receives the inferred `argTys: MType[]` so it can
dispatch on `isComplex` for builtins with both real and complex
implementations (e.g. `sqrt(real)` → `sqrt`, `sqrt(complex)` → `csqrt`;
`abs(real)` → `fabs`, `abs(complex)` → `cabs`).

## Factories

A few factory helpers in `builtins.ts` keep entries terse for the common
patterns:

- **`libm(name, arity, cName, resultSign, domains, complexOpts?)`** — scalar
  libm function call (`sqrt`, `cos`, `pow`, …). Activates `<math.h>`. Pass
  `complexOpts.complexCName` to admit complex inputs and dispatch to a
  complex libm sibling (`csqrt`, `cabs` …); set `complexResult: "real"` for
  abs-style builtins whose complex form returns a real magnitude.
- **`runtime(name, arity, helperName, resultSign, domains, complexOpts?)`** —
  call to a runtime helper (`mtoc_mod`, `mtoc_sign`, …). Activates the
  helper snippet via the runtime registry. Pass
  `complexOpts.complexHelperName` to admit complex inputs with a registered
  complex sibling helper (e.g. `mtoc_clog2`, `mtoc_min_complex`); set
  `complexOpts.realIsLibm: true` when the real-side `helperName` is
  actually a libm function (e.g. `log10`, `fmin`) so the factory skips
  `useRuntime` on the real branch.
- **`reduceVector(name, helperName, signFromArg)`** — vector → scalar reduction
  (`sum`). Sign computed from the arg.
- **`reduceTensor(name, helperName, resultSign, domains)`** — tensor → scalar
  introspection (`length`, `numel`).

Most new builtins fit one of these. Adding a new factory is appropriate when
several entries share a non-trivial closure shape.

## Categories

- **`expr` builtins** lower to `IRExpr.Call` and end up in the value position
  of an expression. The vast majority.
- **`stmt` builtins** are accepted at statement position only. Today
  `disp`, `error`, and `assert` are in this group. Lowering routes
  `ExprStmt(disp(x))` into `IRStmt.Disp`, `ExprStmt(error(s))` into
  `IRStmt.Error`, and `ExprStmt(assert(c))` into `IRStmt.Assert`
  directly; the registry entries exist so `Workspace.resolve` has a
  single lookup path and value-position uses reject with a clear
  message.

## Codegen interaction

Every `IRExpr.Call` carries a `callee: CallTarget` discriminator
(`libm` / `runtime` / `userFunc`). The factory closure decides which variant
to set when the call lowers. Codegen reads `callee.kind` and emits the C
identifier directly — no map lookup.

The `emit` closure receives a small `BuiltinEmitState` view onto the codegen
state: a boxed `needMath` flag and a `useRuntime(name)` activator. A factory
that wraps a libm name flips `needMath = true` and emits
`` `${cName}(${args.join(", ")})` ``; a runtime-helper factory additionally
calls `useRuntime("mtoc_mod")` (or whichever helper).

## Element-wise lift over tensors

Any builtin whose `params` are all `shape: "scalar"` is automatically
**element-wise-liftable**: passing one or more multi-element tensor
arguments materializes a per-slot result tensor at the assignment site
(via the same iter-loop codegen path that drives tensor `+ - .* ./`).
The lowerer (`lowerBuiltinCallWithArgs` in `lowering/lowerFuncCall.ts`):

1. Detects the lift by inspecting `params` + arg types.
2. Computes the broadcast shape across all args (scalar ↔ tensor or
   same-shape tensor ↔ tensor; via `arithResult` on the type lattice).
3. Asks the builtin's `result` for the scalar-equivalent result type
   (by scalarifying the arg types — preserving `elem`/`isComplex`/`sign`,
   collapsing `rows`/`cols` to 1×1) and widens the result back to the
   broadcast shape.

The `emit` closure does NOT change — codegen renders each arg in iter
context (a multi-element `Var` becomes `<v>.real[<iter>]`, complex
`(<v>.real[<iter>] + <v>.imag[<iter>] * I)`), so the closure sees scalar
per-slot strings and produces the right C expression unchanged. A
real-or-complex sibling (`cabs`, `csqrt`, …) keeps working because the
dispatch in the closure reads `argTys` directly off the (unscalarified)
call IR.

Reductions like `sum` / `length` / `numel` are NOT element-wise (their
param shape is `vector` / `tensor`), so they consume the full tensor
struct as before.

## Adding one

The common path:

1. If the C side is a libm function, add a factory call:
   `libm("acosh", 1, "acosh", "unknown", ["positive"])`.
2. If the C side is a new runtime helper:
   - Drop a `.h` file under `src/codegen/runtime/` (see `runtime.md`).
   - Add it to the runtime registry with any dependencies it needs.
   - Add a `runtime("foo", 1, "mtoc_foo", …)` registry entry here.
3. If the type rule is exotic (e.g. result type depends on the arg shape),
   write the entry by hand with a custom `result` and `emit`. Document the
   rule in a code comment near the entry.

That's it — the registry is the single source of truth for builtin behavior.
The lowerer and codegen consume it generically.

## Statement-only and expression-override hooks

`BuiltinSig` has two optional lowering hooks alongside `result` /
`emit`:

- **`lowerStmt(ctx, args, span)`** — invoked from the lowerer's
  `ExprStmt(name(args))` arm BEFORE the default expression-call
  path. Receives the raw AST args so the hook can do its own shape
  validation alongside lowering. Returning a non-null `IRStmt` uses
  it as the stmt's lowered form; returning `null` defers to the
  default. `disp` and `error` use this to produce dedicated
  `IRStmt.Disp` / `IRStmt.Error` nodes — without it, `lower.ts`
  would have to hardcode their names.
- **`lowerExpr(ctx, args, span)`** — invoked from `lowerFuncCall`
  AFTER args are lowered but BEFORE arg-shape validation. Lets a
  builtin constant-fold or rewrite the call based on the lowered
  arg types (e.g. `length(string) → NumLit(1)`). Returning `null`
  defers to the default validate / build path.

These hooks are how non-uniform builtin behavior stays declarative
in the registry instead of accumulating special cases in `lower.ts`.

## Text-aware builtins (string ↔ char-array interchange)

numbl treats `string` (double-quoted) and `char` arrays (single-quoted)
as separate types, but most "text-accepting" builtins should work the
same regardless of which form a user wrote. mtoc routes every such
builtin through one C helper that consumes an `mtoc_text_view_t` (a
non-owning `{data, len}` pair), with the caller wrapping either source
struct via `mtoc_text_from_string` / `mtoc_text_from_char_tensor`.

The `isText(t)` predicate in `lowering/types.ts` is the seed —
`isString(t) || isCharArray(t)`. Scalar chars are intentionally
excluded (they're bare C `char` and keep their numeric character
role; `disp('a')` still routes through `mtoc_disp_char`).

The text-view-aware builtins:

- **`disp(s)`** accepts a string / char-array `Var`, `StringLit`,
  `CharLit`, or any ANF-hoistable owned producer. Codegen emits
  `mtoc_disp_text(<view>);` for both source kinds.
- **`error(msg)`** accepts the same shapes as `disp`'s text arg and
  emits `mtoc_error_text(<view>);`. Both `error("boom")` and
  `error('boom')` work.
- **`assert(cond)`** uses `mtoc_assert_double` (no message).
  **`assert(cond, msg)`** emits `mtoc_assert_double_msg_text(<cond>,
<view>);` where `msg` is any text value (string or char array).
  Both fail on a zero or NaN cond and are no-ops otherwise; the
  tensor-condition form (numbl fails if any element is zero/NaN) is
  deferred and raises `UnsupportedConstruct`.
- **`strcmp(a, b)`** accepts any pair of strings / char arrays. The
  builtin's `emit` closure wraps each arg via the appropriate
  `mtoc_text_from_*` adapter and emits a single `mtoc_strcmp_text(va,
vb)` call returning a real scalar (1.0 / 0.0).

Numeric predicates `isnan(x)` / `isinf(x)` / `isfinite(x)` and the
`logical(x)` coercion are inlined as expression-level emits — no
runtime helper, just a `(double)isnan(x)` / `(x != 0.0 ? 1.0 : 0.0)`
shape. They follow numbl's logical-as-double convention so the
result threads cleanly into arithmetic / `assert` / `disp`.

`length(s)` and `numel(s)` use their `lowerExpr` hook to handle
non-tensor arguments. When the argument is a string, both fold to a
`NumLit(1)` at lowering (numbl semantics for the scalar string
handle). When the argument is a char array, `CharLit` folds to a
`NumLit(n)` (static length) and char-array `Var` emits a synthetic
Call that reads `.cols` from the `mtoc_char_tensor_t` struct — no
runtime helper needed. Tensor / numeric arguments fall through to
the default `reduceTensor` validate / build path.

String concat (`+`) is handled in the binary lowering path, not as a
builtin. Whenever at least one operand is a string and the other is
text (string or char array), the lowerer produces a `Binary(Add, …)`
IR node typed as `STRING`; codegen emits
`mtoc_string_concat(<view_left>, <view_right>)` which takes two
`mtoc_text_view_t` arguments and returns a fresh owned `mtoc_string_t`.
char-array + char-array is NOT concat — it falls through to the
numeric path for element-wise addition.

## Caveats

- The shape constraint `"any"` exists for builtins that accept any value
  (scalar through N-D tensor). `disp`, `size`, and `ndims` use it. Their
  `lowerExpr` / `emit` closures dispatch on the input shape.
- **Tensor-returning builtins** plug in via `lowerExpr` synthesizing a
  one-shot `BuiltinSig` whose `result` is multi-element and `emit`
  renders a runtime helper that allocates the result. Today `size(t)`
  (→ `mtoc_size_vec`) and `reshape(t, …)` (→ `mtoc_tensor_reshape` /
  `_complex`) follow this pattern; future ones (e.g. `zeros(N, M)`) plug
  in the same way. The ANF pass and IR validator recognize non-
  elementwise builtin Calls with `isOwned` result as owned producers,
  so a tensor-returning builtin can appear at an Assign RHS or be
  auto-hoisted out of nested positions.
