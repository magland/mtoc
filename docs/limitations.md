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
  whether an axis is `one` (broadcast), `notOne` (≥2 or 0), or `unknown`;
  the specific size lives at runtime on `mtoc_tensor_t.rows` / `.cols`.
  This collapses specializations across same-shape-category calls
  (`total([1 2 3])` and `total([1 2 3 4])` share one mangled function)
  and lets a tensor variable take on different runtime shapes via free +
  realloc at the assignment site.
- **Builtins for runtime-shape allocation aren't here yet.**
  `zeros(N, M)`, `ones(N, M)`, etc. with a runtime size still raise
  `UnsupportedConstruct`. The codegen path for dynamic-shape allocation
  is in place — only the builtin signatures and runtime helpers remain.
- **Tensor sub-expressions only at `Assign` RHS.** `disp(a + b)` and
  `sum(a .* a)` fail with a clear "assign to a temp first" message.
  Auto-materialization of tensor temporaries during lowering is a known TODO.
- **No matrix multiply / divide / power yet.** `*`/`/`/`^` between two
  tensors is explicitly rejected at lowering with a message pointing the user
  at `.* ./ .^` for elementwise. Matrix ops will need a separate codegen path
  (likely calling into a BLAS-shaped helper).
- **No tensor comparisons.** `a == b` requires both to be scalars. Elementwise
  comparison on tensors will land alongside auto-materialization.
- **Tensor-valued function returns aren't supported yet.** Functions accept
  tensor arguments (real or complex), but the return type must be a scalar
  (real or complex). Returning a tensor needs an sret-style codegen path
  that's still pending. Tensor params are also borrowed by value: the body
  cannot reassign one (the lowerer rejects it with a span pointing at the
  offending statement) — introduce a fresh local instead.
- **`sum` on a matrix isn't supported.** Vector sum returns scalar; matrix sum
  in numbl returns a row vector of column sums, which needs a tensor-returning
  builtin path.

## Functions

- **Recursion is rejected** with an explicit error. Lifting requires forward
  declarations + fixpoint return-type inference.
- **Single output per function.** Multi-output `[a, b] = f(x)` will likely use
  C output pointers when added.
- **No anonymous functions / function handles** (`@(x) x*x`, `@sin`).
- **No file-level functions** (one function per `.m` file). Today only local
  functions defined within the same script work. numbl's wider workspace
  resolution (private functions, packages, classes) isn't inherited.

## Source language

- **Complex numbers are partial.** Scalar complex literals, unary `+`/`-`,
  scalar `+ - * /`, comparisons + logicals, scalar + tensor `disp`, the
  complex-aware scalar builtins (`sqrt`, `exp`, `log`, `log2`, `log10`,
  `expm1`, `log1p`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`,
  `cosh`, `tanh`, `abs`, `sign`, `min`, `max`, `real`, `imag`, `conj`,
  `angle`), complex tensor literals, complex tensor element-wise
  arithmetic with broadcast, and complex vector `sum` are byte-for-byte
  against numbl. `^` (complex pow), the rounding family
  (`floor`/`ceil`/`round`/`fix`) on complex, `mod`/`rem` on complex, and
  complex `min`/`max` over tensors (only scalars today) are not yet
  supported. `floor`/`ceil`/`round`/`fix` would need a componentwise
  runtime helper; `mod`/`rem` are real-only by numbl semantics.
- **No char / string.** `'hello'` and `"hello"` raise
  `UnsupportedConstruct: Char` / `String`.
- **No cell arrays, structs, classes.**
- **No `fprintf`** beyond the `disp` runtime helper.

## Codegen

- **Generated C must compile under `cc`** with default flags + `-lm`. No
  `-std=c99` is required (we use `static inline`-ish patterns that work in
  C90+). Optimization flags aren't passed; the user is expected to rebuild
  with `-O2`/`-O3` outside the harness if they want.
- **No source map / debugger integration.** Function header comments contain
  the source span (file + line range), but there are no `#line` directives
  yet.

## When to add a new entry to this list

When the lowerer raises a _categorical_ `UnsupportedConstruct` for a feature
that a real numbl program would reasonably use, add a one-liner here so the
next person doesn't waste time rediscovering it. Specific bugs (mismatched
output for one script) belong in commit messages or issue trackers, not in
this doc.
