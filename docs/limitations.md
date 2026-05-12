# Known limitations

These are the sharp edges users / agents will hit. Each has a documented
workaround or a roadmap note.

## Type system

- **Sign-only refinement is path-insensitive.** Inside a body that's `if x > 0
... end`, mtoc does _not_ refine `x.sign` to `positive` within the
  then-branch. To take advantage of a guard, hoist the value into a fresh
  variable: `if x > 0; xpos = x; ... use xpos ...; end`.
- **Loop type analysis is single-pass.** Bodies whose sign-flow oscillates
  across iterations may keep a sound but imprecise post-loop type — usually
  `unknown`. The merge function documents the gap. Fixpoint iteration is part
  of the larger "decouple type inference from IR construction" roadmap item.
- **Variable re-typing across kinds is split at top level, rejected
  inside control flow.** At script or function-body top level, an
  assignment whose new type can't share a C variable with the prior
  binding is lowered to a fresh `_mtoc_<name>__v<N>` C variable; later
  reads of the same name see the new binding. Inside an `if` / `while`
  / `for` body the same pattern still errors at the second assignment —
  the merge across branches/iterations would need to reconcile distinct
  bindings, which Phase 1 doesn't attempt. The workaround inside
  control flow is to rename, or hoist the reassignment outside.

## Tensors

- **Tensor dims are categorical, not exact.** The type lattice tracks
  whether each axis is `one` (broadcast), `notOne` (≥2 or 0), or
  `unknown`; the specific sizes live at runtime on
  `mtoc_tensor_t.dims[i]`. This collapses specializations across
  same-shape-category calls (`total([1 2 3])` and `total([1 2 3 4])`
  share one mangled function) and lets a tensor variable take on
  different runtime shapes via free + realloc at the assignment site.
- **N-D tensors are constructible but not yet operand-eligible.**
  `reshape(v, d1, d2, …, dN)`, `zeros(d1, …, dN)`, `ones(...)`,
  `nan(...)`, `inf(...)`, `rand(...)`, and `randn(...)` all produce
  N-D tensors; `disp`, `size`, `ndims`, `numel`, `length`, and
  another `reshape` work on them. Arithmetic, indexing, slicing, and
  elementwise builtin lifts on an N-D tensor (`A + 1` where
  `ndim(A) > 2`) are not yet supported — the elementwise codegen
  loop is still 2-D-shaped. `MTOC_MAX_NDIM` is 8.
- **PRNG byte-equivalence requires an explicit seed.** `rand`,
  `randn`, and `rng(seed)` share xoshiro128\*\* + splitmix32 with
  numbl, so post-seeded output is byte-identical. Without a
  `rng(seed)` call, mtoc seeds with 0 while numbl falls back to
  `Math.random()` — the two streams disagree. Cross-runner test
  scripts using `rand` / `randn` should call `rng(<seed>)` first.
- **`linspace`, `logspace`, `repmat`, `ndgrid`, `meshgrid` are
  deferred.** The infrastructure for runtime-shape allocation is in
  place (see the tensor-constructor builtins above) — adding these
  is mechanical work matching numbl's exact formulas.
- **Tensor sub-expressions only at `Assign` RHS — for _non_-owned
  expressions.** `disp(a + b)` and `sum(a .* a)` still fail with a
  "assign to a temp first" message: a Binary on two tensors produces a
  multi-element value with no surrounding consume site. Element-wise
  scalar builtins (`sqrt`, `sin`, `cos`, `abs`, `atan2`, `hypot`,
  `power`, `min`, `max`, `mod`, `rem`, `floor`, `ceil`, `round`, `fix`,
  `isnan`, `isinf`, `isfinite`, `logical`, `real`, `imag`, `conj`,
  `angle`, `sign`) DO lift over tensor arguments automatically at the
  top level of an `Assign` — `y = sqrt(x)` materializes the same
  per-slot loop as `y = x .* x`. Owned-producing sub-expressions
  (TensorLit, IndexSlice, string concat, tensor-returning user-function
  calls) are automatically hoisted by the ANF pass, so
  `disp(helper(x))`, `sum(helper(x))`, `y = [1 2] + 1`,
  `y = v(1:3) + 1`, `s = (a + b) + c`, `y = helper(helper(x))`, and
  `y = bump(helper(x), 7)` all compile cleanly. Auto-materialization of
  _non_-owned intermediate tensors (e.g. Binary on two tensors as a
  disp arg) is still a known TODO.
- **Broadcasting (implicit expansion) between tensors.** Tensor⊙tensor
  arithmetic and comparison ops (`+ - .* ./ .^`, `== ~= < <= > >=`)
  follow MATLAB's implicit-expansion rule: an axis of size 1 expands
  to match the other operand, and a shorter-rank operand is padded
  with trailing 1s. Statically-known matching shapes stay on the
  fast flat-iter path (with `mtoc_check_shape` catching dimension
  mismatches the lattice can't see); differing static shapes route
  through the broadcast emitter, which builds a runtime broadcast
  shape via `mtoc_broadcast_dim` chains and walks the result with
  per-operand stride tables. Runtime incompatibility (two non-1 axes
  of unequal size) aborts with a clear diagnostic. CharLit broadcasting
  (e.g. `'abc' + [1; 2]`) is not yet wired — multi-element char
  operands stay on the flat path.
- **No matrix multiply / divide / power yet.** `*`/`/`/`^` between two
  tensors is explicitly rejected at lowering with a message pointing the user
  at `.* ./ .^` for elementwise. Matrix ops will need a separate codegen path
  (likely calling into a BLAS-shaped helper). `.^` itself works on tensors
  (real-elem, scalar↔tensor broadcast or same-shape tensor↔tensor); complex
  `.^` is deferred.
- **Non-conjugate transpose `.'` only.** `.'` works on 2-D real and
  complex tensors (and is the identity on scalars). The conjugate
  transpose `'` and the `transpose` / `ctranspose` builtin spellings
  are not yet wired; transpose of a char array or an `ndim > 2` tensor
  is rejected at lowering.
- **Tensor comparisons lift.** `a == b`, `a < b`, `a > 0`, `a ~= b`, etc.
  produce 0.0/1.0 tensors at the element-wise broadcast shape. `&&` /
  `||` stay scalar-only — there is no `&` / `|` parser shape yet for the
  element-wise logical conjunction / disjunction.
- **Indexing covers scalar reads, range/colon reads, scalar writes,
  and range/colon writes** — all on real-or-complex double tensors,
  including N-D. Scalar reads also work on char tensors. Two acceptable
  arities: one linear index (`v(k)`, `v(end)`) or one per axis
  (`M(i, j)`, `T(i, j, k)`). Single-slot range / colon reads
  (`v(a:b)`, `v(2:end)`, `v(:)`, `M(2:5)`, `M(:)`) preserve the base's
  orientation for vectors and produce a row for matrix linear
  indexing; `Colon` always linearizes to a column. Multi-slot mixed
  scalar / range / colon (`M(:, j)`, `M(i, :)`, `M(a:b, c:d)`,
  `T(:, j, :)`, `T(end, :, end)`) is supported on any-dim tensors —
  each slot becomes one result axis, trailing singletons are stripped
  via the same N-D normalization rule numbl's `reshape` uses, and `end`
  resolves per-axis to `base.dims[<slot>]`. Range / colon writes
  (`v(a:b) = w`, `v(:) = w`, `M(:, j) = w`, `M(:, :) = scalar`) mutate
  the base buffer in place; the RHS must be a scalar (broadcast) or
  a named tensor variable (per-slot copy with a runtime count check
  that aborts with a clear diagnostic on size mismatch). The range
  step must be a numeric literal. Type rules across reads and writes:
  a real RHS into a complex base zeros the imag side per slot (numbl
  semantics); a complex RHS into a real base is rejected at lowering.
  Still deferred: char-tensor writes, char-tensor range reads,
  TensorLit / Binary / IndexSlice on the RHS of a range write (assign
  to a name first), and indexing into a scalar variable (`x(1)`
  returning `x`).
- **User functions can return owned values.** 1-output functions return
  the owned struct (`mtoc_tensor_t`, `mtoc_char_tensor_t`, `mtoc_string_t`)
  by value; the callee skips freeing the output's local at scope exit so
  the heap buffers transfer to the caller, who consumes them via
  `mtoc_<kind>_assign(&lhs, foo(args))` at the assignment site. N-output
  functions write owned outputs through their sret out-pointer using the
  same `mtoc_<kind>_assign` helper so the caller's prior buffer at the
  lvalue is released before the new handle lands. Tensor params remain
  callee-owned via the existing copy-on-arg-pass machinery.

  Tensor-returning calls compose into any expression position the ANF
  pass can hoist them out of — `y = foo(x) + 1`, `y = sqrt(foo(x))`,
  `y = foo(x) .* bar(z)`, `y = foo(foo(x))`, `y = bump(foo(x), 7)`,
  `s = sum(foo(x))`, `disp(foo(x))` all decompose to a sequence of
  synthetic `_mtoc_anf_<N> = <producer>;` Assigns whose temps are
  predeclared and freed by the standard liveness machinery. What's
  still deferred:
  - **Bare statement form for owned-returning 1-output functions.**
    `foo(x);` (where `foo` returns a tensor) still rejects with
    "tensor-valued expression at statement scope"; capture into a name
    if you want the buffer freed automatically at scope exit.

- **Reductions (`sum` / `min` / `max`) require a statically-known
  scalar-or-vector vs matrix shape.** mtoc dispatches on the argument's
  static type: a scalar is the identity, an input with ≤1 non-singleton
  axis reduces to a scalar (real → `double`, complex → `double _Complex`),
  and an input with ≥2 axes that are statically `notOne` reduces along
  the first non-singleton axis to a fresh tensor (numbl's default-dim
  rule). NaN-skip and complex magnitude-then-angle ordering match numbl
  byte-for-byte. What's deferred: the explicit `(v, [], dim)` form
  (blocked on empty-tensor-literal `[]` support), the multi-output
  `[m, i] = min(v)` index form, statically-ambiguous shapes (e.g. the
  `[unknown, unknown]` output of `reshape` / `zeros(n, m)` — mtoc raises
  a clear "input shape is statically ambiguous" diagnostic; reshape to
  a known shape first), and reductions for other names (`prod`, `mean`,
  `any`, `all`, `norm` along a dim).

## Functions

- **Recursion is rejected** with an explicit error. Lifting requires forward
  declarations + fixpoint return-type inference.
- **Multi-output supports mixed scalar + owned outputs.**
  `function [a, b] = f(x)` lowers to a `void`-returning C function with
  one out-pointer per output. Owned slots (tensors, char tensors,
  strings) are written via the kind's `mtoc_<kind>_assign` helper so
  the caller's prior buffer at the lvalue is consumed cleanly; ignored
  outputs (`~`) declare an empty discard temp that's freed immediately
  after the call. Zero-output functions (`function foo(x)`) and the
  bare-statement call form `foo(x);` also work. See `docs/specialization.md`
  for the full ABI.
- **No anonymous functions / function handles** (`@(x) x*x`, `@sin`).
- **Cross-file user functions are supported via numbl's vendored resolver.**
  A call like `helper(x)` resolves to the primary function of a sibling
  `helper.m` in the same directory (numbl's "filename wins" rule applies —
  the first top-level function is what `<basename>(...)` calls, regardless
  of the declared function name). The CLI scans `dirname(entry)` for
  workspace files; the web IDE treats every project file as a workspace
  sibling.
- **Advanced resolution is deferred.** `+pkg/` namespaces, `@Cls/` classes,
  `private/` directories, `import` statements, and `.numbl.js` user
  functions are all recognized by the vendored indexer but raise
  `UnsupportedConstruct` with a clear span at the call site. They will
  light up as mtoc grows; the fence-posts are at lowering time, not at
  scan time, so the resolver's behavior continues to track numbl.
- **Cross-file recursion** falls under the same rejection as intra-file
  recursion — mtoc's specialization cache catches the cycle via its
  mangled-name in-flight set.

## Source language

- **Complex numbers are partial.** Scalar complex literals, unary `+`/`-`,
  scalar `+ - * /`, comparisons + logicals, scalar + tensor `disp`, the
  complex-aware scalar builtins (`sqrt`, `exp`, `log`, `log2`, `log10`,
  `expm1`, `log1p`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`,
  `cosh`, `tanh`, `abs`, `sign`, `min`, `max`, `real`, `imag`, `conj`,
  `angle`), complex tensor literals, complex tensor element-wise
  arithmetic with broadcast, complex tensor reductions (`sum`, `min`,
  `max` over vectors and matrices), are byte-for-byte against numbl.
  `^` (complex pow), the rounding family (`floor`/`ceil`/`round`/`fix`)
  on complex, and `mod`/`rem` on complex are not yet supported. `floor`/`ceil`/`round`/`fix` would need a componentwise
  runtime helper; `mod`/`rem` are real-only by numbl semantics.
- **Strings are partial.** Double-quoted scalar strings (`"hello"`)
  work for `disp`, `error`, `assert(_, msg)`, `strcmp`, `+`
  concatenation with another string or char-array, and `length(s)` /
  `numel(s)` (folded to `1`). What's deferred:
  - **String arrays** (`["a", "b"]`, `string(...)`) — strings are
    scalar-only today.
  - **Indexing** (`s(1)`, `s(2:3)`).
  - **Most string builtins**: `strcat`, `num2str`,
    `strsplit`, `strrep`, `strtrim`, `upper`, `lower`, etc.
    (`sprintf` is supported — single-quoted format → char result,
    double-quoted format → string result, matching numbl.)
  - **String + numeric coercion.** numbl converts e.g. `"v=" + 1`
    to `"v=1"`; mtoc rejects with a `TypeError` requiring the other
    operand of `+` to be a string or char array.
  - **Nested string concat** (`(a + b) + c`). Allowed only as the
    top-level RHS of an assignment; intermediates need a name.
  - **String returns from user functions.** Function returns are
    still scalar-numeric only.
- **Char is partially supported.** Single-quoted char literals
  (`'a'`, `'hello'`) work for `disp`, assignment, `length`/`numel`,
  char arithmetic (`'a' + 1 == 98`, `'abc' + 1`), char comparisons
  (`'a' == 'a'`), horzcat (`['ab' 'cd']`), `error('msg')`,
  `assert(cond, 'msg')`, `strcmp` with any combination of char-array
  / string, and mixed `+` concatenation with a string. What's
  deferred:
  - **2D char matrices** (`['ab'; 'cd']`).
  - **Indexing into char arrays** (`s(1)`, `s(2:3)`).
  - **Char function parameters and char return types.** User
    functions still require scalar-numeric returns.
  - **Most char builtins**: `upper`, `lower`, `num2str`, etc.
- **No cell arrays, structs, classes.**
- **`fprintf` and `sprintf` partial**: the format engine
  (`runtime/format_engine.h`) mirrors numbl's `sprintfFormat`
  byte-for-byte (spec set `d i u f e E g s c x X o %`, flags
  `- + 0 # space`, precision, `*` width, `\n` / `\t` / `\\` escapes
  interpreted at format time, numeric tensor flattening,
  format cycling). Remaining gaps:
  - **fid restricted to literal 1 or 2** at lowering. Numbl routes
    fid=2 to its single `output` stream, so both surface on stdout.
    Other fids and runtime-fid expressions are deferred until
    file-I/O support lands.
  - **Value-returning `n = fprintf(...)`** deferred; statement form
    only. `sprintf(...)` does return its value.
- **`tic` / `toc` clock origin differs from numbl.** mtoc reads
  `clock_gettime(CLOCK_MONOTONIC)`; numbl reads `performance.now()`.
  Both are monotonic, so _elapsed_ durations agree, but the absolute
  value returned by `tic` (and the `toc(h)` handle) differs between
  runtimes — numbl's origin is process start, mtoc's is system boot.
  Cross-runner test scripts should not print the raw `tic` value or
  the elapsed duration; print derived predicates (`disp(e >= 0)`)
  instead. The bare-statement `Elapsed time is X.XXXXXX seconds.`
  output is intentionally non-deterministic in both runtimes.

## Codegen

- **Generated C must compile under `cc`** with default flags + `-lm`. No
  `-std=c99` is required (we use `static inline`-ish patterns that work in
  C90+). Optimization flags aren't passed; the user is expected to rebuild
  with `-O2`/`-O3` outside the harness if they want.
- **No source map / debugger integration.** Function header comments contain
  the source span (file + line range), but there are no `#line` directives
  yet.
- **Parallel loops cover elementwise only.** The `--threads N` / IDE
  thread-count option enables OpenMP on flat-iter and broadcast
  elementwise loops; reductions (`sum`, `min`, `max`, `prod`, and
  their tensor-returning along-axis siblings) stay serial regardless.
  They need a different parallelization shape (a reduction clause for
  the scalar-result form; explicit per-output-slot index derivation
  for the tensor-result form to avoid the shared `out_idx`
  counter). Tracked separately.

## When to add a new entry to this list

When the lowerer raises a _categorical_ `UnsupportedConstruct` for a feature
that a real numbl program would reasonably use, add a one-liner here so the
next person doesn't waste time rediscovering it. Specific bugs (mismatched
output for one script) belong in commit messages or issue trackers, not in
this doc.
