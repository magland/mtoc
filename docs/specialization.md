# Function specialization

mtoc emits one C function per unique call-site argument-type tuple. There are
no generic / templated C functions in the output — every user function is
monomorphized.

## The flow

1. Top-level `function ... end` definitions are pulled out of the script body
   during the first pass over the AST and registered in the workspace's
   local-function table. The remaining stmts form the script body.
2. When the lowerer encounters a call to a user function, it lowers the
   arguments, computes their full canonical types, and hashes
   `{file, args}` (the function's source file path along with the
   canonicalized type list) into a short suffix (8 hex chars of FNV-1a
   32-bit). Salting by source file is what lets same-named subfunctions in
   different `.m` files coexist without colliding on the hash.
3. The mangled name is `<funcName>__<hash>`. If a specialization with that name
   already exists in the cache, the call reuses it. Otherwise the lowerer
   recursively lowers the function body in a fresh scope, with each parameter
   bound to the actual call-site type (full type, **including sign and
   shape**).
4. The resulting `IRFunction` is appended to the program's function list, and
   subsequent calls with identical argument tuples hit the cache.

Two consequences worth keeping in mind:

- **Sign is part of the key.** Calling `f(positive_value)` and `f(negative_value)`
  produces _different_ specializations, with different mangled names. That's by
  design: a sign-sensitive operation in the body (`sqrt(x)`, `log(x)`) is
  validated against the actual call-site sign rather than rejected categorically.
- **Different specializations may emit identical C.** If two distinct argument
  tuples lead to byte-identical function bodies (common when sign is the only
  difference and the body has no sign-sensitive ops), the codegen still emits
  both — body-level deduplication is a future pass. The footprint cost is
  bounded by the number of distinct tuples actually appearing in the program.

## Why hash-based names

We considered numeric `__1` / `__2` suffixes assigned in registration order,
but the hash form is deterministic across runs without any persistent counter
state. Two `mtoc translate` invocations on the same input produce identical
mangled names — useful for diffing emitted output.

## Recursion

Direct recursion is currently rejected with an explicit error. The lowering
pass tracks "in-flight" specializations; a recursive call on the same key
trips the rejection. Lifting this requires treating the in-flight entry as a
forward declaration with a placeholder return type, then iterating to fixpoint
once the body's return type stabilizes — that work is on the longer-term
roadmap and is part of the larger "decouple type inference from IR
construction" item.

## Function header comments

Every emitted function gets a header comment showing:

- The numbl name and parameter list
- The source file + line range of the original `function ... end`
- The mangled C name (so a reader can find where the call comes from)
- The inferred type (with sign info) of each parameter and the return value

Example:

```
/* User function specialization: square_then_double(x)
 *   defined : examples/foo.m:13-15
 *   mangled : square_then_double__1c53c2ec
 *   x       : Tensor<scalar(1x1), double, real, sign=positive>
 *   returns : Tensor<scalar(1x1), double, real, sign=nonnegative>
 */
static double square_then_double__1c53c2ec(double x) { ... }
```

Useful both for human readers and for any tooling that wants to map mangled
names back to source. The same comment shape applies to tensor parameters —
`typeToString` renders e.g. `Numeric<rowVec(1x5), real>` and the emitted C
signature uses `mtoc_tensor_t v` for that param (borrowed by value).

## Output conventions

mtoc supports user functions with **0, 1, or N≥2** outputs. Each output
can be a scalar (real / complex) or an owned kind (real / complex
double tensor, char tensor, scalar string). The emitted C ABI is picked
per output count:

- **0 outputs**: `static void <mangled>(args) { … }`. A bare-statement call
  `foo(x);` lowers to `<mangled>(args);`.
- **1 output**: classic return-by-value — `static T <mangled>(args) { … }`,
  with `return <local>;` at every exit. Scalar real → `double`; scalar
  complex → `double _Complex`; owned kinds → their struct type
  (`mtoc_tensor_t`, `mtoc_char_tensor_t`, `mtoc_string_t`). For owned
  returns the callee skips freeing the output's local at scope exit so
  the heap buffers transfer cleanly to the caller; the call site
  consumes the returned struct with `mtoc_<kind>_assign(&lhs,
<mangled>(args))`.
- **N≥2 outputs**: `static void <mangled>(args, T1 *_mtoc_o0, T2 *_mtoc_o1, …)`.
  At every exit (the implicit fall-through and every explicit `return;`),
  the codegen writes each output's local through the matching
  out-pointer. Scalar slots use `*_mtoc_o<i> = <cName>;`; owned slots
  use `mtoc_<kind>_assign(_mtoc_o<i>, <cName>);` so the caller's prior
  buffer at the lvalue is consumed cleanly. Owned output locals are
  excluded from the callee's scope-exit free walk.

The N-output call site looks like `[a, b] = foo(x);` (with `~` to ignore
a slot, e.g. `[~, q] = divmod(a, b);`). The codegen wraps the call in
a `{ … }` block; ignored slots get a `T_i _mtoc_discard_<callIdx>_<slot>;`
local declared inline so the discard temps stay scoped to the call.
For owned discard slots the local is initialized to an empty handle
(`mtoc_<kind>_empty()`) before the call and freed via
`mtoc_<kind>_free(&…)` immediately after, so the dropped buffer
doesn't leak. Calling an N-output function as a bare statement
(`foo(x);`) is the "drop-all" form — every slot becomes a discard temp.

`[a] = foo(x);` where `foo` has 1 output is equivalent to
`a = foo(x);`. Asking for more outputs than the callee provides
(`[a, b] = single_output_foo(x);`) is rejected at lowering with a
span.

## Limitations

- Tensor-returning calls compose anywhere they appear in a statement-
  expression position (Assign RHS, disp/error/assert args, IndexStore
  RHS, etc.). The post-lowering ANF pass (`src/lowering/anf.ts`)
  hoists every owned-producing sub-expression — including
  user-function calls returning an owned kind — into its own
  `_mtoc_anf_<N> = <producer>;` synthetic Assign, registered in the
  enclosing `assignedVars`. After ANF, every call sits at a direct
  consume site (`mtoc_<kind>_assign(&lhs, foo(args))`), and the
  liveness pass + scope-exit free walks manage each temp's lifetime
  uniformly. `y = helper(helper(x))`, `y = bump(helper(x), 7)`,
  `s = sum(helper(x))`, `disp(helper(x))`, etc. all compile cleanly.
- Tensor-valued parameters are supported (real or complex; borrowed by
  value as `mtoc_tensor_t`). Tensor params can be reassigned in the body
  via copy-on-arg-pass.
- Workspace function files are supported. mtoc vendors numbl's
  `functionResolve.ts` + `loweringContext.ts` (see
  [architecture.md](architecture.md)) so cross-file `foo(...)` →
  `foo.m` resolution matches numbl exactly, including the "filename
  wins" rule (the first top-level function in a file is what
  `<basename>(...)` calls, regardless of the declared function name).
  Per-file specialization keys (the file-salted hash described above)
  prevent same-named helpers in different files from colliding.
  `+pkg/`, `@Cls/`, `private/`, and `import` are recognized by the
  vendored indexer but raise `UnsupportedConstruct` at the call site
  in v1 — the fence-posts make it easy to lift each restriction
  independently.
