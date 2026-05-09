# mtoc

Static numbl-to-C translator. Reads a `.m` numbl source file, infers types, and
emits a self-contained C source file. Companion to [numbl] (the runtime
interpreter / JIT for the same dialect); mtoc targets a strict subset that can
be reasoned about statically.

[numbl]: ../numbl

## Quickstart

```bash
npx tsx src/cli.ts translate input.m output.c   # write the .c
npx tsx src/cli.ts translate input.m            # write to stdout
npx tsx src/cli.ts translate input.m --no-runtime  # skip runtime helpers
npx tsx src/cli.ts run       input.m            # translate + compile + run
```

`run` translates to a temporary directory, compiles with `cc` (override via the
`CC` env var), and runs the resulting binary, streaming stdout/stderr through.

`--no-runtime` omits the inline runtime-helper bodies (`mtoc_format_double`,
`mtoc_disp_double`, the `mtoc_tensor_t` typedef, …) and the headers those
snippets pull in, leaving just the user code. Useful when embedding mtoc
output into a project that supplies its own runtime; the caller is then
responsible for providing `mtoc_*` symbols at link time. Headers needed by
the user code itself (`<math.h>` for for-loops, `<complex.h>` for complex)
stay.

## What works today

The subset is growing iteratively. Roughly:

- Scalars: arithmetic, comparisons, logicals, unary `+ - !`
- Constants: `pi`, `eps`, `Inf`, `NaN`, `realmax`, `realmin`, `true`, `false`
- Control flow: `if` / `elseif` / `else`, `while`, `for k = a:b` (and `a:s:b`),
  `break`, `continue`, `return`
- Math builtins (libm-mapped): `abs`, `sqrt`, `exp`, `log`, `log2`, `log10`,
  `expm1`, `log1p`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`,
  `cosh`, `tanh`, `floor`, `ceil`, `round`, `fix`, `rem`, `min`, `max`,
  `atan2`, `hypot`, `power`
- Runtime helpers: `sign`, `mod`, `sum` (vector), `length`, `numel`
  (full registry: [`src/workspace/builtins.ts`](src/workspace/builtins.ts))
- User-defined functions (single output, scalar input or tensor input,
  scalar return for now), with one specialization per unique call-site
  argument-type tuple. Tensor params are borrowed by value — the body
  cannot reassign one (introduce a fresh local instead)
- Statically-sized tensor literals (`[1 2 3]`, `[1 2; 3 4]`), elementwise
  arithmetic on them, `sum`, `length`, `numel`
- Complex numbers (scalar and tensor): literals (`1i`, `2.5i`,
  `3+4i`, `[1+2i, 3+4i]`), unary `+`/`-`, arithmetic (`+ - * /`),
  comparisons + logicals (numbl semantics: ordering on real part,
  equality on both parts, toBool for `&& ||`), elementwise tensor
  arithmetic with broadcast, `disp` formatting matching numbl
  byte-for-byte (scalar + tensor), and complex-aware builtins —
  `sqrt`, `exp`, `log`, `log2`, `log10`, `expm1`, `log1p`, `sin`,
  `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`, `cosh`, `tanh`,
  `abs`, `sign`, `min`, `max`, `real`, `imag`, `conj`, `angle`,
  `sum` (vector reduction). `length`/`numel` accept any tensor.
  `floor`/`ceil`/`round`/`fix`, `mod`/`rem`, and `^` stay real-only
  for now (numbl-semantics or pending implementation work).

Anything outside the supported subset raises `UnsupportedConstruct` with a
source span pointing to the offending line.

For a developer-oriented map of the codebase — pipeline, type system,
runtime, extension recipes — see [`docs/`](docs/).

## Tests

Two tracks:

- **Cross-runner**: every `.m` under `test_scripts/` is run through both numbl
  and mtoc, and stdouts are compared byte-for-byte. The parallel runner
  (`scripts/run_test_scripts.ts`) finishes the corpus in a few seconds.

  ```bash
  npx tsx scripts/run_test_scripts.ts                 # all scripts
  npx tsx scripts/run_test_scripts.ts foo.m bar.m     # specific files
  MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
  ```

- **Unit tests** (`vitest`): assertions about emitted C, error attribution,
  type-system invariants. Run with `npx vitest run`.

When adding a feature, drop a `.m` file into the appropriate
`test_scripts/<category>/` subdirectory (the runner picks it up automatically)
and add focused vitest assertions for any new error paths or codegen shapes.
