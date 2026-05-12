/**
 * Same-shape elementwise fusion plan.
 *
 * A small, self-contained codegen-time peephole that recognizes
 * back-to-back same-shape elementwise `Assign`s where the first
 * statement's result is consumed exactly once by the second, and
 * collapses them into a single fused loop at emit time.
 *
 * Concretely, the source pattern
 *
 *     b = a + 1;
 *     c = b * 2;
 *
 * normally emits two allocations and two loops. With fusion, the
 * producer's loop is elided and its right-hand side is spliced into
 * the consumer's loop body:
 *
 *     /\* b = a + 1 *\/                     (producer comment kept)
 *     /\* c = b * 2 *\/                     (consumer comment)
 *     {
 *       mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(a.dims[0], a.dims[1]);
 *       long _mtoc_n = _mtoc_t.dims[0] * _mtoc_t.dims[1];
 *       for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {
 *         _mtoc_t.real[_mtoc_i] = (a.real[_mtoc_i] + 1.0) * 2.0;
 *       }
 *       mtoc_tensor_assign(&c, _mtoc_t);
 *     }
 *
 * The producer's `b` predeclaration stays (an empty handle costs
 * nothing), and the scope-exit free of `b` is a no-op on the empty
 * struct.
 *
 * # Modularity
 *
 * The plan-builder is a pure function from `(stmts, futureTouches)`
 * to a `FusionPlan` value. The codegen consults the plan at three
 * sites:
 *
 *   - `emit.ts`/`emitFunction.ts` build the plan after liveness and
 *     stash it on `EmitState.fusionPlan`. A null plan disables fusion
 *     entirely.
 *   - `emitStmt.ts`'s `Assign` arm checks `plan.skipProducers` and
 *     `plan.consumerRhs` — skips a producer's emission when fused,
 *     uses the rewritten RHS when consuming a fused chain.
 *   - `emitAnalysis.ts`'s `deadAfterStmt` walks the rewritten RHS so
 *     post-fusion liveness picks up the producer's operands as
 *     consumer uses.
 *
 * Deleting this file (and the three hook sites) returns the codegen
 * to its pre-fusion behavior. The hook sites all guard on
 * `fusionPlan === null` so a callsite that fails to build the plan
 * never falls into a broken state.
 *
 * # Scope of this MVP
 *
 * The peephole only fires when:
 *   - producer and consumer are both `Assign`s to a multi-element
 *     real-double tensor going through the `emitTensorAssignFromExpr`
 *     elementwise-loop path;
 *   - both use the flat-iter (no implicit-broadcast) path — every
 *     multi-element operand of each side has the same static shape;
 *   - the producer's static result shape equals the consumer's;
 *   - the producer is the immediately-preceding statement in the
 *     body (no intervening control flow, no other stmts that might
 *     reassign or otherwise touch the producer's operands);
 *   - the producer's LHS C-name has exactly one use, at this
 *     consumer (i.e. it appears in `deadAfterStmt(consumer)` under
 *     the unfused liveness).
 *
 * Chains compose naturally: when we fuse P1 into P2 we also stash
 * P2's rewritten RHS, so a subsequent fusion of P2 into P3 inlines
 * the full chain.
 *
 * The MVP intentionally excludes:
 *   - broadcast producers or consumers (different operand shapes);
 *   - complex-valued producers/consumers (deferred);
 *   - slice/transpose producers (different shape than consumer);
 *   - producers across control-flow boundaries.
 *
 * Each exclusion is a separate, equally small peephole when the time
 * comes.
 */

import type { IRExpr, IRStmt } from "../../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  isOwned,
  type NumericType,
} from "../../lowering/types.js";
import { forEachSubExpr } from "../../lowering/walk.js";
import type { FutureTouchMap } from "../liveness.js";

export interface FusionPlan {
  /** Producer Assigns whose elementwise-loop emission should be
   *  skipped. The producer's `/* name = ... *\/` IR-render comment
   *  still emits at its source position so the reader of the
   *  generated C can trace each numbl statement; the loop / alloc /
   *  assign C code is omitted. */
  skipProducers: ReadonlySet<IRStmt>;
  /** Per consumer `Assign`, the effective RHS to emit and to use for
   *  post-fusion liveness analysis. Built by substituting each fused
   *  producer's RHS for `Var(producer.cName)` references in the
   *  consumer's original RHS. The original IR is not mutated;
   *  consumers absent from this map use their stored `rhs`
   *  unchanged. */
  consumerRhs: ReadonlyMap<IRStmt, IRExpr>;
}

export const EMPTY_FUSION_PLAN: FusionPlan = {
  skipProducers: new Set(),
  consumerRhs: new Map(),
};

/** True when two multi-element NumericTypes share static shape under
 *  the dim lattice. Mirrors `sameStaticShape` in `emitTensor.ts`; we
 *  keep a local copy here so the opt module stays a self-contained
 *  peephole that doesn't depend on emit internals. */
function sameStaticShape(a: NumericType, b: NumericType): boolean {
  if (a.dims.length !== b.dims.length) return false;
  for (let i = 0; i < a.dims.length; i++) {
    if (a.dims[i].kind !== b.dims[i].kind) return false;
  }
  return true;
}

/** Predicate: `s` is an `Assign` whose RHS goes through the same-shape
 *  flat-iter elementwise emission path. Excludes:
 *    - direct-owned-Call RHS (user-function / non-elementwise builtin
 *      returning an owned tensor by value — handled by a different
 *      emit path),
 *    - TensorLit / Var / IndexSlice RHS (each has its own emitter),
 *    - complex result (MVP restriction; mixing creal/cimag through
 *      the substituter needs care),
 *    - broadcast operand shapes (when two multi-elem operands have
 *      different static shapes; goes through the broadcast emitter).
 *  Returns the multi-elem operand list as a side effect when the
 *  predicate succeeds, since the caller usually wants it next. */
function flatIterAssignInfo(s: IRStmt): {
  rhsTy: NumericType;
  multiOperands: Array<Extract<IRExpr, { kind: "Var" }>>;
} | null {
  if (s.kind !== "Assign") return null;
  if (!isNumeric(s.ty) || s.ty.elem !== "double") return null;
  if (!isMultiElement(s.ty)) return null;
  if (s.ty.isComplex) return null;
  const rhs = s.rhs;
  if (rhs.kind === "TensorLit") return null;
  if (rhs.kind === "Var") return null;
  if (rhs.kind === "IndexSlice") return null;
  if (rhs.kind === "Call") {
    const isDirectOwnedCall =
      rhs.callee.kind === "userFunc" ||
      (rhs.callee.kind === "builtin" &&
        rhs.callee.sig.producesOwnedDirectly === true);
    if (isDirectOwnedCall) return null;
  }
  // Walk the RHS to gather multi-element Var operands. If any pair
  // has different static shape, the producer/consumer would route
  // through the broadcast emitter — exclude it from same-shape
  // fusion (the broadcast emitter has its own index math).
  const operands = new Map<string, Extract<IRExpr, { kind: "Var" }>>();
  forEachSubExpr(rhs, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty)) {
      if (!operands.has(sub.cName)) operands.set(sub.cName, sub);
    }
  });
  if (operands.size === 0) return null;
  const firstTy = operands.values().next().value!.ty;
  if (!isNumeric(firstTy)) return null;
  for (const v of operands.values()) {
    if (!isNumeric(v.ty)) return null;
    if (v.ty.isComplex) return null;
    if (!sameStaticShape(firstTy, v.ty)) return null;
  }
  return { rhsTy: s.ty, multiOperands: [...operands.values()] };
}

/** Substitute `Var(cName)` references in `e` with their producer-RHS
 *  replacements from `fused`. Pure tree rewrite. Does NOT descend
 *  into positions where a `Var` is read as a struct handle rather
 *  than an iter-slot value:
 *    - `IndexLoad.base` / `IndexSlice.base` (struct read for index
 *      math; their cNames are read as `<v>` not `<v>.real[<iter>]`),
 *    - `TensorLit` cells (intentionally conservative — fusion under
 *      a literal could collide with the literal emitter's own
 *      assumptions).
 *  Numeric literals / EndRef pass through unchanged. */
function substituteFused(
  e: IRExpr,
  fused: ReadonlyMap<string, IRExpr>
): IRExpr {
  switch (e.kind) {
    case "Var": {
      const r = fused.get(e.cName);
      return r ?? e;
    }
    case "Binary": {
      const left = substituteFused(e.left, fused);
      const right = substituteFused(e.right, fused);
      if (left === e.left && right === e.right) return e;
      return { ...e, left, right };
    }
    case "Unary": {
      const operand = substituteFused(e.operand, fused);
      if (operand === e.operand) return e;
      return { ...e, operand };
    }
    case "Call": {
      let changed = false;
      const newArgs = e.args.map(a => {
        const sub = substituteFused(a, fused);
        if (sub !== a) changed = true;
        return sub;
      });
      if (!changed) return e;
      return { ...e, args: newArgs };
    }
    case "IndexLoad": {
      // Leave base untouched (struct read). Indices are scalar
      // expressions; recurse into them in case a future extension
      // lets a scalar producer feed an index expression.
      let changed = false;
      const newIndices = e.indices.map(i => {
        const sub = substituteFused(i, fused);
        if (sub !== i) changed = true;
        return sub;
      });
      if (!changed) return e;
      return { ...e, indices: newIndices };
    }
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "EndRef":
    case "TensorLit":
    case "IndexSlice":
      return e;
  }
}

/** Owned C-names referenced by an IR expression as multi-element
 *  Vars in iter-slot positions — the set we need to add to a
 *  consumer's effective uses after fusing in a producer. Mirrors
 *  the substituter's traversal rules: skips `IndexLoad.base`,
 *  `IndexSlice.base`, `TensorLit` cells. */
function iterSlotVars(e: IRExpr, out: Set<string>): void {
  switch (e.kind) {
    case "Var":
      if (isMultiElement(e.ty)) out.add(e.cName);
      return;
    case "Binary":
      iterSlotVars(e.left, out);
      iterSlotVars(e.right, out);
      return;
    case "Unary":
      iterSlotVars(e.operand, out);
      return;
    case "Call":
      for (const a of e.args) iterSlotVars(a, out);
      return;
    case "IndexLoad":
      for (const i of e.indices) iterSlotVars(i, out);
      return;
    default:
      return;
  }
}

/** True iff `cName` appears anywhere in `e` in a position that
 *  `substituteFused` does NOT recurse into — i.e. where the
 *  substitution would NOT replace it. Used to reject fusion when
 *  the producer's cName escapes the substituter's reach (struct-
 *  handle reads for `IndexLoad.base` / `IndexSlice.base`, or hidden
 *  inside a `TensorLit` cell). If we fused under those conditions
 *  the consumer's emitted C would dereference a never-populated
 *  empty handle for the skipped producer. */
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
      // Be conservative: any reference inside a literal cell counts.
      // (The substituter doesn't recurse into TensorLit cells.)
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

/** Linear-pass plan builder. Walks `stmts` in order; for each Assign
 *  s, checks whether the immediately-preceding statement is an
 *  eligible producer that s consumes exactly once, and records the
 *  fusion when all preconditions hold.
 *
 *  The walker keeps at most one "candidate producer" carry — when an
 *  ineligible statement (non-Assign, non-flat-iter Assign, branch /
 *  loop / disp / ...) is encountered, the carry is dropped. The
 *  fusion is therefore purely peephole-local: no control-flow
 *  reasoning is required to maintain correctness. */
export function buildFusionPlan(
  stmts: ReadonlyArray<IRStmt>,
  futureTouches: FutureTouchMap
): FusionPlan {
  const skipProducers = new Set<IRStmt>();
  const consumerRhs = new Map<IRStmt, IRExpr>();

  // The most-recently-emitted producer that is still a fusion
  // candidate: a fusion-eligible Assign in `stmts` such that the
  // current scan position is immediately after it. Cleared by any
  // intervening statement (control flow, ineligible Assign, etc.)
  // so we never fuse across stmts that could touch operands.
  let candidate: {
    stmt: Extract<IRStmt, { kind: "Assign" }>;
    /** Possibly-rewritten RHS (after any prior fusions). What we
     *  inline at the next consumer. */
    effectiveRhs: IRExpr;
    /** Type of the producer's effective result — used to compare
     *  static shape with the consumer's operand. */
    rhsTy: NumericType;
  } | null = null;

  for (const s of stmts) {
    // Walk into nested bodies of control-flow stmts so their bodies
    // get their own plans. They do not share `candidate` with the
    // outer scope — fusion is body-local.
    if (s.kind === "If") {
      const thenPlan = buildFusionPlan(s.thenBody, futureTouches);
      for (const p of thenPlan.skipProducers) skipProducers.add(p);
      for (const [k, v] of thenPlan.consumerRhs) consumerRhs.set(k, v);
      for (const eif of s.elseifs) {
        const armPlan = buildFusionPlan(eif.body, futureTouches);
        for (const p of armPlan.skipProducers) skipProducers.add(p);
        for (const [k, v] of armPlan.consumerRhs) consumerRhs.set(k, v);
      }
      if (s.elseBody) {
        const elsePlan = buildFusionPlan(s.elseBody, futureTouches);
        for (const p of elsePlan.skipProducers) skipProducers.add(p);
        for (const [k, v] of elsePlan.consumerRhs) consumerRhs.set(k, v);
      }
      candidate = null;
      continue;
    }
    if (s.kind === "While" || s.kind === "For") {
      const bodyPlan = buildFusionPlan(s.body, futureTouches);
      for (const p of bodyPlan.skipProducers) skipProducers.add(p);
      for (const [k, v] of bodyPlan.consumerRhs) consumerRhs.set(k, v);
      candidate = null;
      continue;
    }
    if (s.kind !== "Assign") {
      candidate = null;
      continue;
    }

    // Possible consumer. Check if candidate is fusion-eligible into s.
    let didFuse = false;
    if (candidate !== null) {
      const info = flatIterAssignInfo(s);
      if (info !== null) {
        const consumerOperand = info.multiOperands.find(
          v => v.cName === candidate!.stmt.cName
        );
        if (consumerOperand !== undefined) {
          // Single-use check: producer's cName must be dead-after the
          // consumer under the unfused liveness. The future-touch map
          // is indexed by stmt; consult the consumer's entry.
          const futureAfter = futureTouches.get(s) ?? new Set();
          const isDeadAfterConsumer = !futureAfter.has(candidate.stmt.cName);
          // Shape match: producer's effective result shape must equal
          // the consumer's operand shape (which equals the consumer's
          // operand-set-wide shape since we already require
          // sameStaticShape across the consumer's operands).
          const shapeMatch =
            isNumeric(consumerOperand.ty) &&
            sameStaticShape(candidate.rhsTy, consumerOperand.ty);
          // Same-occurrence check: producer's cName should appear in
          // the consumer's RHS exactly as iter-slot reads (not as
          // IndexLoad.base etc.). `iterSlotVars` already restricts to
          // iter-slot positions; we additionally guard against any
          // appearance in a non-substitutable position so the skipped
          // producer's never-populated handle is never dereferenced.
          const slotVars = new Set<string>();
          iterSlotVars(s.rhs, slotVars);
          const usedInSlot = slotVars.has(candidate.stmt.cName);
          const escapesSlot = appearsInNonSlotPosition(
            s.rhs,
            candidate.stmt.cName
          );
          if (isDeadAfterConsumer && shapeMatch && usedInSlot && !escapesSlot) {
            const fusedMap = new Map<string, IRExpr>();
            fusedMap.set(candidate.stmt.cName, candidate.effectiveRhs);
            const rewritten = substituteFused(s.rhs, fusedMap);
            skipProducers.add(candidate.stmt);
            consumerRhs.set(s, rewritten);
            didFuse = true;
            // Update s's effective RHS for chain fusion below.
            const nextInfo = flatIterAssignInfo(s);
            if (nextInfo !== null) {
              candidate = {
                stmt: s,
                effectiveRhs: rewritten,
                rhsTy: nextInfo.rhsTy,
              };
            } else {
              candidate = null;
            }
          }
        }
      }
    }

    if (!didFuse) {
      // s is not a consumer of `candidate` (or no candidate). Refresh
      // candidate from s if s is itself fusion-eligible.
      const sInfo = flatIterAssignInfo(s);
      if (sInfo !== null) {
        candidate = {
          stmt: s,
          effectiveRhs: s.rhs,
          rhsTy: sInfo.rhsTy,
        };
      } else {
        candidate = null;
      }
    }
  }

  return { skipProducers, consumerRhs };
}

/** Owned C-names referenced by `s`'s effective (post-fusion) RHS.
 *  Mirrors `collectOwnedVarsInExpr` in `liveness.ts` but walks the
 *  rewritten RHS so post-fusion liveness sees the inlined producer's
 *  reads as the consumer's own. Returns `null` if the stmt has no
 *  rewritten RHS in the plan; callers should fall back to the
 *  unfused `topLevelOwnedUses(s)` in that case. */
export function fusedOwnedUses(
  s: IRStmt,
  plan: FusionPlan
): Set<string> | null {
  const rewritten = plan.consumerRhs.get(s);
  if (rewritten === undefined) return null;
  const out = new Set<string>();
  forEachSubExpr(rewritten, sub => {
    if (sub.kind === "Var" && isOwned(sub.ty)) out.add(sub.cName);
  });
  return out;
}
