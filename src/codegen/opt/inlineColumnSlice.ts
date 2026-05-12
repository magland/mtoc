/**
 * Column- and row-slice inlining plan.
 *
 * Recognizes `Assign` producers of the shape `_anf = base(:, k)` or
 * `_anf = base(k, :)` whose result is consumed exactly once by a
 * downstream elementwise `Assign`, and rewrites the read of the
 * slice's value at the consumer's loop body to read directly from
 * `base`'s buffer at the right offset — skipping the slice's own
 * allocation and copy loop entirely.
 *
 * Concretely, the source pattern
 *
 *     anf = targ(:, 1);
 *     rx  = anf + 1;
 *
 * normally allocates a fresh column tensor for `anf`, runs a loop
 * over `targ`'s rows to copy into it, then runs the elementwise loop
 * to produce `rx`. With inlining, `anf`'s allocation and copy loop
 * are elided and the consumer's loop body reads `targ.real[<iter> +
 * 0L * targ.dims[0]]` directly — no intermediate buffer.
 *
 * The peephole composes cleanly with the broadcast emitter: an
 * inlined column-slice operand of static shape `[N, 1]` keeps its
 * static dim lattice (the slice's MType is unchanged), so axis-0 is
 * still `notOne` and axis-1 is still `one` — the broadcast emitter's
 * per-axis index math handles it the same as a materialized
 * `[N, 1]` operand. The two emit-time overrides are:
 *
 *   1. `operandAxisSize(<slice>, i)` reads from the BASE struct
 *      (`<base>.dims[0]` for the ranging axis, `1L` for the fixed
 *      axis) since the slice handle is never populated.
 *   2. The per-operand index precomputation for the slice is skipped
 *      (we never emit `<slice>.real[<idx>]` — see #3); the slice's
 *      logical iter offset rides directly off the broadcast frame's
 *      loop variables.
 *   3. At the Var-read site in `emitExpr`, a `<slice>.real[<idx>]`
 *      is rewritten to `<base>.real[<idx-with-fixed-axis-offset>]`.
 *
 * # Modularity contract (see docs/optimizations.md)
 *
 * - The plan-builder is a pure function from `(stmts, futureTouches)`
 *   to a `ColumnSlicePlan` value. No IR mutation, no global state.
 * - Three null-guarded hook sites: `emitStmt.ts` (skip producers and
 *   pass the consumer inline map down), `emitTensor.ts` (use the
 *   inline map for axis-size resolution + skip per-operand precompute
 *   for inlined slices + push the inline info onto the iter frame),
 *   and `emitExpr.ts` (substitute the Var read).
 * - `EmitOptions.disableOptimizations` bypasses the plan-builder.
 *
 * # Scope of this MVP
 *
 * Fires only when:
 *   - Producer is `Assign(prodCName, IndexSlice)` whose IndexSlice
 *     is either `(:, scalar)` (column slice) or `(scalar, :)`
 *     (row slice).
 *   - The base of the IndexSlice is a 2-D multi-element real-double
 *     `Var` (complex / char / N-D deferred).
 *   - The fixed-axis Scalar index is a `NumLit`, scalar `Var`, or
 *     `EndRef` — all pure, side-effect-free, safe to evaluate once
 *     into a per-consumer local.
 *   - The producer's cName has exactly one use in the body: at a
 *     downstream consumer that is itself a fusion-eligible
 *     elementwise `Assign` (flat-iter or broadcast).
 *   - The cName appears in the consumer's RHS only in iter-slot
 *     positions (not as an `IndexLoad.base` etc., which the
 *     substitution doesn't reach).
 *   - Between producer and consumer, no statement mutates the
 *     producer's base or LHS; only same-body fusion is allowed.
 *
 * Out of scope (deferred):
 *   - Complex / char-tensor / N-D bases.
 *   - Row/column slices into N-D bases (the index math generalizes
 *     but needs a row/col stride lookup).
 *   - Fusing through user-function calls.
 */

import type { IRExpr, IRStmt } from "../../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  isOwned,
  isScalar,
} from "../../lowering/types.js";
import { forEachSubExpr, forEachTopLevelExpr } from "../../lowering/walk.js";
import type { FutureTouchMap } from "../liveness.js";

export interface ColumnSliceInline {
  /** 2-D base tensor whose buffer the consumer will read directly. */
  baseVar: Extract<IRExpr, { kind: "Var" }>;
  /** Axis that ranges over the slice (the other axis is fixed).
   *   - axis === 0: column slice `base(:, k)` — slot i corresponds to
   *     base row i, fixed column (k-1).
   *   - axis === 1: row slice `base(k, :)` — slot j corresponds to
   *     fixed row (k-1), column j.
   *  This matches the producer's IndexSlice `.index` slot positions:
   *  a `Colon` at axis k means the slice ranges over that axis. */
  axis: 0 | 1;
  /** MATLAB 1-based fixed-axis index, as an IRExpr that the emitter
   *  renders once per consumer into a `long _mtoc_inline_<...>_fixed
   *  = (long)(<expr>) - 1L;` local, then reuses inside the loop
   *  body. Restricted to pure scalar exprs (NumLit / scalar Var /
   *  EndRef) so the single hoisted evaluation is sound. */
  fixedIndex: IRExpr;
}

export interface ColumnSlicePlan {
  /** Producer `Assign`s (IndexSlice RHS) whose emission is skipped.
   *  The producer's source-line comment still emits at its position
   *  so the C reader can trace each numbl statement. */
  skipProducers: ReadonlySet<IRStmt>;
  /** Per consumer `Assign`, the map `{slice-cName → inline info}`.
   *  Consults at three points in the codegen: axis-size resolution,
   *  per-operand index precompute (skipped), and Var-read
   *  substitution. */
  consumerInlines: ReadonlyMap<IRStmt, ReadonlyMap<string, ColumnSliceInline>>;
}

export const EMPTY_COLUMN_SLICE_PLAN: ColumnSlicePlan = {
  skipProducers: new Set(),
  consumerInlines: new Map(),
};

/** Classify a producer `Assign` as an inlinable column/row slice, or
 *  return null when it doesn't fit the MVP pattern. */
function classifySliceProducer(s: IRStmt): ColumnSliceInline | null {
  if (s.kind !== "Assign") return null;
  if (s.rhs.kind !== "IndexSlice") return null;
  const slice = s.rhs;
  const base = slice.base;
  if (!isNumeric(base.ty)) return null;
  if (base.ty.elem !== "double") return null;
  if (base.ty.isComplex) return null;
  if (!isMultiElement(base.ty)) return null;
  if (base.ty.dims.length !== 2) return null;
  // Exactly 2 index slots, one Colon + one Scalar.
  if (slice.index.length !== 2) return null;
  const a = slice.index[0];
  const b = slice.index[1];
  if (a.kind === "Colon" && b.kind === "Scalar") {
    if (!isInlinableIndexExpr(b.expr)) return null;
    return { baseVar: base, axis: 0, fixedIndex: b.expr };
  }
  if (a.kind === "Scalar" && b.kind === "Colon") {
    if (!isInlinableIndexExpr(a.expr)) return null;
    return { baseVar: base, axis: 1, fixedIndex: a.expr };
  }
  return null;
}

/** True for scalar IRExprs we can safely evaluate once into a local
 *  before the consumer's loop and reuse inside the body. NumLit /
 *  scalar Var / EndRef are all observably pure (no side effects, no
 *  user-function calls, no dependence on loop-local state). */
function isInlinableIndexExpr(e: IRExpr): boolean {
  if (e.kind === "NumLit") return true;
  if (e.kind === "Var" && isScalar(e.ty)) return true;
  if (e.kind === "EndRef") return true;
  return false;
}

/** Predicate: `s` is an `Assign` that goes through the elementwise-
 *  loop emission path (flat-iter or broadcast), and so is a valid
 *  consumer for slice inlining. Same criteria as
 *  `emitTensorAssignFromExpr`'s entry condition in `emitStmt.ts`'s
 *  Assign arm. We deliberately allow broadcast consumers — the
 *  motivating lap2d_green case has column slices feeding broadcast
 *  arithmetic. */
function isElementwiseConsumerCandidate(s: IRStmt): boolean {
  if (s.kind !== "Assign") return false;
  if (!isNumeric(s.ty) || s.ty.elem !== "double") return false;
  if (!isMultiElement(s.ty)) return false;
  if (s.ty.isComplex) return false;
  const rhs = s.rhs;
  if (rhs.kind === "TensorLit") return false;
  if (rhs.kind === "Var") return false;
  if (rhs.kind === "IndexSlice") return false;
  if (rhs.kind === "Call") {
    const isDirectOwnedCall =
      rhs.callee.kind === "userFunc" ||
      (rhs.callee.kind === "builtin" &&
        rhs.callee.sig.producesOwnedDirectly === true);
    if (isDirectOwnedCall) return false;
  }
  return true;
}

/** True iff `s` writes to `cName` — directly via Assign, or via an
 *  IndexStore / IndexSliceStore (in-place buffer mutation), or via a
 *  MultiAssignCall output slot. These are the operations that could
 *  invalidate a slice we've decided to inline, so the plan-builder
 *  bails when one shows up between the producer and the consumer. */
function statementWrites(s: IRStmt, cName: string): boolean {
  if (s.kind === "Assign" && s.cName === cName) return true;
  if (s.kind === "IndexStore" && s.base.cName === cName) return true;
  if (s.kind === "IndexSliceStore" && s.base.cName === cName) return true;
  if (s.kind === "MultiAssignCall") {
    for (const out of s.outputs) {
      if (out.binding !== null && out.binding.cName === cName) return true;
    }
  }
  return false;
}

/** Collect cNames of multi-element Vars read in `s`'s top-level
 *  expressions. Used to detect intervening reads of the producer's
 *  cName (which would block fusion). */
function topLevelMultiElemReads(s: IRStmt): Set<string> {
  const out = new Set<string>();
  forEachTopLevelExpr(s, e => {
    forEachSubExpr(e, sub => {
      if (sub.kind === "Var" && isMultiElement(sub.ty)) out.add(sub.cName);
    });
  });
  return out;
}

/** True iff `cName` appears anywhere in `e` in a position that the
 *  Var-read substitution at `emitExpr` will NOT reach — i.e. as a
 *  struct-handle read (`IndexLoad.base`, `IndexSlice.base`) or
 *  buried inside a `TensorLit` cell. If we inlined under those
 *  conditions the consumer's emitted C would dereference an
 *  unpopulated handle for the skipped producer. */
function appearsInNonSlotPosition(e: IRExpr, cName: string): boolean {
  switch (e.kind) {
    case "Var":
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "EndRef":
      return false;
    case "Binary":
      return (
        appearsInNonSlotPosition(e.left, cName) ||
        appearsInNonSlotPosition(e.right, cName)
      );
    case "Unary":
      return appearsInNonSlotPosition(e.operand, cName);
    case "Call":
      for (const a of e.args) {
        if (appearsInNonSlotPosition(a, cName)) return true;
      }
      return false;
    case "IndexLoad":
      if (e.base.cName === cName) return true;
      for (const i of e.indices) {
        if (appearsInNonSlotPosition(i, cName)) return true;
      }
      return false;
    case "IndexSlice":
      if (e.base.cName === cName) return true;
      for (const slot of e.index) {
        if (slot.kind === "Range") {
          if (appearsInNonSlotPosition(slot.start, cName)) return true;
          if (appearsInNonSlotPosition(slot.step, cName)) return true;
          if (appearsInNonSlotPosition(slot.end, cName)) return true;
        } else if (slot.kind === "Scalar") {
          if (appearsInNonSlotPosition(slot.expr, cName)) return true;
        }
      }
      return false;
    case "TensorLit": {
      let found = false;
      for (const row of e.elements) {
        for (const cell of row) {
          if (cell.kind === "Var" && cell.cName === cName) found = true;
          if (appearsInNonSlotPosition(cell, cName)) found = true;
        }
      }
      return found;
    }
  }
}

/** Plan-builder. Walks `stmts` in source order; for each candidate
 *  producer, scans forward for a unique consumer that satisfies all
 *  preconditions. Recurses into `If` / `While` / `For` bodies so
 *  fusions inside nested scopes are also discovered (body-local;
 *  fusion never crosses a control-flow boundary). */
export function buildColumnSlicePlan(
  stmts: ReadonlyArray<IRStmt>,
  futureTouches: FutureTouchMap
): ColumnSlicePlan {
  const skipProducers = new Set<IRStmt>();
  // Per-consumer inlines accumulate as multiple producers feed the
  // same consumer (e.g. `r = base(:, 1) + base(:, 2)` would inline
  // both slices into one consumer).
  const consumerInlines = new Map<IRStmt, Map<string, ColumnSliceInline>>();

  function recurseBody(body: ReadonlyArray<IRStmt>): void {
    for (const s of body) {
      if (s.kind === "If") {
        recurseBody(s.thenBody);
        for (const eif of s.elseifs) recurseBody(eif.body);
        if (s.elseBody) recurseBody(s.elseBody);
      } else if (s.kind === "While" || s.kind === "For") {
        recurseBody(s.body);
      }
    }
  }
  recurseBody(stmts);

  // After recursing into nested bodies, scan THIS level for producer/
  // consumer pairs. The order matters: we walk producers in source
  // order, and for each we scan forward to its consumer.
  for (let i = 0; i < stmts.length; i++) {
    const producer = stmts[i];
    const slice = classifySliceProducer(producer);
    if (slice === null) continue;
    if (skipProducers.has(producer)) continue;
    const producerAssign = producer as Extract<IRStmt, { kind: "Assign" }>;
    const prodCName = producerAssign.cName;
    const baseCName = slice.baseVar.cName;

    // Forward scan for the consumer.
    let consumer: IRStmt | null = null;
    let bail = false;
    for (let j = i + 1; j < stmts.length; j++) {
      const s = stmts[j];
      // Control-flow stmts: opaque mutation potential — bail.
      if (
        s.kind === "If" ||
        s.kind === "While" ||
        s.kind === "For" ||
        s.kind === "Break" ||
        s.kind === "Continue" ||
        s.kind === "ReturnFromFunction"
      ) {
        bail = true;
        break;
      }
      // Any write to either the producer's LHS or its base is a
      // hard bail — the inlined read would see the wrong value.
      if (statementWrites(s, prodCName) || statementWrites(s, baseCName)) {
        bail = true;
        break;
      }
      // Is this stmt the consumer of prodCName?
      const reads = topLevelMultiElemReads(s);
      if (reads.has(prodCName)) {
        consumer = s;
        break;
      }
    }
    if (bail || consumer === null) continue;

    // The consumer must be a fusion-eligible elementwise Assign.
    if (!isElementwiseConsumerCandidate(consumer)) continue;
    const consumerAssign = consumer as Extract<IRStmt, { kind: "Assign" }>;

    // The producer's cName must be dead after this consumer
    // (i.e. single-use globally past this point — no later reads).
    const futureAfter = futureTouches.get(consumer) ?? new Set();
    if (futureAfter.has(prodCName)) continue;

    // The producer's cName must appear in the consumer's RHS only
    // in iter-slot positions — anywhere else (IndexLoad.base etc.)
    // would dereference the never-populated handle.
    if (appearsInNonSlotPosition(consumerAssign.rhs, prodCName)) continue;

    // All preconditions hold — fuse.
    skipProducers.add(producer);
    let perConsumer = consumerInlines.get(consumer);
    if (perConsumer === undefined) {
      perConsumer = new Map();
      consumerInlines.set(consumer, perConsumer);
    }
    perConsumer.set(prodCName, slice);
  }

  return { skipProducers, consumerInlines };
}

/** Owned C-names that a consumer effectively touches once column-
 *  slice inlining is applied — the original top-level owned uses
 *  augmented by the base of each inlined slice. The producer's
 *  reads of the base "move" to the consumer at emit time, so we
 *  augment liveness accordingly. Returns `null` if the consumer has
 *  no slices to inline; callers fall back to `topLevelOwnedUses(s)`. */
export function columnSliceInlinedOwnedUses(
  s: IRStmt,
  plan: ColumnSlicePlan,
  originalUses: Set<string>
): Set<string> | null {
  const perConsumer = plan.consumerInlines.get(s);
  if (perConsumer === undefined) return null;
  const out = new Set(originalUses);
  for (const inline of perConsumer.values()) {
    if (isOwned(inline.baseVar.ty)) out.add(inline.baseVar.cName);
  }
  return out;
}
