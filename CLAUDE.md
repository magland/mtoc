# CLAUDE.md

Project instructions for agents working in mtoc.

## Project anchor

**numbl** is a runtime interpreter / JIT for a MATLAB-style language. It
defines the dialect mtoc accepts. Two roles:

- **Implementation**: mtoc's lexer and parser are vendored verbatim from
  numbl. The AST shape mtoc consumes is numbl's AST shape.
- **Testing**: numbl's CLI is the cross-runner oracle. Every `.m` script in
  `test_scripts/` is run through both numbl and mtoc, and the stdouts must
  match byte-for-byte.

During development numbl lives at `../numbl` (sibling directory) and is
available to read as a reference. When a question comes up about how the
dialect should behave, the answer is "what numbl does" — go read the relevant
file in `../numbl/src/numbl-core/`.

mtoc is a *static* translator and intentionally accepts a strict subset of
what numbl can run — anything outside that subset raises `UnsupportedConstruct`
with a source span.

## Docs are part of the change

Every change should keep `README.md` and `docs/` accurate. If you:

- Add a builtin → mention it in `README.md`'s capability list and (if the
  pattern is new) update `docs/builtins.md` or `docs/extending.md`.
- Add or tighten a `UnsupportedConstruct` / `TypeError` site → if it's
  user-visible, refresh `docs/limitations.md` (or remove an entry there if
  the limitation is gone).
- Change the IR / pipeline / runtime helper system → reflect it in
  `docs/architecture.md` / `docs/runtime.md` / `docs/specialization.md`.
- Change the test layout → update `docs/testing.md` and the README's "Tests"
  section.

When in doubt, skim `docs/README.md` for the right home and add a one-liner
rather than letting the docs drift. Avoid hard-coding line numbers — refer to
subsystems and file *roles* so the docs survive routine refactors.

## Test discipline

A change is "done" when:

- `npx tsc --noEmit` is clean.
- `npx tsx scripts/run_test_scripts.ts` is at full pass.
- `npx vitest run` is at full pass.

Two layers, strict separation:

- **Cross-runner** (`scripts/run_test_scripts.ts`) compares mtoc and numbl
  byte-for-byte over every `.m` in `test_scripts/<category>/`. New end-to-end
  tests go here as `.m` files (auto-discovered). Don't add per-script entries
  to vitest — the parallel runner covers that and is much faster.
- **Vitest** (`tests/translate.test.ts`) is for unit-level assertions:
  emitted-C shapes, error attribution, type-system invariants.

If a divergence between mtoc and numbl is a real numbl bug, file it upstream;
don't paper over it in mtoc.

## Naming

- Synthetic identifiers in generated C use the `_mtoc_` prefix (reserved).
  numbl syntax forbids leading underscores in identifiers; the lowerer also
  defensively rejects user names with that prefix.
- Specialization mangling: `<funcName>__<8-hex>` where the hex is a SHA-256
  prefix of the canonicalized argument-type tuple.

## Error attribution

Every IR node carries a `Span`. User-facing errors should always include it.
Codegen-time errors should be rare and labeled "internal: should have been
caught at lowering" — when you find one that fires from a real program, hoist
the check into lowering with a span.
