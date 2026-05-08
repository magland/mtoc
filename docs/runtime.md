# Runtime helpers

The C runtime helpers live in `src/codegen/runtime/` as standalone `.h` files.
Each is a small static C function (or a typedef) inlined into the generated
output on demand. The TypeScript loader (`src/codegen/runtime.ts`) parses
each file, separates `#include` directives from the body, and resolves a
dependency graph so emitted output stays well-ordered.

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
  double *data;
  long rows;
  long cols;
} mtoc_tensor_t;
```

Layout is **column-major** to match numbl / LAPACK. For a tensor of shape
`(R, C)`, element `(r, c)` lives at `data[r + c * R]`.

For statically-known sizes (today's only mode), the codegen predeclares the
backing storage as a stack array (`double _mtoc_<name>_data[N]`) right next
to the struct value (`mtoc_tensor_t <name> = { _mtoc_<name>_data, R, C };`).
No heap allocation, no cleanup. When dynamic sizing arrives, the plan is to
switch the storage path to a per-function arena — the struct shape stays the
same.

Scalars do **not** use the struct. They stay as bare `double` everywhere.

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
loop-counter names, per-tensor backing-buffer names, and so on. The lowerer
defensively rejects user identifiers starting with `_mtoc_` (numbl syntax
already disallows leading underscores, but it's belt-and-suspenders).
