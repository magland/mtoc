# Function specialization

mtoc emits one C function per unique call-site argument-type tuple. There are
no generic / templated C functions in the output — every user function is
monomorphized.

## The flow

1. Top-level `function ... end` definitions are pulled out of the script body
   during the first pass over the AST and registered in the workspace's
   local-function table. The remaining stmts form the script body.
2. When the lowerer encounters a call to a user function, it lowers the
   arguments, computes their full canonical types, and hashes the tuple into a
   short suffix (8 hex chars of FNV-1a 32-bit of the canonicalized type list).
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

## Limitations

- Single output per function. Multi-output (`[a, b] = f(x)`) is not yet
  supported — when added, the C path will likely use output pointers.
- Tensor-valued parameters are now supported (real or complex; borrowed by
  value as `mtoc_tensor_t`). Tensor params cannot be reassigned in the body
  — introduce a fresh local instead. Tensor-valued returns are still
  rejected at lowering; sret arrives in a later stage.
- Local functions only — function files (one function per `.m` file) and
  workspace-wide dispatch from numbl's `functionResolve.ts` aren't yet
  inherited beyond the local-function case.
