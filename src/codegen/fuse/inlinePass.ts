/**
 * Tensor-expression fusion: pass 1 (IR inlining).
 *
 * Replaces chains of single-use elementwise Assigns with one fat
 * Assign whose RHS is the substituted expression tree. Runs between
 * lowering+ANF and codegen as a pure `(IRProgram) → IRProgram`
 * rewrite. The codegen sees a smaller, fatter IR and emits one loop
 * per surviving multi-element Assign — no new emitter machinery is
 * needed for the MVP because the iter-loop emitter already walks
 * arbitrary Binary/Unary/Call/Var trees.
 *
 * # The two-pass architecture
 *
 *   Pass 1 (here) : inline single-use multi-element Assigns whose RHS
 *                   is pure elementwise. Decoupled from codegen.
 *   Pass 2 (codegen, future extension): generalized iter-context
 *                   renderer that can splice IndexSlice / transpose /
 *                   broadcast operands without materializing them.
 *
 * The MVP only implements pass 1, and only for the case where both
 * producer and consumer go through the existing flat-iter
 * (`emitFlatAssign`) emission path — i.e. their static shapes match
 * and no operand needs broadcasting. That covers the `r2 → val`
 * step in compute_kernel; extending pass 1 to broadcast and pass 2
 * to slice/transpose is the V3 follow-up.
 *
 * # Inlinability predicate
 *
 * A producer Assign P with LHS cName X is inlinable into a consumer
 * Assign C iff EVERY one of these holds:
 *
 *   1. P produces a multi-element real-double tensor (complex / char
 *      / N-D-with-non-2-axes deferred).
 *   2. P's RHS is "pure elementwise": only NumLit / ImagLit / Var /
 *      Binary / Unary / IndexLoad / EndRef / elementwise libm Call.
 *      No TensorLit, no IndexSlice, no user-fn Call, no
 *      direct-owned-Call builtin (transpose, reshape, sum, etc.).
 *   3. X is used exactly once in the body. The count includes every
 *      `Var(X)` occurrence reachable via `forEachSubExpr`. Function
 *      output cNames get a +1 protective bump so the returned value
 *      is never elided.
 *   4. The single use is in another `Assign`'s RHS, in an
 *      iter-context-compatible position: NOT as `IndexLoad.base`,
 *      `IndexSlice.base`, `IndexStore.base`, `IndexSliceStore.base`,
 *      a user-fn `Call` arg, a direct-owned builtin's arg (sum,
 *      reshape, transpose...), or inside a `TensorLit` cell.
 *   5. C is a multi-element real-double Assign whose RHS goes
 *      through the elementwise-loop path. Same gate as
 *      `emitTensorAssignFromExpr`'s entry condition.
 *   6. P and C have the same static result shape, AND every
 *      multi-element operand of C's RHS (excluding X, which we're
 *      replacing) shares that shape. This keeps the fused result on
 *      the flat-iter path. (V3 will relax this.)
 *   7. P and C are at the same body level (no fusion across If /
 *      While / For).
 *   8. No statement between P and C writes to X or to any free Var
 *      in P's RHS, and no statement reads X (so we genuinely have
 *      the unique consumer).
 *
 * The substitution is a pure IR-tree rewrite: every `Var(X)` in C's
 * RHS becomes a fresh copy of P's RHS subtree. The producer Assign
 * is removed from the body. Its `assignedVars` predecl entry stays
 * (the predeclare-as-empty + scope-exit `mtoc_tensor_free` of an
 * empty struct are no-ops at the C level), so the rest of codegen
 * doesn't need to know fusion happened.
 *
 * # Algorithm
 *
 * Per body: iterate `inlineOnePass` to fixed point. Each pass walks
 * candidate producers in source order, scans forward for the single
 * consumer, checks all gates, substitutes if eligible. Chained
 * inlining (`a → b → c`) needs multiple iterations because each
 * substitution can expose a previously-second-use as single-use.
 * The number of iterations is bounded by chain depth; we cap at 32
 * defensively.
 *
 * # Codegen invariants this preserves
 *
 *   - Every multi-element `Var` in the post-fusion IR is either a
 *     function param, a TensorLit-producing Assign LHS, an
 *     IndexSlice-producing Assign LHS, a direct-owned-Call LHS, or
 *     a multi-element Assign LHS whose RHS we kept. None of these
 *     reach the empty-handle predecl path.
 *   - The post-fusion IR is still well-typed: every node's `.ty`
 *     stays as-is. The substitution doesn't change types because
 *     `Var(X).ty === X's Assign.ty === P.rhs.ty` (the producer's
 *     RHS type IS what the LHS gets).
 *   - The post-fusion IR still satisfies ANF for owned producers:
 *     we only inline producers whose RHS is NOT an owned producer
 *     (no TensorLit, IndexSlice, owned Call). So nested owned
 *     producers cannot appear post-fusion.
 *
 * # Why the existing codegen Just Works
 *
 * After fusion, a consumer's RHS contains nested `Binary` / `Unary`
 * / `Call` / `Var` / `NumLit`. The flat-iter emitter
 * (`emitTensor.ts:emitFlatAssign`) collects multi-element Vars via
 * `collectMultiElementVarsByCName`, walks the RHS once per slot via
 * `emitExpr`, and renders multi-element `Var` reads as
 * `<cName>.real[<iter>]`. Nothing in that path cares whether the
 * RHS was originally one Assign or three fused-in producers — it
 * just walks the tree.
 */

import type { IRExpr, IRStmt, IRProgram } from "../../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  type NumericType,
} from "../../lowering/types.js";
import { forEachSubExpr } from "../../lowering/walk.js";

/** Top-level entry. Mutates `prog.stmts` and each function's `body`
 *  in place (replacing them with new arrays) when fusion fires.
 *  Returns the same program reference for convenience. */
export function inlinePass(prog: IRProgram): IRProgram {
  prog.stmts = inlineInBody(prog.stmts, new Set());
  for (const fn of prog.functions) {
    const protectedNames = new Set<string>();
    for (const o of fn.outputs) protectedNames.add(o.cName);
    fn.body = inlineInBody(fn.body, protectedNames);
  }
  return prog;
}

/** Iterate `inlineOnePass` to fixed point over a single body. */
function inlineInBody(
  stmts: IRStmt[],
  protectedNames: ReadonlySet<string>
): IRStmt[] {
  // Also process nested-body inlining first so each control-flow
  // child stabilizes before its parent re-counts uses. The outer
  // body's fixpoint then operates on the post-nested-fusion shape.
  recurseInlineNested(stmts);

  let cur = stmts;
  for (let iter = 0; iter < 32; iter++) {
    const next = inlineOnePass(cur, protectedNames);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Recurse into If/While/For bodies and run inlining on each. */
function recurseInlineNested(stmts: IRStmt[]): void {
  for (const s of stmts) {
    if (s.kind === "If") {
      s.thenBody = inlineInBody(s.thenBody, new Set());
      for (const eif of s.elseifs) {
        eif.body = inlineInBody(eif.body, new Set());
      }
      if (s.elseBody) s.elseBody = inlineInBody(s.elseBody, new Set());
    } else if (s.kind === "While" || s.kind === "For") {
      s.body = inlineInBody(s.body, new Set());
    }
  }
}

/** One linear forward sweep. Performs AT MOST ONE substitution per
 *  call: scans for the first inlinable (producer, consumer) pair and
 *  rewrites them. The fixed-point loop iterates this until quiescent.
 *  Single-substitution-per-pass keeps the bookkeeping trivial (no
 *  inter-substitution race conditions, no "did this replacement
 *  invalidate a later one?" reasoning) at the cost of multiple
 *  passes for deep chains — fine since chains are short and bounded
 *  by 32 iterations. */
function inlineOnePass(
  stmts: IRStmt[],
  protectedNames: ReadonlySet<string>
): IRStmt[] {
  const useCounts = computeUseCounts(stmts, protectedNames);

  for (let i = 0; i < stmts.length; i++) {
    const producer = stmts[i];
    if (!isInlinableProducer(producer)) continue;
    const prodAssign = producer as Extract<IRStmt, { kind: "Assign" }>;
    if (protectedNames.has(prodAssign.cName)) continue;
    if (useCounts.get(prodAssign.cName) !== 1) continue;

    // Free vars in producer's RHS — must not be mutated between P
    // and C, and we use their shapes for the same-shape check.
    const prodFreeVars = collectFreeVarCNames(prodAssign.rhs);
    // Don't include the LHS itself in the protected-from-mutation
    // set (only relevant when the producer rebinds X, which we
    // don't allow via the use-count gate anyway).

    // Scan forward for the consumer.
    let consumer: IRStmt | null = null;
    let bail = false;
    for (let j = i + 1; j < stmts.length; j++) {
      const s = stmts[j];
      // Control flow ends the safe-fusion window.
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
      // Intervening write to producer's LHS or any free var in its
      // RHS invalidates the fusion (the consumer would read a
      // different value than the producer captured).
      if (stmtWritesAny(s, prodAssign.cName, prodFreeVars)) {
        bail = true;
        break;
      }
      // Did we find the consumer?
      if (stmtReadsAsMultiElemVar(s, prodAssign.cName)) {
        consumer = s;
        break;
      }
    }
    if (bail || consumer === null) continue;

    if (!isInlinableConsumer(consumer, prodAssign)) continue;
    const consAssign = consumer as Extract<IRStmt, { kind: "Assign" }>;

    // The producer's cName must appear ONLY in iter-slot positions
    // (not as IndexLoad.base etc.) in the consumer's RHS.
    if (appearsInNonSlotPosition(consAssign.rhs, prodAssign.cName)) continue;

    // Substitute, remove the producer, and return immediately.
    // The fixpoint loop will re-walk to catch chained fusions.
    const newRhs = substituteVar(
      consAssign.rhs,
      prodAssign.cName,
      prodAssign.rhs
    );
    const newConsumer: IRStmt = { ...consAssign, rhs: newRhs };
    const out: IRStmt[] = [];
    for (const s of stmts) {
      if (s === producer) continue;
      out.push(s === consumer ? newConsumer : s);
    }
    return out;
  }

  return stmts;
}

/** Walk a body's stmts (this level only — NOT into If/While/For
 *  bodies; nested fusion is handled separately) and count Var
 *  occurrences per cName. Function output cNames get a +1 bump
 *  so they are never inlined out. */
function computeUseCounts(
  stmts: ReadonlyArray<IRStmt>,
  protectedNames: ReadonlySet<string>
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (cName: string) =>
    counts.set(cName, (counts.get(cName) ?? 0) + 1);
  for (const cName of protectedNames) bump(cName);
  for (const s of stmts) {
    countVarRefsInStmt(s, bump);
  }
  return counts;
}

/** Count Var occurrences for `s` — including expressions inside
 *  nested If/While/For bodies, since a variable defined at this
 *  level is "used" if it's read in any nested scope. */
function countVarRefsInStmt(s: IRStmt, bump: (cName: string) => void): void {
  switch (s.kind) {
    case "Assign":
      forEachSubExpr(s.rhs, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      return;
    case "ExprStmt":
      forEachSubExpr(s.expr, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      return;
    case "Disp":
    case "Error":
      forEachSubExpr(s.arg, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      return;
    case "Assert":
      forEachSubExpr(s.cond, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      if (s.msg !== null) {
        forEachSubExpr(s.msg, e => {
          if (e.kind === "Var") bump(e.cName);
        });
      }
      return;
    case "Fprintf":
      forEachSubExpr(s.fmt, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      for (const a of s.args) {
        forEachSubExpr(a, e => {
          if (e.kind === "Var") bump(e.cName);
        });
      }
      return;
    case "If":
      forEachSubExpr(s.cond, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      for (const eif of s.elseifs) {
        forEachSubExpr(eif.cond, e => {
          if (e.kind === "Var") bump(e.cName);
        });
        for (const t of eif.body) countVarRefsInStmt(t, bump);
      }
      for (const t of s.thenBody) countVarRefsInStmt(t, bump);
      if (s.elseBody) {
        for (const t of s.elseBody) countVarRefsInStmt(t, bump);
      }
      return;
    case "While":
      forEachSubExpr(s.cond, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      for (const t of s.body) countVarRefsInStmt(t, bump);
      return;
    case "For":
      forEachSubExpr(s.start, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      forEachSubExpr(s.step, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      forEachSubExpr(s.end, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      for (const t of s.body) countVarRefsInStmt(t, bump);
      return;
    case "MultiAssignCall":
      for (const a of s.args) {
        forEachSubExpr(a, e => {
          if (e.kind === "Var") bump(e.cName);
        });
      }
      return;
    case "IndexStore":
      // Base is a Var read (read of struct handle) — count it.
      bump(s.base.cName);
      for (const idx of s.indices) {
        forEachSubExpr(idx, e => {
          if (e.kind === "Var") bump(e.cName);
        });
      }
      forEachSubExpr(s.rhs, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      return;
    case "IndexSliceStore":
      bump(s.base.cName);
      for (const slot of s.index) {
        if (slot.kind === "Range") {
          forEachSubExpr(slot.start, e => {
            if (e.kind === "Var") bump(e.cName);
          });
          forEachSubExpr(slot.step, e => {
            if (e.kind === "Var") bump(e.cName);
          });
          forEachSubExpr(slot.end, e => {
            if (e.kind === "Var") bump(e.cName);
          });
        } else if (slot.kind === "Scalar") {
          forEachSubExpr(slot.expr, e => {
            if (e.kind === "Var") bump(e.cName);
          });
        }
      }
      forEachSubExpr(s.rhs, e => {
        if (e.kind === "Var") bump(e.cName);
      });
      return;
    case "Break":
    case "Continue":
      return;
    case "ReturnFromFunction":
      // Each output cName is read by the return.
      for (const c of s.outputCNames) bump(c);
      return;
  }
}

/** Predicate (gate 1+2): the producer is a multi-element real-double
 *  Assign whose RHS is pure elementwise (no owned producers,
 *  no user-fn or direct-owned-builtin calls). */
function isInlinableProducer(s: IRStmt): boolean {
  if (s.kind !== "Assign") return false;
  if (!isNumeric(s.ty)) return false;
  if (s.ty.elem !== "double") return false;
  if (s.ty.isComplex) return false;
  if (!isMultiElement(s.ty)) return false;
  return isPureElementwiseExpr(s.rhs);
}

/** Returns true iff `e` is composed entirely of pure scalar / elementwise
 *  node kinds. No owned producers (TensorLit, IndexSlice), no user-fn
 *  or non-elementwise-builtin calls. IndexLoad is OK (scalar read). */
function isPureElementwiseExpr(e: IRExpr): boolean {
  switch (e.kind) {
    case "NumLit":
    case "ImagLit":
    case "Var":
    case "EndRef":
      return true;
    case "Binary":
      return isPureElementwiseExpr(e.left) && isPureElementwiseExpr(e.right);
    case "Unary":
      return isPureElementwiseExpr(e.operand);
    case "Call": {
      // Only elementwise builtins. A "direct-owned" Call returns an
      // owned tensor by value (transpose, reshape, sum...) and is
      // NOT inlinable — its iter-slot semantics differ from the
      // consumer's, or it allocates.
      if (e.callee.kind !== "builtin") return false;
      if (e.callee.sig.producesOwnedDirectly === true) return false;
      return e.args.every(isPureElementwiseExpr);
    }
    case "IndexLoad":
      // The base is a Var read of a struct handle; we don't recurse
      // into it (its cName appears as `base.cName` which is a
      // non-slot position — gate 4 handles that). Indices are
      // scalar expressions; recurse for purity.
      return e.indices.every(isPureElementwiseExpr);
    case "TensorLit":
    case "IndexSlice":
    case "StringLit":
    case "CharLit":
      return false;
  }
}

/** Predicate (gate 5+6): the consumer is a multi-element real-double
 *  Assign whose RHS goes through the elementwise-loop emit path AND
 *  has compatible shape with the producer for flat-iter fusion. */
function isInlinableConsumer(
  s: IRStmt,
  producer: Extract<IRStmt, { kind: "Assign" }>
): boolean {
  if (s.kind !== "Assign") return false;
  if (!isNumeric(s.ty)) return false;
  if (s.ty.elem !== "double") return false;
  if (s.ty.isComplex) return false;
  if (!isMultiElement(s.ty)) return false;

  // RHS must go through emitTensorAssignFromExpr (not TensorLit,
  // Var, IndexSlice, direct-owned-Call).
  const rhs = s.rhs;
  if (rhs.kind === "TensorLit") return false;
  if (rhs.kind === "Var") return false;
  if (rhs.kind === "IndexSlice") return false;
  if (rhs.kind === "Call") {
    if (
      rhs.callee.kind === "userFunc" ||
      (rhs.callee.kind === "builtin" &&
        rhs.callee.sig.producesOwnedDirectly === true)
    ) {
      return false;
    }
  }

  // MVP same-shape gate: producer's output static shape must equal
  // the consumer's output shape AND every multi-element operand on
  // the consumer's RHS (excluding the producer's cName, which we'll
  // replace) must share that shape. After substitution the fused
  // RHS will have the producer's operands plus the consumer's
  // other operands — they all need to be same-shape for flat-iter.
  const prodTy = producer.ty as NumericType;
  const consTy = s.ty as NumericType;
  if (!sameStaticShape(prodTy, consTy)) return false;
  // Producer's RHS operands all need to share that shape too.
  let ok = true;
  forEachSubExpr(producer.rhs, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty)) {
      if (!isNumeric(sub.ty) || !sameStaticShape(prodTy, sub.ty)) ok = false;
    }
  });
  if (!ok) return false;
  // Consumer's other multi-elem operands need to share too.
  forEachSubExpr(rhs, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty)) {
      if (sub.cName === producer.cName) return;
      if (!isNumeric(sub.ty) || !sameStaticShape(prodTy, sub.ty)) ok = false;
    }
  });
  return ok;
}

/** Static-shape equality under the dim lattice. */
function sameStaticShape(a: NumericType, b: NumericType): boolean {
  if (a.dims.length !== b.dims.length) return false;
  for (let i = 0; i < a.dims.length; i++) {
    if (a.dims[i].kind !== b.dims[i].kind) return false;
  }
  return true;
}

/** Free Var cNames in `e`. Used to detect intervening writes that
 *  would invalidate fusion. */
function collectFreeVarCNames(e: IRExpr): Set<string> {
  const out = new Set<string>();
  forEachSubExpr(e, sub => {
    if (sub.kind === "Var") out.add(sub.cName);
  });
  return out;
}

/** True iff `s` writes to `cName` or to any name in `freeVars`.
 *  "Writes" means LHS of an Assign, base of an IndexStore /
 *  IndexSliceStore, or an output slot of a MultiAssignCall. */
function stmtWritesAny(
  s: IRStmt,
  cName: string,
  freeVars: ReadonlySet<string>
): boolean {
  if (s.kind === "Assign") {
    if (s.cName === cName) return true;
    if (freeVars.has(s.cName)) return true;
    return false;
  }
  if (s.kind === "IndexStore") {
    return s.base.cName === cName || freeVars.has(s.base.cName);
  }
  if (s.kind === "IndexSliceStore") {
    return s.base.cName === cName || freeVars.has(s.base.cName);
  }
  if (s.kind === "MultiAssignCall") {
    for (const o of s.outputs) {
      if (o.binding === null) continue;
      if (o.binding.cName === cName) return true;
      if (freeVars.has(o.binding.cName)) return true;
    }
    return false;
  }
  return false;
}

/** True iff `s` reads `cName` as a multi-element Var (in any
 *  iter-slot or struct-handle position). Used to detect the unique
 *  consumer in the forward scan. */
function stmtReadsAsMultiElemVar(s: IRStmt, cName: string): boolean {
  let found = false;
  const visit = (e: IRExpr) => {
    forEachSubExpr(e, sub => {
      if (sub.kind === "Var" && sub.cName === cName && isMultiElement(sub.ty)) {
        found = true;
      }
    });
  };
  switch (s.kind) {
    case "Assign":
      visit(s.rhs);
      break;
    case "ExprStmt":
      visit(s.expr);
      break;
    case "Disp":
    case "Error":
      visit(s.arg);
      break;
    case "Assert":
      visit(s.cond);
      if (s.msg !== null) visit(s.msg);
      break;
    case "Fprintf":
      visit(s.fmt);
      for (const a of s.args) visit(a);
      break;
    case "MultiAssignCall":
      for (const a of s.args) visit(a);
      break;
    case "IndexStore":
      if (s.base.cName === cName) found = true;
      for (const i of s.indices) visit(i);
      visit(s.rhs);
      break;
    case "IndexSliceStore":
      if (s.base.cName === cName) found = true;
      for (const slot of s.index) {
        if (slot.kind === "Range") {
          visit(slot.start);
          visit(slot.step);
          visit(slot.end);
        } else if (slot.kind === "Scalar") {
          visit(slot.expr);
        }
      }
      visit(s.rhs);
      break;
    case "If":
    case "While":
    case "For":
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      // Control-flow stmts: the forward scan bails before reaching
      // them (gate 7). Even if reached, conservative answer is
      // "no, not consumed here," which keeps the consumer search
      // from settling on a control-flow site.
      break;
  }
  return found;
}

/** True iff `cName` appears anywhere in `e` in a position that the
 *  Var-substitution will NOT reach: as `IndexLoad.base`,
 *  `IndexSlice.base`, or inside a `TensorLit` cell. (Substitution
 *  rewrites every Var occurrence reachable by descending Binary/
 *  Unary/Call/IndexLoad.indices/IndexSlice.index — but NOT base
 *  positions, since those are struct handles, not iter-slot
 *  reads.) */
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
      // Any reference inside a literal cell counts (substitution
      // doesn't descend into TensorLit cells).
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

/** Pure tree rewrite: replace every `Var(cName === target)` in `e`
 *  with `replacement`. Does NOT descend into IndexLoad/IndexSlice
 *  base positions (struct-handle reads — the producer's never-
 *  populated handle would be dereferenced). Does NOT descend into
 *  TensorLit cells (conservative; future extension). Preserves
 *  identity for unchanged subtrees so the substitution is cheap
 *  when nothing matches. */
function substituteVar(e: IRExpr, target: string, replacement: IRExpr): IRExpr {
  switch (e.kind) {
    case "Var":
      return e.cName === target ? replacement : e;
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "EndRef":
    case "TensorLit":
    case "IndexSlice":
      return e;
    case "Binary": {
      const left = substituteVar(e.left, target, replacement);
      const right = substituteVar(e.right, target, replacement);
      if (left === e.left && right === e.right) return e;
      return { ...e, left, right };
    }
    case "Unary": {
      const operand = substituteVar(e.operand, target, replacement);
      if (operand === e.operand) return e;
      return { ...e, operand };
    }
    case "Call": {
      let changed = false;
      const newArgs = e.args.map(a => {
        const sub = substituteVar(a, target, replacement);
        if (sub !== a) changed = true;
        return sub;
      });
      if (!changed) return e;
      return { ...e, args: newArgs };
    }
    case "IndexLoad": {
      // Don't touch the base. Indices can be substituted.
      let changed = false;
      const newIndices = e.indices.map(i => {
        const sub = substituteVar(i, target, replacement);
        if (sub !== i) changed = true;
        return sub;
      });
      if (!changed) return e;
      return { ...e, indices: newIndices };
    }
  }
}
