# mtoc developer docs

Orientation material for people (and agents) extending mtoc. The codebase is in
flux — these docs deliberately avoid line numbers and try to talk in terms of
_concepts and roles_ so they stay accurate as files move around.

## Where to start

- [architecture.md](architecture.md) — the pipeline (parse → lower → emit),
  what each stage owns, what the IR looks like.
- [type_system.md](type_system.md) — `MType`, `NumericType`, sign tracking, how
  type inference flows through control flow and function specialization.
- [builtins.md](builtins.md) — the typed signature DSL for builtins, factory
  helpers, how a builtin participates in lowering and codegen.
- [runtime.md](runtime.md) — the C runtime helpers (`.h` snippets), dependency
  ordering, how scalars vs multi-element tensors are represented in C.
- [specialization.md](specialization.md) — how user-defined functions get
  specialized per call-site type tuple, and how the mangled C name is derived.
- [testing.md](testing.md) — the cross-runner harness, vitest layout, where new
  tests go.
- [extending.md](extending.md) — recipes for the most common extensions:
  adding a builtin, adding a runtime helper, adding an IR node, adding a test.
- [limitations.md](limitations.md) — known sharp edges and the rationale for
  current restrictions (kept here so users / agents don't waste cycles
  rediscovering them).
- [web.md](web.md) — the web IDE: routes, layout, persistence, sharing, and
  the build-time snippet inlining that lets the translator run in a browser.

## Project conventions

- The source dialect is **numbl**, not MATLAB. mtoc's lexer and parser are
  vendored from numbl, and the cross-runner uses numbl as its oracle. When you
  reference behavior or compatibility, talk about numbl.
- Every IR node carries a source `Span`. Errors should always include it, so
  user-facing messages can point to a line.
- Every refactor must keep the cross-runner at full pass before merging. `tsc
--noEmit` clean too.
- Generated C output is treated as observable. Changing it (whitespace,
  ordering, helper names) means updating snapshots/tests; cross-runner output
  must remain byte-identical to numbl for every script in `test_scripts/`.

## Skim order if you're new

1. `architecture.md` — get the shape of the pipeline.
2. `type_system.md` — most subtle subsystem; understanding sign propagation
   pays off everywhere.
3. `extending.md` — pick a recipe close to what you want to do.
4. `testing.md` — where your test goes.
