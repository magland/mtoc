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
npx tsx src/cli.ts translate input.m --dump-ir  # dump lowered IR as JSON
npx tsx src/cli.ts run       input.m            # translate + compile + run
```

### Web IDE

A browser-based IDE for editing numbl projects with live C-output preview:

```bash
npm install
npm run dev                # start the Vite dev server
npm run build && npm run preview   # production build smoke test
```

Editor on the left, generated C on the right (read-only Monaco), console
output below the editor. Projects and files persist to IndexedDB; share links
pack a whole project into the URL hash (pako-deflated, base64url).

To actually run the generated C, the IDE talks to a small local server (the
browser can't shell out to `cc`). Start it from a second terminal:

```bash
npm run serve -- --passkey <key>          # passkey shown in the IDE's settings dialog
# or directly:
npx tsx src/cli.ts serve --passkey <key> [--port 3002] [--host 127.0.0.1]
```

The IDE's Run button POSTs the project's `.m` source files (not the C) to
`POST /run`; the server runs the same translator the IDE uses, compiles the
result with `cc` (override via `CC`), runs the binary, and streams
stdout/stderr back as Server-Sent Events. Default bind is `127.0.0.1`.
Sending source rather than C means only mtoc-generated C ever reaches the
compiler. See [`docs/web.md`](docs/web.md) for protocol and architecture.

`run` translates to a temporary directory, compiles with `cc` (override via the
`CC` env var), and runs the resulting binary, streaming stdout/stderr through.

`--no-runtime` omits the inline runtime-helper bodies (`mtoc_format_double`,
`mtoc_disp_double`, the `mtoc_tensor_t` typedef, …) and the headers those
snippets pull in, leaving just the user code. Useful when embedding mtoc
output into a project that supplies its own runtime; the caller is then
responsible for providing `mtoc_*` symbols at link time. Headers needed by
the user code itself (`<math.h>` for for-loops, `<complex.h>` for complex)
stay.

`--dump-ir` skips C generation and prints the lowered IR as JSON instead.
Useful when debugging the lowering pass or inspecting how a numbl construct
becomes IR. `BuiltinSig` closures (in call targets) are stubbed as
`"<builtin: name>"` since functions aren't JSON-serializable.

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
- Strings (numbl `string`, scalar only): double-quoted literals
  (`"hello"`), concatenation via `+` (`"a" + "b" == "ab"`), `disp`,
  `error("msg")`, and the introspection builtins `length(s)` and
  `numel(s)` (both folded to `1` per numbl semantics). Stored as a
  small `mtoc_string_t` struct (data pointer + byte length + owned
  flag); literals point at `.rodata` while concat results allocate
  a fresh buffer. Char (single-quoted `'...'`), string arrays,
  string indexing, `sprintf`/`strcat`/`num2str`, and string + numeric
  coercion are deferred and rejected with a span.

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
