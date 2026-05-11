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
Add `--check-leaks` to build with `-fsanitize=address`; AddressSanitizer +
LeakSanitizer then flag any unfreed buffer at exit (with a stack trace) and
the process exits non-zero. Off by default because ASan adds ~2× runtime and
memory overhead; the cross-runner (`scripts/run_test_scripts.ts`) passes the
flag for every test so leaks fail CI.

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
- Numeric predicates: `isnan`, `isinf`, `isfinite`, `logical` (all
  scalar; return 0.0/1.0 to match numbl's logical-as-double convention)
- Runtime helpers: `sign`, `mod`, `sum` (vector), `length`, `numel`,
  `strcmp` (char-array, string, or any mix; scalar 0/1 result)
  (full registry: [`src/workspace/builtins.ts`](src/workspace/builtins.ts))
- Shape builtins: `size(t)` (row vector of dim sizes),
  `size(t, dim)`, `ndims(t)` (min-2 padded like numbl),
  `reshape(t, d1, d2, ..., dN)` — `reshape` is the path that
  produces tensors with `ndim > 2`; `disp`, `size`, `ndims`,
  `numel`, `length`, and another `reshape` are the operations
  currently supported on those N-D values. Arithmetic / indexing
  / slicing on `ndim > 2` are gated with a clear "not yet
  supported" diagnostic (the elementwise codegen loop is still
  2-D-shaped).
- Tensor constructors: `zeros(...)`, `ones(...)`, `eye(...)`,
  `nan(...)` / `NaN(...)`, `inf(...)` / `Inf(...)` — variadic
  shape API (`f()` returns the scalar fill, `f(N)` returns N×N,
  `f(d1, d2, ..., dN)` returns N-D). `eye` is 2-D-only.
- PRNG: `rand(...)`, `randn(...)`, `rng(seed)` — mtoc reproduces
  numbl's xoshiro128\*\* + splitmix32 byte-for-byte after
  `rng(seed)`. Without an explicit seed, mtoc defaults to seed 0
  (numbl falls back to `Math.random()`); outputs only match when
  both runtimes are seeded.
- Statement-only builtins: `disp`, `error("msg")`, `assert(cond)`,
  `assert(cond, msg)` (msg may be a string or char-array literal /
  variable; tensor-condition form is deferred)
- User-defined functions with 0, 1, or N≥2 outputs. Each output can
  be a scalar (real / complex) or an owned kind (real / complex
  double tensor, char tensor, scalar string). One specialization per
  unique call-site argument-type tuple. The C ABI is picked per
  output count: 0 → `void`, 1 → return-by-value (struct return for
  owned kinds), N≥2 → `void` with one `T *_mtoc_o<i>` out-pointer
  per output (owned slots use `mtoc_<kind>_assign` so the caller's
  prior buffer is consumed cleanly). Multi-output calls use the
  `[a, b] = foo(x);` syntax (with `~` to drop a slot — owned discard
  slots are freed right after the call so they don't leak); 0-output
  and N-output functions can also be invoked as bare statements
  `foo(x);`. Tensor / char / string params are owned by the callee
  under copy-on-arg-pass — the body can reassign them freely
- Function-file entry: a `.m` file with only function definitions
  (no top-level script statements) is translated by treating the
  first function's body as the script. The entry function must take
  zero parameters; the remaining functions register as ordinary
  locals callable from the entry. Matches numbl, which calls the
  first function with no args when the file has no script body
- Statically-sized tensor literals (`[1 2 3]`, `[1 2; 3 4]`), elementwise
  arithmetic on them, `sum`, `length`, `numel`
- Index reads:
  - **Scalar** on any multi-element tensor (real / complex / char):
    `v(i)`, `M(i, j)`, `T(i, j, k)`, `v(end)`, `M(end, end)`. Two
    arities: one linear index or one per axis. `end` resolves to the
    relevant axis size at the index site (numel for one-index;
    `base.dims[<slot>]` for per-axis).
  - **Range / colon** on a real-or-complex double tensor: single-slot
    linear forms (`v(a:b)`, `v(a:s:b)`, `v(2:end)`, `v(:)`, `M(:)`,
    `M(2:5)`) and multi-slot per-axis forms with arbitrary mix of
    scalar / range / colon slots (`M(:, j)`, `M(i, :)`, `M(:, :)`,
    `M(1:2, c:d)`, `T(:, j, :)`, `T(end, :, end)`). For the linear
    form, `Range` preserves orientation for vectors and produces a
    row for matrix indexing; `Colon` always linearizes to a column.
    For multi-slot, each slot becomes one result axis (colon keeps
    `base.dims[k]`, range becomes a runtime count, scalar collapses
    to 1), with trailing singletons stripped. The step must be a
    numeric literal.
- Indexed writes on real-or-complex double tensors:
  - **Scalar**: `v(i) = x`, `M(i, j) = x`, `T(i, j, k) = x`,
    `v(end) = x`. The base's heap buffer is mutated in place.
  - **Range / colon** (single-slot or multi-slot): `v(a:b) = w`,
    `v(:) = w`, `v(:) = scalar`, `M(:, j) = w`, `M(:, :) = scalar`,
    `T(:, j, :) = w`. The RHS must be a scalar (broadcast) or a named
    tensor variable (per-slot copy with a runtime count check that
    aborts on size mismatch). A TensorLit / IndexSlice / Binary RHS
    must be assigned to a name first.
  - Type rule: a real RHS into a complex base sets imag = 0 (numbl
    semantics); a complex RHS into a real base is rejected at
    lowering.
- Still deferred: char-tensor range reads, char-tensor writes.
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
  a fresh buffer. String arrays, string indexing, `sprintf`/`strcat`/
  `num2str`, and string + numeric coercion are deferred.
- Char (numbl `char`, single-quoted `'...'`): scalar chars (`'a'`),
  char arrays (`'hello'`), `disp`, `length`/`numel`, horzcat
  (`['ab' 'cd']`), arithmetic (`'a' + 1 == 98`, `'abc' + 1`), and
  comparisons (`'a' == 'a'`, `'abc' == 'abd'`). Scalar chars are bare
  C `char`; char arrays use `mtoc_char_tensor_t`. Char + string binary
  ops, 2D char matrices, and char indexing are deferred.

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

- **numbl corpus subset** (`scripts/run_numbl_tests.ts`): a curated list of
  numbl's own test scripts that mtoc can already run end-to-end. Paths are
  in [`numbl_tests.txt`](numbl_tests.txt), relative to
  `../numbl/numbl_test_scripts/`. Each script is run through mtoc and must
  print `SUCCESS` as its final stdout line (numbl tests use `assert` and
  print `SUCCESS` on the way out; a failed `assert` aborts before that
  line is reached). Most numbl tests don't pass yet — the list grows as
  mtoc's surface area does.

  ```bash
  npm run test:numbl                                   # all listed
  npx tsx scripts/run_numbl_tests.ts foo.m bar.m       # listed subset
  ```

When adding a feature, drop a `.m` file into the appropriate
`test_scripts/<category>/` subdirectory (the runner picks it up automatically)
and add focused vitest assertions for any new error paths or codegen shapes.
