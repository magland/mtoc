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
typedef struct {
  double *MTOC_RESTRICT real;   /* always non-NULL */
  double *MTOC_RESTRICT imag;   /* NULL iff statically real */
  long rows;
  long cols;
} mtoc_tensor_t;
```

Storage mirrors numbl's split layout: `real` and `imag` are separate
`double` buffers (no interleaved pairs). For a real tensor `imag` is NULL.
The type system tracks `isComplex` statically, so codegen knows up front
whether to touch the imag side — there is no runtime branch on
`imag != NULL`.

Layout is **column-major** to match numbl / LAPACK. For a tensor of shape
`(R, C)`, element `(r, c)` lives at `real[r + c * R]` (and, when complex,
the imaginary part lives at `imag[r + c * R]`).

Backing storage is allocated on the **heap** for every tensor, by every
emitted program — there is no stack-array fast path. The codegen predeclares
each tensor as a single struct value whose `real` (and `imag`, when complex)
fields are populated by an inline call to the `mtoc_alloc` runtime helper:

```
mtoc_tensor_t v = { mtoc_alloc(N * sizeof(double)), NULL, R, C };
mtoc_tensor_t z = { mtoc_alloc(N * sizeof(double)),
                    mtoc_alloc(N * sizeof(double)), R, C };
```

`mtoc_alloc` is a thin wrapper around `malloc` that aborts with a clear
diagnostic on allocation failure (so the call site can drop the result
straight into a struct initializer without a NULL check). Lives at
`runtime/alloc.h`, registered as the `mtoc_alloc` snippet, and activated
alongside `mtoc_tensor_t` whenever any tensor is declared.

Going uniformly heap means every `.m` script — even ones that only ever
use small tensors — exercises the production allocation path. The earlier
stack-array model would have only kicked over to heap above an 8 MB stack
budget, leaving the heap path bitrot-prone. Cross-runner coverage now
comes "for free" from every existing test.

**Cleanup.** Every `mtoc_alloc` is paired with a `free` at scope exit.
Codegen emits `free(<v>.real)` (and `free(<v>.imag)` for complex tensors)
immediately before each `return` in:

- the implicit fall-through return at the end of `main()`,
- the implicit fall-through return at the end of every user function,
- every explicit `IRStmt.ReturnFromFunction` early-return inside a
  function body.

Free order matches declaration order (sorted by C identifier) so the
generated C is deterministic. The free is unconditional — the malloc
above is also unconditional, even when the variable's first source-level
assignment is inside an `if` branch.

`MTOC_RESTRICT` is a small macro defined alongside the struct: it expands to
`__restrict__` under GCC/Clang and to nothing on compilers that don't
recognize it. It tells the compiler that two distinct `mtoc_tensor_t`
values' buffers do not alias each other, which the autovectorizer relies on
for elementwise loops.

**Shape-mismatch trap (`mtoc_check_shape`).** With the coarse dim lattice
the type system no longer catches same-category shape mismatches like
`[1 2 3] + [4 5]` at lowering. The codegen closes the gap at the
elementwise-assign site: it picks the same shape source as
`findShapeSourceVar` and emits one `mtoc_check_shape(<source>, <other>)`
per distinct non-source multi-element Var on the RHS, just before the
staging-buffer alloc. The helper compares `rows` and `cols`; on mismatch
it prints `mtoc: shape mismatch in elementwise op - got (R x C) and
(R' x C')` to stderr and `abort()`s. Same-Var cases (`v .* v`) and
scalar-broadcast cases (`v .* 2`, `-v`) emit zero checks, since there
is nothing to compare against. The check is once-per-assign — once the
source agrees in shape with every other operand, every per-element read
inside the loop is in-bounds. Lives at `runtime/check_shape.h`,
registered as the `mtoc_check_shape` snippet, and depends on
`mtoc_tensor_t`.

Scalars do **not** use the struct. Real scalars are bare `double`; complex
scalars are `double _Complex` (C99).

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
loop counters (`_mtoc_i`, `_mtoc_n`), elementwise staging temporaries
(`_mtoc_t`), and split-binding names introduced by the lowerer
(`_mtoc_<name>__v<N>`). The lowerer defensively rejects user identifiers
starting with `_mtoc_` (numbl syntax already disallows leading underscores,
but it's belt-and-suspenders). Tensor backing storage no longer has a
named C identifier — `mtoc_alloc` returns the pointer directly into the
struct initializer, so there's nothing to label.
