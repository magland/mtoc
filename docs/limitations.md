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
- **`sqrt` of an unknown-sign real input always emits complex.** Numbl
  decides at runtime: `realFn → NaN → complexFn`, so `sqrt(x)` returns a
  plain number when `x ≥ 0` at runtime and a complex value otherwise.
  mtoc has to commit at codegen, so any `sqrt(x)` whose static sign isn't
  proved nonneg promotes the result type to complex (the C call goes
  through `csqrt`). Disp / fprintf still match numbl byte-for-byte
  because `mtoc_format_complex` collapses `im == 0` back to the real
  format; but downstream operations that only accept a real operand —
  e.g. `x > 0`, `floor(x)`, `if x`, char/int specs in `fprintf` — will
  refuse the result. The workaround is to wrap the operand
  (`sqrt(abs(x))`) or refine its sign before the call. The same applies
  in principle to other libm builtins whose complex extension is total
  (`log`, `asin`, `acos`, `log2`, `log10`); today only `sqrt` opts in
  via `BuiltinSig.promoteOnDomainMiss`.
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
- **Tensor sub-expressions compose freely.** Element-wise scalar
  builtins (`sqrt`, `sin`, `cos`, `abs`, `atan2`, `hypot`, `power`,
  `min`, `max`, `mod`, `rem`, `floor`, `ceil`, `round`, `fix`,
  `isnan`, `isinf`, `isfinite`, `logical`, `real`, `imag`, `conj`,
  `angle`, `sign`) lift over tensor arguments automatically at the
  top level of an `Assign` — `y = sqrt(x)` materializes the same
  per-slot loop as `y = x .* x`. Owned-producing sub-expressions
  (TensorLit, IndexSlice, MakeRange, string concat, tensor-returning
  user-function calls) are hoisted by the ANF pass, and the same pass
  also hoists _non_-owned multi-element expressions (Binary, Unary,
  elementwise-builtin Call on tensors) at every consume-as-struct
  site — `disp`, `error`, `assert` msg, `fprintf` args, reduction-
  builtin args, user-function args. So `disp(a + b)`,
  `sum(a .* a)`, `fprintf('%d ', a + b)`, `sq(a + b)`, and the
  nested `disp(sqrt(a + b))` all compile cleanly.
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
  for real OR complex operands (scalar↔tensor broadcast or same-shape
  tensor↔tensor); complex `.^` routes through C99 `cpow` per element.
- **Both transposes are wired.** `.'` (non-conjugate) and `'`
  (conjugate) work on 2-D real and complex tensors and on scalars
  — real / char scalars are identity for both; a scalar complex
  `z'` folds to `conj(z)`. The `transpose` / `ctranspose` builtin
  spellings aren't wired yet (only the operator forms); transpose
  of a char array or an `ndim > 2` tensor is still rejected at
  lowering.
- **Tensor comparisons and elementwise logicals lift.** `a == b`,
  `a < b`, `a > 0`, `a ~= b`, `a & b`, `a | b`, etc. produce 0.0/1.0
  tensors at the element-wise broadcast shape. `&&` / `||` stay
  scalar-only (short-circuit semantics); elementwise logical
  conjunction / disjunction over tensors uses `&` / `|`. Note that
  numbl's `&` / `|` runtime helper (`elementWiseLogicalOp`) does NOT
  implement MATLAB-style implicit expansion for differently-shaped
  same-numel operands — it linearly pairs by flat index and returns
  the first operand's shape. mtoc instead routes through the same
  broadcast emitter the comparisons use, which produces MATLAB-correct
  results. Practically this only matters for row + col operands; the
  scalar + tensor and same-shape cases agree byte-for-byte with numbl.
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
  predeclared and freed by the standard liveness machinery. The bare
  statement form `foo(x);` (where `foo` returns an owned value —
  tensor / string / char-array / struct / handle-with-captures) is
  also supported: lowering synthesizes a `_mtoc_stmt_discard_<N>`
  binding for the result so the side effect runs and the heap buffer
  is freed at scope exit by the standard owned-LHS predeclare + free
  walk. The same path covers any owned-typed bare expression
  (`[1,2,3];`, `[1,2,3] + [4,5,6];`).

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
- **Function handles** (`@name`, `@(...) ...`) are supported as
  first-class values backed by a per-shape C struct. The function-call
  DISPATCH is still static — the handle's target identity rides on the
  MType and every `h(args)` resolves to a concrete mangled C function
  at lowering time — so there is no runtime function pointer or
  dispatcher. The struct carries only the captured values. Named
  handles (`@my_func`, `@sin`) share one shared empty typedef;
  anonymous functions with captures get a per-shape typedef
  (`_mtoc_handle__<8hex>`) with one field per capture and the standard
  `_empty` / `_free` / `_copy` / `_assign` helpers. Captured tensors,
  strings, structs, and nested handles all participate via the
  existing owned-kind machinery. The handle's identity is part of the
  higher-order function's specialization key — `apply(@foo, x)` and
  `apply(@bar, x)` produce two distinct `apply__<hex>` specializations.
  What's deferred:
  - **Branch-divergent handle identity.** An `if`/`while`/`for` body
    that assigns different handle targets to the same name (e.g.
    `if c; f = @foo; else; f = @bar; end`) rejects with the same
    storage-category error as the scalar↔tensor split. Top-level
    reassignment with different identity is fine — it splits into a
    fresh C binding like any other category change. Workaround:
    hoist the if/else around the call itself
    (`if c; y = foo(x); else; y = bar(x); end`).
  - **Handles inside tensors / cells** are rejected. Handles in
    struct fields aren't yet wired but are a straightforward
    extension (struct fields already accept arbitrary MTypes; the
    handle's owned-kind helpers compose recursively).
  - **`feval`, `class(h)`, `nargin(h)`, `disp(h)`** are not yet
    wired — call the handle directly with `h(args)` instead.
  - **Builtin handles in multi-output / zero-output positions** are
    rejected (builtins are single-return-value).
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
  `angle`, `isnan`, `isinf`, `isfinite`, `complex`), complex tensor
  literals, complex tensor element-wise arithmetic with broadcast,
  complex tensor reductions (`sum`, `min`, `max` over vectors and
  matrices), are byte-for-byte against numbl. Scalar complex
  conditions in `if` / `elseif` / `while` expand to numbl's toBool
  rule (`creal(z) != 0 || cimag(z) != 0`); `logical(x)` and
  `assert(cond)` remain real-only because numbl rejects a complex
  argument in both. The complex rounding family
  (`floor`/`ceil`/`round`/`fix`) is componentwise via small
  runtime helpers. Scalar `^` / `.^` and tensor `.^` admit complex
  operands and route through C99 `cpow`; matrix `^` on tensors is
  still rejected at lowering. `mod`/`rem` on complex are real-only
  by numbl semantics (their sign-of-divisor / truncate-to-zero
  rules don't have a sensible complex extension). Bare ranges
  (`a:b` / `a:s:b`) and the array constructors
  `zeros`/`ones`/`eye`/`nan`/`inf`/`rand`/`randn` produce real
  tensors only — numbl has no `"like"` / `"complex"` companion-arg
  surface on any of them. To get a complex tensor of a given shape,
  wrap with `complex(...)`: e.g. `complex(zeros(M, N))` for a
  complex zero matrix or `complex(randn(M, N), randn(M, N))` for
  an i.i.d. unit-variance complex normal draw (no `1/sqrt(2)`
  scaling — numbl doesn't apply one either).
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
- **Classes are partial.** Value-semantics classdef with a constructor
  and instance methods is supported — see the dedicated "Classes"
  section below for the precise gaps.
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

## Structs

- **Scalar structs only.** Field-name set is fixed for the lifetime of
  a variable in its scope, inferred by a pre-pass that walks every
  member assignment and `struct(...)` constructor call. Field types
  fill in at the first assignment of each field. Both creation forms
  work — dot-assign (`s.x = ...`) and the `struct('x', v, ...)`
  constructor — and they can mix freely on the same variable.
- **Nested structs work.** `outer.inner.x = ...` and
  `outer.inner = struct('x', ...)` are both supported; the emitted C
  uses one typedef per distinct (recursive) field-set shape, ordered
  innermost-first so a parent typedef can refer to its inner field's
  typedef by name.
- **Copy-on-arg-pass.** Function parameters that take a struct get a
  deep copy at the call site (recursively copying any owned-typed
  fields), so a callee mutating its struct parameter doesn't affect
  the caller's struct.
- **`disp(s)` matches numbl byte-for-byte** for the simple cases
  (`    <name>: <value>` per field, recursing for nested struct
  fields). The struct field-disp does NOT add extra indentation to the
  nested struct's lines beyond what numbl does — matching numbl's
  somewhat-quirky inline-then-no-indent output exactly.
- **Struct returns from user functions are supported** in the same
  shape as tensor returns: 1-output by-value, N-output sret via
  `mtoc_<typedef>_assign` writes through the out-pointer. The
  generated `_copy` helper at the call site preserves value semantics.

### Out of scope for v1 (documented gaps)

- **Struct arrays.** `s(i).f`, `s(i) = struct(...)`, concatenation
  `[s, t]` of structs, `RuntimeStructArray`-style indexing. v1 is
  scalar-only.
- **Dynamic field access:** `s.(name)`. Rejected at lowering with a
  span — no static type for the access target.
- **`[]`-to-struct promotion:** the numbl/MATLAB idiom `s = []; s.x = v`.
  Deferred.
- **Introspection builtins:** `isstruct`, `isfield`, `fieldnames`,
  `class(s)`, `rmfield`. Will surface through the existing "unknown
  builtin" error path.
- **Branch-divergent field-set assignment:** an `if` that assigns
  `s.x` in one arm and `s.y` in the other is rejected with a span.
  Hoist the assignment outside the branch.
- **Struct-shape change across reassignment** is rejected — once a
  variable is bound to a struct of a given field-set, every later
  assignment to that name (struct or non-struct) must agree on the
  field-set. Rename or use a fresh variable for a different shape.
- **Indexing into a struct field at expression position:**
  `s.field(i)` where `field` is a tensor is allowed for scalar /
  integer indices via the parser's `MethodCall` form, but range /
  colon indexing (`s.field(a:b)`) and nested field-then-index chains
  (`s.outer.field(i)`) currently require hoisting the field into a
  local variable first.

## Cell arrays

1-D cell arrays (`{e1, e2, …}`) are supported in two flavors decided by the
cell pre-pass (`src/lowering/cellPrePass.ts`) based on access pattern:

- **Tuple cells** — fixed arity, per-slot types may differ, every `c{k}` /
  `c{k} = …` uses a literal integer index. Emitted as one
  `_mtoc_tcell__<8hex>` typedef per distinct slot-type tuple, with named
  fields `slot_0…slot_(N-1)`. Zero allocation; `c{k}` is a typed field
  access at compile time.
- **Homogeneous cells** — variable length, uniform element type.
  Triggered by any non-literal index access OR an empty `c = {}` literal.
  Emitted as one `_mtoc_hcell__<8hex>` typedef per element MType as a
  `{Elem *data; long len;}` struct, with per-shape helpers including
  `_grow` (extend buffer + zero-init new slots) that runs before every
  `c{k} = v` so the auto-grow rule works for both literal- and variable-
  index writes.

Nesting composes: cell-of-cell, cell-of-struct, struct-of-cell all work.
The cross-kind typedef ordering is handled by a unified topological sort
(`src/codegen/emitOwnedTypedefs.ts`).

### Out of scope for v1 (documented gaps)

- **N-D cells.** `cell(m, n)`, `{e1, e2; e3, e4}` (multi-row literals),
  and indexing with more than one curly slot (`c{i, j}`) are rejected at
  lowering with a span. v1 is 1-D only.
- **`cell(n)` / `cell(m, n)` constructor.** Use `{…}` literal or grow
  from `{}`.
- **Cell concatenation.** `[c1, c2]` of two cells, `{c1{:}, c2{:}}` flatten
  patterns. Not yet wired.
- **Introspection builtins:** `iscell`, `numel(c)`, `length(c)`,
  `size(c)`, `class(c)`, `cellfun`. Will surface through the "unknown
  builtin" error path.
- **`disp(c)` for cells with tensor / struct / nested-cell slots.**
  Rejected with a clear span pointing the user at `disp(c{i})`. The
  inline-format engine would need multi-line coordination matching
  numbl's `formatCell` recursion, which isn't yet wired. Cells of
  scalar reals / complexes / chars / strings / char arrays disp cleanly
  (numbl's `{e1, e2, …}` format byte-for-byte).
- **Branch-divergent cell shape.** An `if` that assigns `c = {…}` of
  arity N in one arm and arity M in another, or one arm tuple and
  another homogeneous, is rejected at the pre-pass merge. Hoist the
  assignment outside the branch, or use a homogeneous cell whose elem
  unifies.
- **Mixing tuple and homogeneous semantics on the same variable** is
  decided by the pre-pass at "first sign of homogeneity wins" — any
  non-literal index or empty literal flips the variable to
  homogeneous for its entire scope.

## Classes

mtoc supports value-semantics `classdef` with constructors, instance
methods, and property reads/writes. Dispatch is fully delegated to
numbl's vendored `resolveFunction` — mtoc never decides which method
is called; it adapts MType to ItemType, calls the resolver, and
consumes the verdict. Both call syntaxes work:

- `obj.method(args)` — `Workspace.resolveForTargetClass` pins
  dispatch into `obj`'s class.
- `method(obj, args)` — the resolver runs its full precedence walk
  (local function > private > class method > workspace function >
  builtin); class dispatch wins only if the class declares the
  method AND no higher-precedence rule fires first.

### Out of scope for v1 (documented gaps)

- **Handle classes** (`classdef X < handle`) — reference semantics
  need a different ABI (refcount or arena allocation); rejected at
  call sites with a span.
- **Inheritance** — `classdef Child < Parent` is rejected. Super-
  calls and method override are deferred to Stage 4.
- **Static methods** — `ClassName.method(args)` syntax and `Static`
  attribute methods rejected at class-info validation.
- **Operator overloads** — `plus`, `minus`, `mtimes`, `eq`,
  `subsref`, `subsasgn`, `horzcat`, `vertcat`, `numel`, `size`,
  `length`, etc. defined as methods cause the class to reject at
  the call site.
- **External method files** (`@ClassName/method.m`) rejected; only
  classdef-inline methods work.
- **`disp(obj)`** — `formatClassInstance` matching numbl
  byte-for-byte isn't ported yet; the `Disp` IR arm rejects
  class-typed args with a span. Use `disp(obj.<prop>)` per
  property.
- **Constructor with no explicit constructor function** — Stage 1
  requires a user-declared constructor. The implicit zero-arg form
  is not yet supported.
- **Class arrays** — `obj(i)`, indexed construction, etc.
  Scalar-only.
- **Nested class properties** — assigning through
  `obj.inner.prop = ...` where `inner` is itself a class instance
  is not yet supported; assign through one property at a time.
- **Branch-divergent class identity** for a single variable —
  rejected by the same storage-category rule structs / handles
  enforce.
- **Constant / Dependent properties**, `get.X` / `set.X` accessor
  methods.
- **Introspection builtins**: `isa`, `class(obj)`, `isobject`,
  `isstruct(obj)`, `properties(obj)`, `methods(obj)`, etc.
- **`Constant` class properties** as `ClassName.NAME` reads.

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
