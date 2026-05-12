# Runtime helpers

The C runtime helpers live in `src/codegen/runtime/` as standalone `.h` files.
Each is a small static C function (or a typedef) inlined into the generated
output on demand. The TypeScript loader (`src/codegen/runtime.ts`) parses
each file, separates `#include` directives from the body, and resolves a
dependency graph so emitted output stays well-ordered.

The `.h` bodies are inlined into `src/codegen/runtime/snippets.gen.ts` by
`scripts/build_runtime_snippets.ts` and read from there at module load —
this keeps the translator browser-bundlable (no `fs.readFileSync` at import
time). Re-run `npm run build:snippets` after editing or adding any `.h` file;
CI runs `npm run build:snippets:check` to catch drift.

## Why .h files

- Edit with normal C tooling — clangd / syntax highlighting / formatters.
- Diff cleanly when the C changes.
- Unit-test independently if needed (we don't today, but the path is open).
- Self-document via header comments.

## Snippet shape

Each `.h` file has the same conventional layout:

```
/* Documentation comment: what this helper does and any numbl
 * compatibility notes. */

#include <stdio.h>     /* parsed out, deduped, hoisted to the top */
#include <math.h>

static double mtoc_foo(double x) { ... }
```

The loader reads the file, extracts the angle-bracket and quoted `#include`
lines, and treats the rest as the snippet body. Standard library headers
(`<stdio.h>`, `<math.h>`, etc.) are unioned across all activated snippets and
emitted once at the top of the output.

## Dependency graph

Each registry entry can declare dependencies on other helpers by name. When
the codegen activates a helper (via `useRuntime`/`useRuntimeByName`), the
loader transitively activates everything in the dep closure first, so
definitions appear before their uses. A few present examples:

- `mtoc_disp_double` depends on `mtoc_format_double` (both share the same
  formatting logic).
- `mtoc_disp_tensor` depends on `mtoc_format_double` and `mtoc_tensor_t`.
- `mtoc_sum` / `mtoc_length` / `mtoc_numel` depend on `mtoc_tensor_t`.

Cycles are unsupported — keep the graph acyclic.

## Tensor representation

Multi-element tensors are passed through C as a single `mtoc_tensor_t` struct:

```
#define MTOC_MAX_NDIM 8

typedef struct {
  double *MTOC_RESTRICT real;   /* always non-NULL */
  double *MTOC_RESTRICT imag;   /* NULL iff statically real */
  int  ndim;
  long dims[MTOC_MAX_NDIM];
} mtoc_tensor_t;
```

Storage mirrors numbl's split layout: `real` and `imag` are separate
`double` buffers (no interleaved pairs). For a real tensor `imag` is NULL.
The type system tracks `isComplex` statically, so codegen knows up front
whether to touch the imag side — there is no runtime branch on
`imag != NULL`.

Shape is stored inline: `ndim` axes with sizes `dims[0..ndim-1]`. The
minimum logical `ndim` is 2 (matching numbl) — a row vector is `{1, n}` and
a column is `{n, 1}`. Keeping `dims` inline preserves the value-typed
semantics of `mtoc_tensor_t`: copy / free / assign do a struct copy and
touch only the two heap pointers, so the shape rides along for free.
`MTOC_MAX_NDIM` caps the inline array at 8; constructors abort when an
N-D allocation would exceed it.

Layout is **column-major** to match numbl / LAPACK. For a tensor of shape
`(d0, d1, …)`, element `(i0, i1, …)` lives at
`real[i0 + i1*d0 + i2*d0*d1 + …]` (and the imag part at the same offset
in `imag` when complex).

Backing storage is allocated on the **heap** for every tensor, by every
emitted program — there is no stack-array fast path. Going uniformly heap
means every `.m` script — even ones that only ever use small tensors —
exercises the production allocation path.

`mtoc_alloc` is a thin wrapper around `malloc` that aborts with a clear
diagnostic on allocation failure (so the call site can drop the result
straight into a struct initializer without a NULL check). Lives at
`runtime/alloc.h` and is the lowest-level building block; the
construction helpers below all delegate to it.

`MTOC_RESTRICT` is a small macro defined alongside the struct: it expands to
`__restrict__` under GCC/Clang and to nothing on compilers that don't
recognize it. It tells the compiler that two distinct `mtoc_tensor_t`
values' buffers do not alias each other, which the autovectorizer relies on
for elementwise loops.

## Tensor lifecycle helpers

Generated C goes through a small family of helpers so the emitted code
reads close to the numbl source. The full set lives under
`src/codegen/runtime/tensor_*.h`:

- `mtoc_tensor_empty()` — zero-initialized placeholder (`{NULL, NULL,
0, {0}}`). Returned at every predecl site so a tensor variable starts
  in a known state.
- `mtoc_tensor_alloc(rows, cols)` /
  `mtoc_tensor_alloc_complex(rows, cols)` — allocate an uninitialized
  2-D tensor of the given shape. The workhorse for elementwise-result
  construction. Internally sets `ndim = 2`.
- `mtoc_tensor_alloc_nd(ndim, dims)` /
  `mtoc_tensor_alloc_nd_complex(ndim, dims)` — N-D variant used by
  `reshape`. Aborts when `ndim > MTOC_MAX_NDIM`.
- `mtoc_tensor_from_row(data, n)` /
  `mtoc_tensor_from_row_complex(re, im, n)` — build a 1×n tensor from
  a flat data pointer (typically a C99 compound literal).
- `mtoc_tensor_from_matrix(data, rows, cols)` /
  `mtoc_tensor_from_matrix_complex(re, im, rows, cols)` — same, for a
  rows×cols matrix in column-major order.
- `mtoc_tensor_copy(src)` / `mtoc_tensor_copy_complex(src)` — deep
  copy. The receiver gets a freshly-owned tensor with the source's
  `ndim` and `dims` preserved.
- `mtoc_tensor_reshape(src, ndim, dims)` /
  `mtoc_tensor_reshape_complex(src, ndim, dims)` — reshape `src` to a
  new shape. The element count must match `numel(src)`; aborts on
  mismatch.
- `mtoc_tensor_free(&t)` — release backing buffers and reset the
  struct. Shape-agnostic (real and complex use the same helper —
  `free(NULL)` is well-defined and the imag-side free is a no-op for
  real tensors, so there is no runtime branch on `isComplex`).
- `mtoc_tensor_assign(&lhs, rhs)` — consume-and-replace. Frees
  `*lhs`'s current buffers and moves `rhs`'s buffers into `*lhs`.
  Codegen guarantees that every RHS is a freshly-owned tensor
  (literal, copy, or alloc'd elementwise result), so the move (rather
  than a deep copy here) is sound.

The split-by-isComplex helpers (`alloc`, `from_row`, `from_matrix`,
`copy`) preserve the "no runtime branch on `imag != NULL`" invariant:
codegen knows `isComplex` statically and dispatches to the right
variant. `empty` / `free` / `assign` are shape-agnostic by design.

## Copy semantics

Every manipulation copies. Specifically:

- **Tensor-by-name assignment** (`y = x;`) emits
  `mtoc_tensor_assign(&y, mtoc_tensor_copy(x));`.
- **Tensor literals** (`x = [1 2 3];`) emit
  `mtoc_tensor_assign(&x, mtoc_tensor_from_row((double[]){1.0, 2.0,
3.0}, 3));` — one helper-pair per source statement.
- **Elementwise expressions** (`s = a + b;`) build a fresh tensor via
  `mtoc_tensor_alloc(...)`, fill its `.real` / `.imag` slots in a
  loop, then `mtoc_tensor_assign(&s, _mtoc_t)`. The check-shape
  helper guards same-category mismatches just before the alloc.
- **User-function calls** wrap every tensor argument in
  `mtoc_tensor_copy(...)` so the callee gets an owned tensor (which
  it may reassign or free at scope exit). Builtins like `disp`,
  `sum`, `length`, and `numel` are known read-only and skip the wrap.

Optimizations to share buffers safely (avoiding the copy when liveness
analysis can prove no other reference exists) are an open roadmap
item; the priority for the current generation is clarity and
correctness over performance.

## Owned-kind registry

The C-side helpers each owned `MType` maps to (typedef, `empty`, `free`,
`assign`, `copy`, `disp`) live in one table at
[`src/codegen/ownedKinds.ts`](../src/codegen/ownedKinds.ts). `ownedOps(ty)`
returns the row for any owned type — string, char-array, real-or-complex
multi-element double tensor — or `null` for non-owned types.

Every codegen site that used to switch on `(isString | isCharArray |
isMultiElement)` to pick a helper is now a `ownedOps(ty).<role>` lookup:
`emitDeclarations` / `emitScopeExitFrees` / `emitEarlyFrees`, the
`Disp` and owned-LHS `Assign` arms of `emitStmt`, and the copy-on-arg-
pass wrapper for tensor / char-array call arguments. Adding a new
owned kind (logical-tensor, cell, struct, …) is one entry plus the
matching `.h` files; the call sites pick it up automatically.

The complex-vs-real split for `copy` and `disp` lives inside the
registry's per-row closure (`copy: ty => isComplex ?
"mtoc_tensor_copy_complex" : "mtoc_tensor_copy"`), so call sites stay
type-uniform.

## Cleanup

Every owned-heap-value variable is released as soon as it is no
longer needed, not deferred to end-of-scope. "Owned" today means a
multi-element tensor or a string — anything for which `isOwned(t)`
in `src/lowering/types.ts` returns true. Codegen drives this off a
backward "future-touch" dataflow over the IR (see
`src/codegen/liveness.ts`): for each statement `s`, it computes the
set of owned variables that may be touched (read or written) at any
successor of `s`. An owned `v` is "dead-after `s`" when `v` is in
`s`'s top-level uses-or-defs but NOT in its future-touch set — i.e.
`s` was its last touch on this scope's CFG. The codegen emits a free
call (`mtoc_tensor_free(&v);` for tensors, `mtoc_string_free(&v);`
for strings, picked from `v`'s type via `currentScopeVars`)
immediately after `s`'s C output for every dead-after `v`.

Two consequences worth calling out:

- **A reassignment counts as a "future touch".** If `v`'s next
  statement-level interaction is `v = …;`, the early free at the
  previous use is suppressed — the reassignment lowers to
  `mtoc_tensor_assign(&v, …)` / `mtoc_string_assign(&v, …)`, which
  already releases the prior buffer.
- **Loop-body cross-iteration uses keep owned values live.** The
  fixpoint over the body's "after-body-last" set means an owned read
  inside a `for` / `while` body but allocated outside is always live
  across iterations; its early free lands after the loop closes, not
  inside the body.

A scope-exit free walk remains as a safety net: every owned binding
in `assignedVars` (plus owned tensor parameters under copy-on-arg-
pass) gets a closing free at every scope exit — the implicit
fall-through return at the end of `main()`, the implicit fall-through
return at the end of every user function (a `return <cName>;` for
single-output, the `*_mtoc_o<i> = …; return;` writes for
multi-output, or simply falling off the `void` body for zero-output),
and every explicit `IRStmt.ReturnFromFunction` early-return inside a
function body. The
walk consults a per-path `freedOwned` tracker and skips any name
already freed earlier on the linear flow (so unconditionally dead
values don't get a redundant scope-exit free emit). Path tracking is conservative at branches: only vars freed
on EVERY arm of an `If` graduate to the post-`If` freed set, and
loops never graduate vars freed inside their bodies (the loop may
have iterated zero times). Vars freed in only some arms still have
their scope-exit free emitted as a backstop; `mtoc_tensor_free` is
idempotent on a zeroed struct, so the runtime double-call is a
no-op.

Free order at every scope-exit site is sorted by C identifier so
generated C stays deterministic. Predecls are unconditional, even
when a variable's first source-level assignment is inside an `if`
branch.

**Same-shape trap (`mtoc_check_shape`).** When every multi-element
operand on the RHS shares the same static shape, the codegen takes the
flat-iter path and emits one `mtoc_check_shape(<source>, <other>)` per
distinct non-source multi-element Var, just before the staging-buffer
alloc. The helper compares dims across the operands' ndim; on mismatch
it prints `mtoc: shape mismatch in elementwise op - got (...) and
(...)` to stderr and `abort()`s. Same-Var cases (`v .* v`) and
scalar-broadcast cases (`v .* 2`, `-v`) emit zero checks. Once the
source agrees in shape with every other operand, every per-element
read inside the loop is in-bounds. Lives at `runtime/check_shape.h`,
registered as the `mtoc_check_shape` snippet, and depends on
`mtoc_tensor_t`.

**Per-axis broadcast helper (`mtoc_broadcast_dim`).** When operands
have _differing_ static shapes (e.g. row vec + col vec, matrix +
column vec, lower-rank operand vs higher-rank one), the codegen
switches to the broadcast emitter. For each output axis it chains
`mtoc_broadcast_dim(a, b)` across every operand: the helper returns
`max(a, b)` when one side is `1` or both sides are equal, and aborts
with `mtoc: shape mismatch in elementwise broadcast - axis sizes %ld
and %ld are not broadcast-compatible` otherwise. Inside the body the
emitter precomputes a per-operand linear index that drops the term
contributed by any statically-`one` operand axis (those reuse one
element while the loop advances). Lives at `runtime/broadcast_dim.h`,
registered as the `mtoc_broadcast_dim` snippet — no struct dep, just
`<stdio.h>` / `<stdlib.h>`.

Scalars do **not** use the struct. Real scalars are bare `double`; complex
scalars are `double _Complex` (C99).

## String representation

Strings (numbl `string`, scalar only) have their own small struct, separate
from the tensor representation:

```
typedef struct {
  const char *data;
  long len;
  int owned;
} mtoc_string_t;
```

- `data` — pointer to the byte sequence. NULL on an empty handle
  (`mtoc_string_empty()`).
- `len` — length in **bytes**, not code points. Encoding is UTF-8 by
  convention; the runtime never inspects code points.
- `owned` — `1` iff `data` was malloc'd by an mtoc helper and must be
  freed on disposal. `0` for handles pointing at a C string literal in
  `.rodata` (the common case for `mtoc_string_from_literal`); freeing
  those is undefined behavior, so the free helper checks the flag.

The owned-flag design keeps literals zero-allocation while concat
results are heap-allocated, and gives every code path a single uniform
free / assign API regardless of where the buffer came from.

### String lifecycle helpers

Every string variable predeclares to `mtoc_string_empty()` and goes
through the same lifecycle pair as tensors:

- `mtoc_string_empty()` — `{NULL, 0, 0}`. Predeclaration default.
- `mtoc_string_from_literal(src, len)` — non-owning handle pointing
  straight at a C string literal (`owned=0`, no allocation). Codegen
  emits this for every `StringLit` IR node.
- `mtoc_string_copy(s)` — deep-copy into a fresh heap buffer (`owned=1`).
  Used at the `c = a;` assignment path so the source remains usable.
- `mtoc_string_concat(a, b)` — concat into a fresh heap buffer
  (`owned=1`). Takes two `mtoc_text_view_t` arguments so it can
  accept any combination of string / char-array operands; backs the
  `+` operator whenever at least one side is a string.
- `mtoc_string_free(&s)` — releases the backing buffer iff `owned`,
  then resets the struct to the empty shape. Idempotent on a zeroed
  struct, so the scope-exit safety net is sound across branch merges.
- `mtoc_string_assign(&lhs, rhs)` — consume-and-replace. Frees `*lhs`
  (no-op if not owned), moves `rhs` into place. Codegen emits this on
  every string `Assign`.

`disp(s)`, `error(s)`, `strcmp(a, b)`, and `assert(cond, msg)` no
longer call string-specific helpers — they route through the shared
text-view helpers described in the "Text view" section below, which
accept either source kind via a zero-copy adapter.

Strings ride the same early-free liveness pass as tensors (see the
"Cleanup" section): a string `v` whose last touch is statement `s`
gets `mtoc_string_free(&v);` emitted immediately after `s`, and the
scope-exit walk catches anything still alive at the end. The owned
flag means literal handles cost nothing to "free" — `mtoc_string_free`
is idempotent on a zeroed struct.

### String memory model

- **Literals don't allocate.** A `StringLit` lowers to a non-owning
  handle pointing at the C string constant in `.rodata`.
- **Every manipulation that needs a fresh buffer takes ownership.**
  `mtoc_string_copy` and `mtoc_string_concat` are the only producers of
  owned buffers; both return a struct the caller must hand to
  `mtoc_string_assign` or `mtoc_string_free`.
- **String concat is allowed only at the top of `Assign.rhs`.** A
  nested string `Binary` (e.g. `(a + b) + c`) would leak the inner
  owned buffer because nothing installs it. The lowering-pass
  validator rejects with a span; the workaround is to assign each
  intermediate to a name first.
- **Encoding is UTF-8 by convention.** The runtime treats `data` as
  opaque bytes. `length(s)` always returns `1` (numbl semantics for
  scalar string), so byte-vs-code-point ambiguity never surfaces in
  computed lengths.

## Char-array representation

Char arrays (numbl `'…'`, single-quoted) are a separate struct from
both tensors and strings:

```
typedef struct {
  const char *data;
  long rows;
  long cols;
  int owned;
} mtoc_char_tensor_t;
```

- `rows` / `cols` carry the runtime shape (today always `rows == 1`;
  2D char matrices are deferred).
- `owned` follows the same convention as `mtoc_string_t`: `0` for
  handles pointing at a literal in `.rodata`, `1` for handles whose
  buffer was malloc'd by `mtoc_char_tensor_alloc` /
  `mtoc_char_tensor_copy`.

Scalar chars (1×1) do **not** use the struct — they're a bare C `char`
in automatic storage, like real scalars are bare `double`. The
multi-element / scalar split is the same partition the tensor side
uses.

The lifecycle helpers (`mtoc_char_tensor_empty` /
`_from_literal` / `_alloc` / `_copy` / `_assign` / `_free`) mirror the
tensor and string helpers exactly, and char arrays plug into the same
`isOwned` / early-free / scope-exit infrastructure as strings and
double tensors. Scalar chars use `mtoc_disp_char`; multi-element char
arrays route through `mtoc_disp_text` (see the "Text view" section
below) so they share one display helper with strings.

Char-arithmetic (`'a' + 1`, `'abc' + 'def'`) reads each char as a
double on-the-fly inside the elementwise loop (`(double)v.data[i]`)
and produces a fresh double tensor. The promotion is a single read-
site cast — there's no separate "convert char tensor to double tensor"
pass. The outcome matches numbl: any binary arithmetic with a char
operand widens to double.

## Text view

numbl distinguishes `string` (scalar handle, byte length) from `char`
arrays (1×N row vector of bytes), but the runtime helpers that
consume text — `disp`, `error`, `assert(_, msg)`, `strcmp`,
`string_concat` — only need to walk the bytes. mtoc exposes a single
non-owning view struct so each helper has one signature regardless of
the source kind:

```
typedef struct {
  const char *data;
  long len;
} mtoc_text_view_t;
```

Two zero-copy adapters live alongside it in `runtime/text_view.h`:

- `mtoc_text_from_string(s)` — wraps an `mtoc_string_t` (uses `s.len`
  directly).
- `mtoc_text_from_char_tensor(c)` — wraps an `mtoc_char_tensor_t`
  (uses `c.rows * c.cols`).

Codegen sites that take text wrap each operand in the appropriate
adapter at the call boundary (via `wrapTextView` in
`codegen/emitExpr.ts`). The view is non-owning — the underlying buffer
stays with the caller (literal in `.rodata`, owned `mtoc_string_t`,
or owned `mtoc_char_tensor_t`) and the helpers never free.

The unified helpers are:

- `mtoc_disp_text(v)` — prints `v.data[0..len]` to stdout + newline.
  Backs `disp(s)` for both string and char-array args.
- `mtoc_error_text(v)` — writes the message to stderr, then `exit(1)`.
  Backs `error(s)` for both kinds.
- `mtoc_assert_double_msg_text(cond, v)` — like `mtoc_assert_double`
  but prints the user-supplied message on failure. Backs `assert(cond,
msg)` for any text msg.
- `mtoc_strcmp_text(a, b)` — byte-for-byte equality on two views,
  returning 1.0 / 0.0. Backs `strcmp(a, b)` for any combination of
  text args.
- `mtoc_string_concat(a, b)` — takes two views and returns a fresh
  owned `mtoc_string_t`. Backs the `+` operator whenever at least one
  side is a string; mixed `string + char_array` and
  `char_array + string` both produce a string result.

Adding a new text-aware helper means writing one `.h` body that takes
`mtoc_text_view_t` (and depending on `mtoc_text_view_t` in the
registry); the call-site dispatch is uniform via `wrapTextView`.

Scalar chars (1×1 bare C `char`) are intentionally outside the text
view today — they retain the numeric-character role (`'A' + 1`) and
`disp('a')` still routes through `mtoc_disp_char`.

## Adding a helper

1. Create `src/codegen/runtime/foo.h` with the standard shape:

   ```c
   /* mtoc runtime helper: short description of what foo does. */

   #include <math.h>   /* whatever you need */

   static double mtoc_foo(double x) { ... }
   ```

2. Register it in `src/codegen/runtime.ts` with any deps it needs. The key is
   the C identifier the codegen will emit (`"mtoc_foo"`).
3. If a builtin needs to emit a call to this helper, point the builtin's
   factory at the registry name (e.g.
   `runtime("foo", 1, "mtoc_foo", "unknown", ["positive"])`).
4. Run the cross-runner — emitted output should now contain the helper's body
   for any program that triggers its activation.

## Reserved name prefix

Anything beginning with `_mtoc_` is reserved for the codegen — synthetic
loop counters (`_mtoc_i`, `_mtoc_n`), elementwise staging tensors
(`_mtoc_t`), per-cell complex temporaries inside tensor literals
(`_mtoc_c<N>`), and split-binding names introduced by the lowerer
(`_mtoc_<name>__v<N>`). The lowerer defensively rejects user identifiers
starting with `_mtoc_` (numbl syntax already disallows leading underscores,
but it's belt-and-suspenders). Tensor backing storage has no named C
identifier — the `mtoc_tensor_*` helpers return the struct directly into
the assign call, so there's nothing to label.
