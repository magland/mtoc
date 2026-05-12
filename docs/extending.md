# Extension recipes

Common things you might want to do, and the steps for each. Most of these
touch only one or two files — the registries are designed so the common
extensions are local.

## Add a numbl-side scalar builtin that wraps libm

Example: `acosh(x)`.

1. Decide the type rule. `acosh` requires `x >= 1`, returns nonneg. We don't
   have a `>= 1` constraint today — we only have `nonnegative`/`positive` —
   so we'd accept any real for now and rely on libm for runtime correctness.
   When the constraint is expressible, add it.
2. Add an entry to the builtin registry using the `libm` factory:
   ```ts
   libm("acosh", 1, "acosh", "nonnegative", [null]);
   ```
3. Add a focused `.m` test under `test_scripts/builtins/acosh.m`.
4. Run the cross-runner. Done.

## Add a numbl-side scalar builtin backed by a new runtime helper

Example: a hypothetical `mtoc_relu(x)` that returns `max(x, 0)`.

1. Drop `src/codegen/runtime/relu.h`:
   ```c
   /* Rectified linear unit. */
   static double mtoc_relu(double x) {
     return x > 0.0 ? x : 0.0;
   }
   ```
2. Register it in the runtime helper registry. No deps.
3. Add a builtin entry using the `runtime` factory:
   ```ts
   runtime("relu", 1, "mtoc_relu", "nonnegative", [null]);
   ```
4. Test script + cross-runner.

If your helper depends on another (uses `mtoc_format_double`, etc.), declare
the dependency in the registry entry — the loader handles ordering.

## Add a new IR statement variant

Example: a hypothetical `IRStmt.Switch`.

1. Add the discriminant to the `IRStmt` union in `src/lowering/ir.ts` with
   the fields it needs (`scrutinee`, `arms`, `default`, `span`).
2. Lower the construct: pull the case-handling logic out into a
   `lowerSwitch.ts` helper that mirrors the existing `lowerIf.ts` style
   (snapshot env per arm, merge envs at exit via `mergeBranchEnvs`).
3. Codegen: add a `case "Switch":` to `emitStmt`. Emit a C `switch` /
   `if-else` chain depending on what fits.
4. Update `analyzeStmt` so any contained expressions get their helper
   activations and `<math.h>` flag.
5. Add to `validateIR` if the variant has any structural invariants codegen
   relies on (e.g. arm bodies must be non-empty).
6. Cross-runner test scripts under `test_scripts/control_flow/`.

When in doubt, copy the closest existing variant's structure.

## Add a new IR expression variant

Example: a hypothetical `IRExpr.IndexLoad` for `v(i)`.

1. Add the variant to `IRExpr` in `src/lowering/ir.ts`.
2. Lower the parser-level construct (`Expr.Index`) in a helper file. Compute
   the result type from the base's type and the index expression's type.
3. Codegen: add a `case "IndexLoad":` to `emitExpr`. If the result is a
   scalar read from a tensor, emit `<base>.data[<col_major_index>]`. If it
   produces a tensor (slice), this is bigger work — likely needs a new
   `IRStmt` variant for the slice copy.
4. Update `analyzeExpr` if the variant has codegen activations.
5. Tests under `test_scripts/<category>/`.

## Add a new MType kind (cell, struct, class, …)

Adding a value kind alongside `Numeric` / `String` is a foundation
change with predictable plug-in points. The pieces:

1. Add the variant to the `MType` union in `src/lowering/types.ts`.
2. Add an arm to `storageCategory` in the same file (returns the new
   category's string ID). `canShareStorage` and `absentDefaultFor`
   pick the new category up automatically; lowering's
   `recordAssignment` and `mergeBranchEnvs` won't need touching.
3. Add an entry to `ownedKinds.ts` (`ownedOps`) so the new kind's
   `mtoc_<kind>_assign` / `_free` / `_copy` / `disp` helpers route
   correctly. `emitDeclarations` / `emitScopeExitFrees` /
   `functionFreeOnExitSet` then handle the lifetime walks without
   per-kind code.
4. Add a `disp` arm to `dispKinds.ts` (`dispEmitterFor`). The
   `Disp` IRStmt arm in `emitStmt` is one lookup — no edit needed.
5. Extend `cTypeFor` in `types.ts` so codegen knows the C type to
   declare.
6. If the new kind has a per-shape typedef (one C type per distinct
   instance, like struct's `_mtoc_struct__<hash>`), generate those
   typedefs + their owned-kind helpers from codegen rather than
   pre-writing them as `.h` files. `src/codegen/emitStruct.ts` is the
   reference: walk the program, collect every distinct shape (keyed
   by the kind's mangled name), topologically sort by nesting, and
   render typedef + `<typedef>_empty` / `_free` / `_copy` / `_assign` /
   `_disp` blocks ahead of the user-function bodies. `useRuntimeByName`
   has prefix-based short-circuits so generated-helper names skip
   runtime-registry activation. If, instead, the new kind has a
   single fixed C representation (like `mtoc_string_t`), drop the
   `.h` file under `src/codegen/runtime/` and register it in the
   runtime helpers map.
7. Lower a parser-side producer (`{a,b,c}` cell literal, `s.field`
   member access, …) to a new IR node or extend an existing one.
8. If the kind has VARIABLE per-instance typedefs (struct's case),
   add a post-lowering normalization pass that rewrites every IR
   node's `.ty` to use the FINAL widened type from `assignedVars`.
   Without this pass, intermediate widening states leak into the IR
   and the codegen emits multiple typedefs for the same logical
   variable. `src/lowering/normalizeStructTypes.ts` is the reference.

The intent is that touching the per-kind registries is enough — the
walkers, validators, and pass machinery should not learn the new
kind's name.

## Add a constant

Trivial: extend the constants table in `src/workspace/constants.ts` with the
numbl name, value, and sign. Constants resolve at lowering time as
`IRExpr.NumLit` — no IR or codegen change needed.

## Add a new C runtime helper not tied to a builtin

Sometimes you want a runtime helper used directly by codegen (e.g. for the
tensor disp path, or a future arena allocator). Steps:

1. Drop the `.h` file under `src/codegen/runtime/`.
2. Register it in the runtime helpers map.
3. Activate it in codegen via `useRuntimeByName` at the relevant call site.
4. Tests via cross-runner scripts that exercise the path that triggers
   activation.

## Tighten an existing error message

The lowerer raises `UnsupportedConstruct(message, span)` and `TypeError(message,
span)`. To improve a message:

1. Find the throw site (often in a per-construct lowering helper).
2. Update the message — include the actual offending types via
   `typeToString`, and any actionable hint (`use abs(x)`, `assign to a name
first`).
3. Update any vitest assertions that match the previous wording. Match on
   _intent_ via regex, not the exact string.

## Remove a restriction (turn an UnsupportedConstruct into a feature)

The general pattern:

1. Find the throw site. Often the message hints at what's missing
   (e.g. "auto-materialization of tensor temporaries is on the roadmap").
2. Decide the data shape needed in the IR. If the existing IR supports it,
   replace the throw with construction. If not, introduce a new IR variant
   first (recipe above).
3. Codegen for the new path.
4. Cross-runner script demonstrating the new feature.
5. Vitest assertions for any error paths the codegen still has (e.g. the
   feature is supported up to some shape but not beyond).

## Don't

- Don't bypass the cross-runner. If your feature emits new C, add a `.m`
  script that exercises it and confirms numbl agrees with the result.
- Don't put `Unsupported`-style errors at the codegen layer. Catch them at
  lowering with a span. The post-lowering `validateIR` pass exists to
  enforce structural invariants that codegen relies on; if you find
  yourself adding a runtime check in codegen, ask whether it should be a
  `validateIR` clause instead.
- Don't introduce names with the `_mtoc_` prefix in lowering output. That
  prefix is reserved for codegen synthetic names.
- Don't grow `lower.ts` itself with per-construct logic. Make a sibling
  `lowerFoo.ts` and dispatch to it from the existing `lowerStmt`/`lowerExpr`
  switch.
