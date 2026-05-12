/**
 * Transpose inlining plan.
 *
 * Recognizes `Assign` producers of the shape `_anf = base.'` (i.e. a
 * direct `mtoc_tensor_transpose` / `mtoc_tensor_transpose_complex`
 * `Call`) whose result is consumed exactly once by a downstream
 * broadcast elementwise `Assign`, and rewrites the consumer's read
 * of the transpose to read directly from `base`'s buffer at the
 * swapped column-major offset — skipping the transpose's own
 * allocation and copy loop.
 *
 * The peephole pairs naturally with column-slice inlining: a column
 * slice `src(:, k)` consumed by a transpose `t = ans.'` consumed by
 * a broadcast op... gets the transpose layer collapsed here; the
 * slice-into-transpose chain still materializes the slice (the
 * slice's consumer is the transpose, not the broadcast — outside
 * the scope of `inlineColumnSlice.ts`). Closing that last gap is a
 * follow-up "chained slice+transpose" peephole.
 *
 * # MVP scope
 *
 *   - Producer is `Assign(prodCName, Call(transpose, [base]))` with
 *     `base` a 2-D multi-element real-double `Var`.
 *   - Consumer is a broadcast elementwise `Assign` (the broadcast
 *     emitter is where the swap-axis index math fits naturally;
 *     flat-iter would need div/mod and is deferred).
 *   - Same body, no intervening writes to base / prodCName, single-
 *     use, only iter-slot positions — mirrors the slice plan's
 *     forward-scan rules.
 *
 * # Substitution rule (broadcast frame)
 *
 * For a transpose `t = base.'` with base of shape `[N, M]`, the
 * output has shape `[M, N]`. Element `(t0, t1)` of the output
 * equals element `(t1, t0)` of the base. In column-major:
 *
 *     base.real[t1 + t0 * base.dims[0]]
 *
 * At a broadcast iter `(k0, k1, ...)`, the transpose's per-axis
 * logical coord comes from its static dim lattice:
 *   - dim kind `one`     → 0 (drop)
 *   - dim kind `notOne`  → loopVars[i]
 *   - dim kind `unknown` → `(<axis-size> == 1 ? 0 : loopVars[i])`
 *
 * Plugging the per-axis terms into the swap formula yields the
 * base offset. For the common column-slice → row-transpose case
 * (`[N,1].'` → `[1,N]`), axis 0 = one (t0 = 0), axis 1 = notOne
 * (t1 = k1), so base offset = `k1 + 0 * base.dims[0]` = `k1`.
 *
 * # Modularity contract
 *
 * The plan-builder is a pure function from `(stmts, futureTouches)`
 * to a `TransposePlan`. Five null-guarded hook sites consume it
 * (`emit.ts` / `emitFunction.ts` to build, `emitStmt.ts` to skip
 * the producer and thread the inline map down, `emitTensor.ts` to
 * override axis-size lookups and skip per-operand precompute,
 * `emitExpr.ts` to substitute the Var read, `emitAnalysis.ts` to
 * augment the consumer's owned-use set). See `docs/optimizations.md`.
 */

import type { IRExpr, IRStmt } from "../../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  isOwned,
  type DimInfo,
} from "../../lowering/types.js";
import { forEachSubExpr, forEachTopLevelExpr } from "../../lowering/walk.js";
import type { FutureTouchMap } from "../liveness.js";

export interface TransposeInline {
  /** 2-D base tensor whose buffer the consumer will read directly. */
  baseVar: Extract<IRExpr, { kind: "Var" }>;
  /** Static dim lattice of the transpose's OUTPUT (i.e. swapped
   *  base.dims). Used at emit time to pick the per-axis index term
   *  exactly the way the broadcast emitter would have for a
   *  materialized transpose. */
  outputAxisKinds: readonly [DimInfo, DimInfo];
}

export interface TransposePlan {
  skipProducers: ReadonlySet<IRStmt>;
  consumerInlines: ReadonlyMap<IRStmt, ReadonlyMap<string, TransposeInline>>;
}

export const EMPTY_TRANSPOSE_PLAN: TransposePlan = {
  skipProducers: new Set(),
  consumerInlines: new Map(),
};

/** Classify a producer `Assign` as an inlinable 2-D real-double
 *  transpose, or return null when it doesn't fit the MVP pattern.
 *  The mtoc transpose lowering (`lowering/lowerUnary.ts`) emits a
 *  builtin `Call` named `"transpose"`; we identify the producer by
 *  that name plus the single 2-D Var argument. */
function classifyTransposeProducer(s: IRStmt): TransposeInline | null {
  if (s.kind !== "Assign") return null;
  if (s.rhs.kind !== "Call") return null;
  if (s.rhs.callee.kind !== "builtin") return null;
  if (s.rhs.callee.sig.name !== "transpose") return null;
  if (s.rhs.args.length !== 1) return null;
  const arg = s.rhs.args[0];
  if (arg.kind !== "Var") return null;
  if (!isNumeric(arg.ty)) return null;
  if (arg.ty.elem !== "double") return null;
  if (arg.ty.isComplex) return null;
  if (!isMultiElement(arg.ty)) return null;
  if (arg.ty.dims.length !== 2) return null;
  // The output's dim lattice is the swap of the base's: axis 0 of
  // output corresponds to axis 1 of base, and vice versa.
  const outputAxisKinds: readonly [DimInfo, DimInfo] = [
    arg.ty.dims[1],
    arg.ty.dims[0],
  ];
  return { baseVar: arg, outputAxisKinds };
}

/** Predicate: `s` is an `Assign` that emits through the broadcast
 *  elementwise path AND has at least two multi-element operands of
 *  differing static shape (the broadcast trigger). Flat-iter
 *  consumers are deferred — substituting a transpose into a single
 *  flat iter index would need div/mod for the general case. */
function isBroadcastConsumerCandidate(s: IRStmt): boolean {
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
  // Inspect multi-element Var operands: at least two with different
  // static shape means broadcast emission. Same-shape would route to
  // flat-iter; we decline.
  const operands: Extract<IRExpr, { kind: "Var" }>[] = [];
  forEachSubExpr(rhs, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty)) operands.push(sub);
  });
  if (operands.length < 2) return false;
  const first = operands[0].ty;
  if (!isNumeric(first)) return false;
  for (const op of operands) {
    if (!isNumeric(op.ty)) continue;
    if (op.ty.dims.length !== first.dims.length) return true;
    for (let i = 0; i < op.ty.dims.length; i++) {
      if (op.ty.dims[i].kind !== first.dims[i].kind) return true;
    }
  }
  return false;
}

/** True iff `s` mutates `cName` — same set of operations as in
 *  `inlineColumnSlice.ts`. A write between producer and consumer
 *  invalidates the inline. */
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

function topLevelMultiElemReads(s: IRStmt): Set<string> {
  const out = new Set<string>();
  forEachTopLevelExpr(s, e => {
    forEachSubExpr(e, sub => {
      if (sub.kind === "Var" && isMultiElement(sub.ty)) out.add(sub.cName);
    });
  });
  return out;
}

/** True iff `cName` appears anywhere in `e` in a position the
 *  Var-read substitution doesn't reach (struct handle reads as
 *  `IndexLoad.base` / `IndexSlice.base` / etc.). Same guard as the
 *  slice peephole. */
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

export function buildTransposePlan(
  stmts: ReadonlyArray<IRStmt>,
  futureTouches: FutureTouchMap
): TransposePlan {
  const skipProducers = new Set<IRStmt>();
  const consumerInlines = new Map<IRStmt, Map<string, TransposeInline>>();

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

  for (let i = 0; i < stmts.length; i++) {
    const producer = stmts[i];
    const transpose = classifyTransposeProducer(producer);
    if (transpose === null) continue;
    if (skipProducers.has(producer)) continue;
    const producerAssign = producer as Extract<IRStmt, { kind: "Assign" }>;
    const prodCName = producerAssign.cName;
    const baseCName = transpose.baseVar.cName;

    let consumer: IRStmt | null = null;
    let bail = false;
    for (let j = i + 1; j < stmts.length; j++) {
      const s = stmts[j];
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
      if (statementWrites(s, prodCName) || statementWrites(s, baseCName)) {
        bail = true;
        break;
      }
      const reads = topLevelMultiElemReads(s);
      if (reads.has(prodCName)) {
        consumer = s;
        break;
      }
    }
    if (bail || consumer === null) continue;

    if (!isBroadcastConsumerCandidate(consumer)) continue;
    const consumerAssign = consumer as Extract<IRStmt, { kind: "Assign" }>;

    const futureAfter = futureTouches.get(consumer) ?? new Set();
    if (futureAfter.has(prodCName)) continue;

    if (appearsInNonSlotPosition(consumerAssign.rhs, prodCName)) continue;

    skipProducers.add(producer);
    let perConsumer = consumerInlines.get(consumer);
    if (perConsumer === undefined) {
      perConsumer = new Map();
      consumerInlines.set(consumer, perConsumer);
    }
    perConsumer.set(prodCName, transpose);
  }

  return { skipProducers, consumerInlines };
}

/** Augment a consumer's owned uses with the bases of each inlined
 *  transpose so post-fusion liveness keeps them alive through the
 *  consumer. Same shape as the slice peephole's helper. */
export function transposeInlinedOwnedUses(
  s: IRStmt,
  plan: TransposePlan,
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
