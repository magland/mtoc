# mtoc

Static numbl-to-C translator. Reads a `.m` numbl source file, infers types, and
emits a self-contained C source file. Companion to [numbl] (the runtime
interpreter / JIT for the same dialect); mtoc targets a strict subset that can
be reasoned about statically.

[numbl]: ../numbl

## Quickstart

```bash
npx tsx src/cli.ts translate input.m output.c   # write the .c
npx tsx src/cli.ts run       input.m            # translate + compile + run
```

`run` translates to a temporary directory, compiles with `cc` (override via the
`CC` env var), and runs the resulting binary, streaming stdout/stderr through.

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
- User-defined scalar functions (single output), with one specialization per
  unique call-site argument-type tuple
- Statically-sized tensor literals (`[1 2 3]`, `[1 2; 3 4]`), elementwise
  arithmetic on them, `sum`, `length`, `numel`
- Scalar complex numbers: literals (`1i`, `2.5i`, `3+4i`), unary `+`/`-`,
  arithmetic (`+ - * /`), comparisons + logicals (numbl semantics:
  ordering on real part, equality on both parts, toBool for `&& ||`),
  and complex-aware scalar builtins — `sqrt`, `exp`, `log`, `log2`,
  `log10`, `expm1`, `log1p`, `sin`, `cos`, `tan`, `asin`, `acos`,
  `atan`, `sinh`, `cosh`, `tanh`, `abs`, `sign`, `min`, `max`,
  `real`, `imag`, `conj`, `angle`. `floor`/`ceil`/`round`/`fix` and
  `mod`/`rem` stay real-only by design (numbl semantics). `disp`
  formatting matches numbl byte-for-byte. Complex tensors are still
  in progress.

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
