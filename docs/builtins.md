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
- **`reduceTensor(name, helperName, resultSign, domains)`** — tensor → scalar
  introspection (`length`, `numel`).
- **`oneArgReductionLowerExpr(name, helpers, signFromArg)`** — `lowerExpr`
  hook for value-reducing builtins (`sum` / `min` / `max`) that need to
  return a scalar OR a tensor depending on the argument's static shape.
  See "Shape-dispatched tensor reductions" below.

Most new builtins fit one of these. Adding a new factory is appropriate when
several entries share a non-trivial closure shape.

## Categories

- **`expr` builtins** lower to `IRExpr.Call` and end up in the value position
  of an expression. The vast majority.
- **`stmt` builtins** are accepted at statement position only. Today
  `disp`, `error`, `assert`, and `fprintf` are in this group.
  Lowering routes `ExprStmt(disp(x))` into `IRStmt.Disp`,
  `ExprStmt(error(s))` into `IRStmt.Error`, `ExprStmt(assert(c))`
  into `IRStmt.Assert`, and `ExprStmt(fprintf(fmt, args…))` into
  `IRStmt.Fprintf`. The registry entries exist so `Workspace.resolve`
  has a single lookup path and value-position uses reject with a
  clear message.

## fprintf / sprintf

Both share one C runtime engine — `runtime/format_engine.h` — that
mirrors numbl's `sprintfFormat`
(`numbl/src/numbl-core/helpers/string.ts`) byte-for-byte: same spec
set (`d i u f e E g s c x X o %`), same flag handling, same `\n` /
`\t` / `\\` escape interpretation (numbl preserves backslash bytes
through the lexer, then the engine resolves them at format time),
same column-major tensor flattening, same format-cycling rule.

The split:

- `fprintf` is statement-only. The lowering hook
  (`fprintfLowerStmt` in `workspace/builtins.ts`) resolves an
  optional literal-`1`-or-`2` fid (numbl routes both fids to its
  single output stream — mtoc emits both to stdout for byte parity),
  validates the format and value args, and produces an
  `IRStmt.Fprintf`. Codegen emits one call into `mtoc_fprintf` with
  a C99 compound-literal `mtoc_fprintf_arg_t[]` carrying tagged
  payloads (double / complex / text view / tensor pointer).
- `sprintf` is an expression builtin whose return type tracks
  numbl: char-typed format → char-array result, string-typed format
  → string result. The lowering hook (`sprintfLowerExpr`) builds a
  fresh `BuiltinSig` with `producesOwnedDirectly: true` so ANF
  hoists the call into its own owned-LHS Assign whenever it appears
  in a nested position. The synthetic sig's `emit` closure selects
  between `mtoc_sprintf_str` and `mtoc_sprintf_char` based on the
  format's static text type.

The compound-literal arg encoding (`mtoc_fprintf_arg_t`) lets the
emit site stay a single C expression regardless of arity, which is
what makes `producesOwnedDirectly: true` viable for sprintf — the
ANF hoist sees a normal `Call` node and lifts it like any other
owned producer (zeros / size / reshape).

Format strings and `%s` arguments accept both string and char-array
sources interchangeably via the existing `mtoc_text_view_t` adapter
(`runtime/text_view.h`), reusing the same path that disp, error,
assert(\_, msg), strcmp, and `+` concat already use.

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

Reductions like `sum` / `min(t)` / `max(t)` / `length` / `numel` are
NOT element-wise — they consume the full tensor struct as a single
value. See "Shape-dispatched tensor reductions" below for how the
value-reducing flavors pick a scalar- vs tensor-returning helper.

## Shape-dispatched tensor reductions

`sum`, `min`, and `max` each have to choose between a scalar-returning
runtime helper (`mtoc_sum(t) → double`) and a tensor-returning one
(`mtoc_sum_default(t) → mtoc_tensor_t`) depending on the argument's
static shape. `oneArgReductionLowerExpr` is the `lowerExpr` factory
that drives this dispatch — caller provides a `ReductionHelpers` table
(real-all / complex-all / real-default / complex-default helper
identifiers) plus a sign-propagation rule.

The dispatch rule mirrors numbl's `firstReduceDim`:

| Static shape of `arg.ty`                                             | Result                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| Scalar (all axes `one`)                                              | Identity — the call lowers to `arg` itself              |
| ≤1 axis is not `one` (rest `one`)                                    | Scalar via `_all` helper                                |
| ≥2 axes are `notOne`, no `unknown` mixed in                          | Tensor via `_default`; first `notOne` axis → `one`      |
| ≥2 non-`one` axes with at least one `unknown` (statically ambiguous) | `UnsupportedConstruct` at lowering with a clear message |

The statically-ambiguous case is what `reshape(t, ...)` / `zeros(n, m)`
produce — the result could be a vector (collapsing to a scalar) or a
matrix (giving a tensor) at runtime, and the static return type can't
unify those two shapes. Users hit this by `reshape`-ing to a known
shape first, or by waiting on the explicit-`dim` form.

`min` and `max` keep their 2-arg elementwise sigs alongside this hook
— the `lowerExpr` factory returns `null` for arity-2 calls, letting
the existing scalar-scalar lift handle `min(a, b)`. For `sum`, the
default-path entry is throw-only and every arity is routed through
the hook (arity ≠ 1 hits the standard "expects 1 argument" error).

`min`/`max` over a complex tensor order by magnitude with ties broken
by angle (`atan2(im, re)`), and skip NaN per `minMaxScan` in numbl —
the runtime helpers (`minmax_complex_all.h` / `minmax_complex_default.h`)
encode that ordering directly.

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

A builtin can register BOTH hooks to give the statement form
different codegen from the expression form. `toc` does this: at
expression position (`t = toc;`) the `lowerExpr` hook synthesizes a
one-shot sig that emits `mtoc_toc()` (value-returning, silent); at
statement position (`toc;`) the `lowerStmt` hook builds an
`ExprStmt(Call(...))` over a `Void`-returning sig that emits
`mtoc_toc_print()` (matches numbl's "print on bare statement" rule).

`tic` / `toc` also exercise the bare-Ident dispatch in `lower.ts`:
the parser produces an `Ident` for `tic` / `toc` without parens, and
the lowerer's `case "Ident"` arm forwards to `lowerBuiltinCall(name,
[], span)` when the name isn't a variable or constant. This is how
numbl treats unresolved Idents; mtoc matches so `t = tic;`, `toc;`,
and `e = toc` all compile the same as their parens form.

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

Numeric predicates `isnan(x)` / `isinf(x)` / `isfinite(x)` accept
both real and complex scalars. Real inputs render inline
(`(double)isnan(x)`); complex inputs route through a small runtime
helper (`mtoc_isnan_complex` / `mtoc_isinf_complex` /
`mtoc_isfinite_complex`) that binds the argument to a local so a
caller-side Call expression — e.g. `isnan(csqrt(z))` — is
evaluated exactly once. The helpers expand componentwise per
numbl: EITHER-lane for `isnan` / `isinf`, BOTH-lanes for
`isfinite`. `logical(x)` is real-only (numbl rejects a complex
argument) and renders inline as `(x != 0.0 ? 1.0 : 0.0)`. All
four follow numbl's logical-as-double convention so the result
threads cleanly into arithmetic / `assert` / `disp`.

`length(s)` and `numel(s)` use their `lowerExpr` hook to handle
non-tensor arguments. When the argument is a string, both fold to a
`NumLit(1)` at lowering (numbl semantics for the scalar string
handle). When the argument is a char array, `CharLit` folds to a
`NumLit(n)` (static length) and char-array `Var` emits a synthetic
Call that reads `.cols` from the `mtoc_char_tensor_t` struct — no
runtime helper needed. Tensor / numeric arguments fall through to
the default `reduceTensor` validate / build path.

`complex(...)` is the only path from a real-typed value to a
complex-typed one (numbl has no `'like'` or `'complex'` companion
arg on `zeros` / `ones` / `eye` / `nan` / `inf` / `randn`). Its
`lowerExpr` hook handles both the 1-arg form
(`complex(x)` — promote real → complex with imag plane = 0; a
complex `x` passes through unchanged) and the 2-arg form
(`complex(re, im)` — build `re + im*i`, rejects complex args).
Scalar inputs render as a direct `(arg + 0.0 * I)` / `(re + im * I)`
C expression; tensor inputs ride the standard elementwise lift —
the iter-loop codegen allocates a complex result tensor and stamps
the per-slot expression into each cell, including the broadcast
cases `complex(scalar, tensor)` and `complex(tensor, scalar)`.

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
  (→ `mtoc_size_vec`), `reshape(t, …)` (→ `mtoc_tensor_reshape` /
  `_complex`), `zeros(N, M)` / `ones(...)` / `nan(...)` / `inf(...)` /
  `eye(...)`, and the matrix-shaped `sum(t)` / `min(t)` / `max(t)` (→
  `mtoc_sum_default` / `mtoc_minmax_*_default`) follow this pattern.
  The ANF pass and IR validator recognize non-elementwise builtin
  Calls with `isOwned` result as owned producers,
  so a tensor-returning builtin can appear at an Assign RHS or be
  auto-hoisted out of nested positions.
