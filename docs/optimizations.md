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
