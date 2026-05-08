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
- **Variable re-typing across kinds is rejected.** `x = 3; x = 'hi';` errors
  at the second assignment because mtoc can't fit both in one C variable.
  Use a different name.

## Tensors

- **Dimensions must be statically exact.** `v = [1 2 3]` works; `v = zeros(N,
M)` with runtime `N`/`M` doesn't yet (the lowering surfaces a clear error).
  Dynamic sizing is the next major tensor milestone — its plan is a
  per-function arena allocator that keeps the `mtoc_tensor_t` shape unchanged.
- **Tensor sub-expressions only at `Assign` RHS.** `disp(a + b)` and
  `sum(a .* a)` fail with a clear "assign to a temp first" message.
  Auto-materialization of tensor temporaries during lowering is a known TODO.
- **No matrix multiply / divide / power yet.** `*`/`/`/`^` between two
  tensors is explicitly rejected at lowering with a message pointing the user
  at `.* ./ .^` for elementwise. Matrix ops will need a separate codegen path
  (likely calling into a BLAS-shaped helper).
- **No tensor comparisons.** `a == b` requires both to be scalars. Elementwise
  comparison on tensors will land alongside auto-materialization.
- **Tensor-valued function arguments aren't supported yet.** The type system
  represents them, but the function-arg codegen path only handles scalars.
  Single-output, scalar-argument functions are the only specialization shape
  today.
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

- **No complex numbers.** The type system has an `isComplex` field (always
  `false` today); the codegen path doesn't exist.
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
