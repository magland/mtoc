# Codegen optimizations

mtoc ships a small set of optional codegen peepholes that reshape the
emitted C without changing observable behavior. Each lives in its own
file under `src/codegen/opt/` and is wired into the emitter through
narrow, guarded hook sites — deleting an optimization's file and
removing its hook returns the codegen to its pre-optimization shape.

## Design contract

Every optimization is expected to:

1. **Live in one file under `src/codegen/opt/`.** No infrastructure
   layer, no pass manager. Each file exports a plan-builder function
   and a plan type; the emitter consults the plan at a small number of
   places guarded against `null`.
2. **Be a pure function from the IR.** Plan-building takes the
   pre-emission IR (plus liveness, where useful) and returns a value-
   typed read-only plan. No IR mutation, no global state.
3. **Be defeatable at the `EmitOptions` level.** A
   `disableOptimizations: true` knob threads through `emit.ts` and
   `emitFunction.ts` so every per-scope plan-build site can substitute
   an empty plan. Tests that need to pin pre-optimization output use
   the knob.
4. **Preserve the IR-render comment trail.** A statement that is
   elided by the optimization still emits its `/* x = ... */` source-
   line comment so the reader of the generated C can follow each
   numbl statement.
5. **Carry its own tests.** A vitest file under `tests/translate-<...>.test.ts`
   exercises positive cases (the rewrite fires; loop count drops) and
   negative cases (preconditions correctly decline fusion). One or
   more `.m` files in `test_scripts/` cover the cross-runner so the
   rewrite is independently checked against numbl byte-for-byte.

The defining property of the framework is that there is _no
framework_. Optimizations compose by stacking files under
`src/codegen/opt/`; nothing in the rest of the codebase changes.

## Active optimizations

### Same-shape elementwise fusion (`fuseSameShape.ts`)

Collapses back-to-back same-shape elementwise `Assign`s into a single
fused loop whenever the first statement's result is consumed exactly
once by the next.

For example, the source

```matlab
b = a + 1;
c = b * 2;
```

emits two allocations and two loops by default. With fusion, the
producer's loop is elided and its right-hand side is spliced into the
consumer's loop body — one allocation, one loop:

```c
/* b = a + 1 */                        // producer comment kept
/* c = b * 2 */
{
  mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(a.dims[0], a.dims[1]);
  long _mtoc_n = _mtoc_t.dims[0] * _mtoc_t.dims[1];
  for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {
    _mtoc_t.real[_mtoc_i] = (a.real[_mtoc_i] + 1.0) * 2.0;
  }
  mtoc_tensor_assign(&c, _mtoc_t);
}
```

Chains compose: with `b → d → e` each consumed-once, all three steps
collapse into a single loop body via the chain-fusion path.

**Preconditions (all must hold).** Each is checked by the plan
builder; failing any one declines fusion for that producer/consumer
pair.

- Both producer and consumer are `Assign`s to a multi-element real-
  double tensor going through the `emitTensorAssignFromExpr`
  elementwise-loop path.
- Both use the flat-iter (no implicit-broadcast) path — every multi-
  element operand on each side has the same static shape.
- The producer's static result shape equals the consumer's.
- The producer is the immediately preceding statement (no
  intervening control flow, no other stmts between them).
- The producer's LHS C-name has exactly one use, at this consumer
  (i.e. dead-after the consumer under the unfused liveness).
- The producer's cName does not appear in the consumer's RHS in any
  non-substitutable position (e.g. as an `IndexLoad.base`).

**Out of scope for this peephole (separate peepholes when warranted):**

- Broadcast producers/consumers (different operand shapes). The
  broadcast emitter has its own index math; fusing across the two
  layouts needs a richer substituter.
- Complex-valued producers/consumers. The complex path uses
  `creal`/`cimag` splits inside the loop; safely substituting through
  those needs care.
- Slice / transpose producers. The shape of a slice/transpose differs
  from its source, so the substituter must rewrite index expressions
  rather than passing the iter through.
- Producers across control-flow boundaries.

**Hook sites (delete these and the file to revert):**

- `src/codegen/emit.ts` / `src/codegen/emitFunction.ts` — build the
  plan after liveness, stash it on `EmitState.fusionPlan`.
- `src/codegen/emitStmt.ts` — early-return on `plan.skipProducers`;
  use `plan.consumerRhs` for the elementwise emit when present.
- `src/codegen/emitAnalysis.ts::deadAfterStmt` — walk the rewritten
  RHS for post-fusion liveness when the consumer is in the plan.

**Disabling.** Pass `disableOptimizations: true` to `emitC` /
`translate()`. The plan-builder is bypassed; emission falls back to
the pre-fusion shape.

### Column/row-slice inlining (`inlineColumnSlice.ts`)

Recognizes producers of the form `_anf = base(:, k)` (column slice)
or `_anf = base(k, :)` (row slice) whose result is consumed exactly
once by a downstream elementwise `Assign`, and rewrites the read of
the slice's value at the consumer's loop body to read directly from
`base`'s buffer at the right column-major offset — skipping the
slice's allocation and copy loop entirely.

For example, the source

```matlab
function r = f(m)
  col = m(:, 1);
  row = m(1, :);
  r = col + row;
end
```

emits a slice alloc + copy loop per `col` and `row` plus a broadcast
loop for `r` by default. With slice inlining the per-slice
allocations and copy loops disappear; the broadcast loop reads
`m.real[k0 + (k-1) * m.dims[0]]` for `col` and `m.real[(k-1) + k1 *
m.dims[0]]` for `row` directly.

**Preconditions (all must hold).**

- Producer is `Assign(prodCName, IndexSlice)` whose `.index` is
  exactly `[Colon, Scalar]` (column slice) or `[Scalar, Colon]`
  (row slice).
- The slice's base is a 2-D multi-element real-double `Var`.
- The fixed-axis `Scalar` is a `NumLit`, scalar `Var`, or `EndRef`
  — all pure, side-effect-free, safe to evaluate once into a
  per-consumer local.
- The producer's cName has exactly one use in the body: at a
  downstream elementwise consumer (flat-iter or broadcast).
- The cName appears in the consumer's RHS only in iter-slot
  positions (not as an `IndexLoad.base` / `IndexSlice.base` etc.).
- Between producer and consumer, no statement mutates the
  producer's base or LHS; only same-body fusion is allowed.

**Hook sites (delete these and the file to revert):**

- `src/codegen/emit.ts` / `src/codegen/emitFunction.ts` — build the
  plan after liveness; stash on `EmitState.columnSlicePlan`.
- `src/codegen/emitStmt.ts` — early-return on
  `plan.skipProducers`; pass `plan.consumerInlines.get(s)` down to
  `emitTensorAssignFromExpr`.
- `src/codegen/emitTensor.ts` — `operandAxisSize` resolves inlined
  slice dims from the base; per-operand index precompute skipped
  for inlined slices; `_mtoc_inline_<...>_fixed` locals hoisted
  before the loop; iter frame carries the inline info + `loopVars`.
- `src/codegen/emitExpr.ts` — `Var`-read substitution at the
  iter-frame inline-map lookup.
- `src/codegen/emitAnalysis.ts::deadAfterStmt` — augment the
  consumer's owned-use set with each inlined slice's base so the
  base is freed at the right point on the linear path.

**Out of scope (deferred):**

- Complex / char-tensor / N-D bases.
- Slices into N-D bases (the row/col stride math generalizes but
  needs an N-D-aware substitution).
- Composition with same-shape fusion when the chain crosses
  shapes (e.g. slice → flat-iter → broadcast).

### Transpose inlining (`inlineTranspose.ts`)

Recognizes producers of the form `_anf = base.'` (a direct
`mtoc_tensor_transpose` / `_complex` `Call` whose single argument is
a `Var`) whose result is consumed exactly once by a downstream
BROADCAST elementwise `Assign`, and rewrites the read of the
transpose at the consumer's loop body to read directly from the
base with axes swapped — skipping the transpose's allocation and
copy loop entirely.

For example,

```matlab
function r = f(col)
  t = col.';
  r = col + t;
end
```

emits a `mtoc_tensor_transpose(col)` alloc + loop plus the broadcast
loop for `r` by default. With transpose inlining the transpose loop
disappears; the broadcast loop reads `col.real[k1]` directly for
each `(k0, k1)` of the output.

**Index math.** For a 2-D transpose `t = base.'`, output element
`(t0, t1)` corresponds to base element `(t1, t0)`. In column-major,
the base offset is `t1 + t0 * base.dims[0]`. Each `tI` derives from
the transpose's static dim lattice exactly the way the broadcast
emitter would compute it: `one` contributes 0, `notOne` uses
`loopVars[i]`, `unknown` guards on a runtime axis-1 check. Common
cases simplify to either `base.real[k1]` (column → row transpose)
or `base.real[k0 * base.dims[0]]` (row → column transpose).

**Preconditions (all must hold).**

- Producer is `Assign(prodCName, Call(builtin "transpose", [Var]))`
  with the base a 2-D multi-element real-double `Var`.
- Consumer is a broadcast elementwise `Assign` — i.e. at least two
  multi-element operands of differing static shape. Flat-iter
  consumers would need div/mod inside the loop body to deconstruct
  the iter into (k0, k1) coords; deferred.
- The producer's cName has exactly one use, at this consumer.
- Only iter-slot positions (no `IndexLoad.base` etc.).
- No intervening writes to the base or to the producer's cName.
- Same body, no cross-CF.

**Hook sites:**

- `emit.ts` / `emitFunction.ts` — build the plan after liveness;
  stash on `EmitState.transposePlan`.
- `emitStmt.ts` — early-return on `plan.skipProducers`; pass
  `plan.consumerInlines.get(s)` down to `emitTensorAssignFromExpr`.
- `emitTensor.ts` — `operandAxisSize` swaps the base's dims for
  inlined transposes; per-operand index precompute is skipped; iter
  frame carries the inline info.
- `emitExpr.ts` — Var-read substitution via `inlinedTransposeRead`.
- `emitAnalysis.ts::deadAfterStmt` — augment the consumer's owned-
  use set with each inlined transpose's base.

**Composition note.** This peephole pairs naturally with column-
slice inlining when a slice's consumer is a transpose whose consumer
is a broadcast. Today, the slice in `slice → transpose → broadcast`
still materializes — the slice's direct consumer (the transpose)
isn't an elementwise Assign, so `inlineColumnSlice.ts` declines.
Closing that last gap is a follow-up "chained slice+transpose"
peephole.

**Out of scope (deferred):**

- Complex transposes (the `mtoc_tensor_transpose_complex` path).
- Flat-iter consumers.
- Transposes of N-D tensors (`> 2-D` is rejected at lowering today).
- Conjugate transpose `'` (also rejected at lowering today).

## Adding an optimization

1. Drop a new file under `src/codegen/opt/<name>.ts`. Export:
   - a plan type (`<Name>Plan`),
   - an `EMPTY_<NAME>_PLAN` value,
   - a `build<Name>Plan(...)` function that builds the plan from IR
     and any inputs it needs.
2. Add a field to `EmitState` carrying the plan (or extend the
   existing one).
3. Wire the build call into `emit.ts` and `emitFunction.ts` after
   their respective `computeFutureTouches` calls. Honor
   `state.disableOptimizations` by installing the empty plan.
4. Add hook points at the emitter sites that need to consult the
   plan. Guard every site against the null plan so removing the
   optimization is a one-file delete.
5. Write a `tests/translate-<name>.test.ts` covering positive and
   negative cases.
6. Drop one or more `.m` files in `test_scripts/<category>/`. The
   parallel runner picks them up automatically; cross-runner parity
   against numbl is the final check.
7. Update this file's "Active optimizations" section.
