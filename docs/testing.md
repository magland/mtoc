# Testing

Two layers, with strict separation of concerns:

## Cross-runner — `scripts/run_test_scripts.ts`

Every `.m` file under `test_scripts/` (any subdirectory) is run through both
numbl and mtoc, and the stdouts are compared **byte-for-byte**. This is the
primary safety net — most changes to lowering / codegen / runtime helpers
should fall under here.

```bash
npx tsx scripts/run_test_scripts.ts                  # all scripts
npx tsx scripts/run_test_scripts.ts <files…>         # specific files
MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
```

The runner uses `npx tsx ../numbl/src/cli.ts` as the oracle. Concurrency
defaults to `os.cpus().length`; the corpus typically finishes in single-digit
seconds.

The mtoc side of every comparison runs with `--check-leaks`, so the binary
is built with `-fsanitize=address`. AddressSanitizer + LeakSanitizer fail
the script (with the leak trace surfaced in the failure detail) if any
buffer is still live at exit. Tests therefore double as a memory-leak
invariant on every codegen path that produces output.

### Layout

`test_scripts/` is organized into category subdirectories. Adding a new test
is two steps: (1) drop a `.m` file in the right subdir, (2) confirm it passes.
The runner discovers files recursively at module-load time.

The naming convention: filenames must start with a letter (numbl's identifier
rule for `.m` files). `arith_basic.m`, `for_step.m`, `tensor_lit_disp.m`, etc.
— descriptive, no numeric prefixes.

### When a test diverges from numbl

- If numbl is right and we're wrong → the divergence is a bug in mtoc's
  lowering or codegen. Fix mtoc.
- If mtoc is right and numbl is wrong → file the bug upstream and either
  pin the script to a known-good behavior or remove it temporarily. There's
  precedent for catching numbl bugs this way (the original `formatNumber`
  scientific-exponent regex).
- If the divergence is a deliberate semantic difference → the script doesn't
  belong in the cross-runner. Consider an mtoc-only assertion in vitest.

## Vitest — `tests/translate-*.test.ts`

Unit tests for things the cross-runner can't observe directly:

- Specific assertions about emitted C (e.g., "the helper function is named
  `mtoc_disp_double`")
- Error attribution (e.g., "passing a negative literal to `sqrt` throws a
  `TypeError` whose message mentions `sign='negative'`")
- Type-system invariants

The vitest suite is split topically — each file targets one feature
area (basics, functions, tensors, strings, chars, complex, types,
codegen options, CLI). Shared scaffolding (the `translate(source)`
helper plus `cliPath` / `example1Path`) lives in
[`tests/_helpers.ts`](../tests/_helpers.ts); each test file imports
what it needs from there.

```bash
npx vitest run                                    # all
npx vitest run tests/translate-strings.test.ts    # one topic
```

When adding a test, drop it into the matching `translate-*.test.ts`;
new topic? Add `tests/translate-<topic>.test.ts` with a one-line
import from `_helpers.ts` and one or more `describe` blocks.

Avoid putting per-script comparison tests in vitest — the parallel
cross-runner already covers that and is much faster. Vitest is for
unit-level checks.

## numbl-corpus subset — `scripts/run_numbl_tests.ts`

A curated list of numbl's own tests that mtoc can already run end-to-end.
Distinct from the cross-runner: there is no byte-for-byte comparison —
each script just has to print `SUCCESS` as its final stdout line. (numbl's
test scripts are written in the "lots of `assert`s, then `disp('SUCCESS')`
at the end" style; a failed `assert` aborts before the SUCCESS line is
reached, so the check is a reliable smoke test.)

The list lives at [`numbl_tests.txt`](../numbl_tests.txt), with paths
relative to `../numbl/numbl_test_scripts/`. Most numbl tests do **not**
pass yet — the file grows as mtoc's surface area does. When a feature
lands that brings new numbl tests into the passing set, add them.

```bash
npm run test:numbl                                  # all listed
npx tsx scripts/run_numbl_tests.ts foo.m bar.m      # listed subset
MTOC_TEST_CONCURRENCY=4 npm run test:numbl
```

This runner is not part of the "definition of done" gate — it's a
forward-progress signal. The cross-runner over `test_scripts/` and the
vitest suite remain the binding regression checks.

### Probe mode

`--probe` ignores `numbl_tests.txt` and walks the entire numbl test
corpus, classifying each test's outcome:

- `PASS` — printed `SUCCESS` as the final stdout line.
- `UNSUPPORTED` — mtoc raised `UnsupportedConstruct` (expected: a
  feature mtoc hasn't grown into yet).
- `TYPE_ERROR` / `SYNTAX_ERROR` — mtoc rejected the program at
  lowering / parsing.
- `COMPILE_ERROR` — C was emitted but the C compiler rejected it.
- `RUNTIME_ERROR` — the compiled binary ran but exited non-zero
  (assertion abort, segfault, …).
- `NO_SUCCESS` — ran to completion but stdout didn't end with
  `SUCCESS` (semantic divergence from numbl).
- `TIMEOUT` — exceeded `MTOC_TEST_TIMEOUT_MS`.

The headline output is the "translated-but-broken" bucket
(`COMPILE_ERROR` / `RUNTIME_ERROR` / `NO_SUCCESS` / `TYPE_ERROR` /
`SYNTAX_ERROR`) — tests where mtoc produced C but the result diverged
from numbl. These are the actionable signal; `UNSUPPORTED` failures
are noise here by design.

```bash
npm run probe:numbl                                 # full corpus
npx tsx scripts/run_numbl_tests.ts --probe math/    # subtree filter
```

Probe mode always exits 0 — the breakdown is the result, not a
pass/fail verdict.

## Adding a new feature: the typical loop

1. Write a small `.m` test script under the relevant `test_scripts/<category>/`
   subdirectory exercising the feature. Run the cross-runner — confirm it
   fails for the right reason.
2. Implement the feature.
3. Cross-runner passes.
4. Add 1–2 vitest assertions for any new error paths or codegen shapes the
   cross-runner can't observe.
5. `npx tsc --noEmit` clean.

## Lint + format

Prettier and ESLint are also part of the dev loop:

```bash
npm run format        # prettier --write .
npm run format:check  # prettier --check .  (CI gate)
npm run lint          # eslint .            (CI gate)
```

The vendored `src/lexer/` and `src/parser/` are excluded from both prettier
and eslint via `.prettierignore` and `eslint.config.js`'s `globalIgnores` — do
not remove those entries, or vendoring will drift away from numbl byte-for-byte
(see `scripts/sync_from_numbl.ts`).

Husky wires this into git: `pre-commit` runs `lint-staged` (prettier + eslint
on staged files), `pre-push` runs `npm run typecheck && npm run lint`.

## CI / regression discipline

A change is "done" when:

- `npx tsc --noEmit` is clean.
- The cross-runner is at full pass.
- Vitest is at full pass.
- `npm run lint` and `npm run format:check` are both clean.

Don't merge a refactor that drops cross-runner pass count, even by one. A
divergent script either represents a real bug to fix or a script that should
move out of the cross-runner.

Note: the GitHub Actions workflow runs lint + format:check + typecheck +
vitest. The cross-runner is not in CI because it depends on `../numbl` being
available as a sibling directory; run it locally before pushing.
