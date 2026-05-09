/**
 * Backward dataflow over the lowered IR computing per-statement
 * "future-touch" sets for tensor-typed variables. A tensor `v`'s
 * future-touch set at statement `s` is the union of vars touched (read
 * OR written) by any successor of `s` in the structured CFG. Drives
 * the "early free" emission in `emit.ts`: a tensor `v` whose last
 * touch is statement `s` (i.e. `v` is in `(uses ∪ defs)(s)` but NOT
 * in `futureTouchOut(s)`) gets a `mtoc_tensor_free(&v);` immediately
 * after `s`'s C output, rather than waiting for scope exit.
 *
 * Why "touch" (uses ∪ defs) rather than standard liveness (just uses,
 * with kill on def)? A reassignment `v = …;` lowers to
 * `mtoc_tensor_assign(&v, …)`, which already releases the prior
 * buffer. So if `v`'s next statement-level interaction is a
 * reassignment, the early free at the previous use would be redundant
 * — better to let `mtoc_tensor_assign` handle it. The future-touch
 * set captures exactly that: a redef counts as a future touch and
 * suppresses the early-free emission, just like a future use does.
 *
 * Only tensor (multi-element numeric) variables are tracked; scalar
 * `double` / `double _Complex` locals live in C automatic storage and
 * have no heap to release.
 *
 * The IR is structured (no goto), so the analysis is structural
 * recursion. Loops (`While`, `For`) are resolved by fixpoint over the
 * body's "after-body-last" set; `Break` / `Continue` /
 * `ReturnFromFunction` consult the enclosing context for their
 * target's future touches.
 *
 * Conservative model:
 *   - The fall-through end of a function body has future-touch ∅
 *     (the scalar return value is stored in a non-tensor `outputCName`).
 *   - The end of `main` has future-touch ∅.
 *   - A `ReturnFromFunction` jumps to the function exit — future
 *     touch ∅ (no further statements run on this path).
 *   - Loops may run zero times: `futureTouchIn(While/For)` includes
 *     `futureTouchOut(While/For)` directly.
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import { isMultiElement, isNumeric } from "../lowering/types.js";

/** Per-statement future-touch sets, keyed by the IRStmt object
 *  reference. Each entry holds the set of tensor C-names that may be
 *  touched (read or written) at any successor of the statement. */
export type FutureTouchMap = ReadonlyMap<IRStmt, ReadonlySet<string>>;

interface TouchCtx {
  /** Future touches reachable from a `Break` statement (the
   *  post-loop point). */
  readonly breakOut: ReadonlySet<string>;
  /** Future touches reachable from a `Continue` statement (the loop
   *  header — drives one more iteration plus the exit path). */
  readonly continueOut: ReadonlySet<string>;
  /** Future touches reachable from a `ReturnFromFunction`. Always
   *  empty for tensor liveness — function returns are scalars. Kept
   *  as a field so the recursion threads through it cleanly in case
   *  we ever support tensor returns. */
  readonly returnOut: ReadonlySet<string>;
  /** Mutated map of per-statement future-touch sets (the analysis
   *  output). */
  readonly futureTouchOut: Map<IRStmt, ReadonlySet<string>>;
}

/** Tensor C-names referenced by an IR expression. Only multi-element
 *  numeric `Var` nodes contribute; scalars and literals do not. */
export function collectTensorVarsInExpr(e: IRExpr, out: Set<string>): void {
  switch (e.kind) {
    case "Var":
      if (isNumeric(e.ty) && isMultiElement(e.ty)) out.add(e.cName);
      return;
    case "Binary":
      collectTensorVarsInExpr(e.left, out);
      collectTensorVarsInExpr(e.right, out);
      return;
    case "Unary":
      collectTensorVarsInExpr(e.operand, out);
      return;
    case "Call":
      for (const a of e.args) collectTensorVarsInExpr(a, out);
      return;
    case "TensorLit":
      for (const row of e.elements)
        for (const c of row) {
          collectTensorVarsInExpr(c, out);
        }
      return;
    case "NumLit":
    case "ImagLit":
    case "StringLit":
      return;
  }
}

/** Top-level tensor uses for a statement — the tensor vars read by the
 *  statement at its own level, NOT including its body (control-flow
 *  body uses are accounted for in the body's per-stmt future-touch
 *  results). Used by `emit.ts` to compute "free after this stmt"
 *  candidates as `(uses(s) ∪ defs(s)) - futureTouchOut(s)`. */
export function topLevelTensorUses(s: IRStmt): Set<string> {
  const out = new Set<string>();
  switch (s.kind) {
    case "Assign":
      collectTensorVarsInExpr(s.rhs, out);
      return out;
    case "ExprStmt":
      collectTensorVarsInExpr(s.expr, out);
      return out;
    case "Disp":
      collectTensorVarsInExpr(s.arg, out);
      return out;
    case "Error":
      collectTensorVarsInExpr(s.arg, out);
      return out;
    case "If":
      collectTensorVarsInExpr(s.cond, out);
      for (const eif of s.elseifs) collectTensorVarsInExpr(eif.cond, out);
      return out;
    case "While":
      collectTensorVarsInExpr(s.cond, out);
      return out;
    case "For":
      collectTensorVarsInExpr(s.start, out);
      collectTensorVarsInExpr(s.step, out);
      collectTensorVarsInExpr(s.end, out);
      return out;
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return out;
  }
}

/** Top-level tensor defs for a statement — only an `Assign` to a
 *  tensor-typed variable contributes. The assigned C-name is the
 *  variable's predeclared identifier (in main / function scope). */
export function topLevelTensorDefs(s: IRStmt): Set<string> {
  const out = new Set<string>();
  if (s.kind === "Assign" && isNumeric(s.ty) && isMultiElement(s.ty)) {
    out.add(s.cName);
  }
  return out;
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function unionInto(target: Set<string>, src: ReadonlySet<string>): void {
  for (const v of src) target.add(v);
}

/** Compute the future-touch set "before stmts[0]" given the
 *  future-touch set "after stmts[last]". Walks backward, recording
 *  each stmt's `futureTouchOut` (= the future-touch set after that
 *  stmt's program point) into `ctx.futureTouchOut`. */
function touchSeq(
  stmts: ReadonlyArray<IRStmt>,
  futureAfter: ReadonlySet<string>,
  ctx: TouchCtx
): Set<string> {
  let carry: Set<string> = new Set(futureAfter);
  for (let i = stmts.length - 1; i >= 0; i--) {
    const s = stmts[i];
    ctx.futureTouchOut.set(s, new Set(carry));
    carry = touchStmt(s, carry, ctx);
  }
  return carry;
}

function touchStmt(
  s: IRStmt,
  futureAfter: ReadonlySet<string>,
  ctx: TouchCtx
): Set<string> {
  switch (s.kind) {
    case "Assign":
    case "ExprStmt":
    case "Disp":
    case "Error": {
      const out = new Set(futureAfter);
      unionInto(out, topLevelTensorUses(s));
      unionInto(out, topLevelTensorDefs(s));
      return out;
    }
    case "If": {
      // Each arm contributes touches reachable from inside it. The
      // implicit-else fall-through arm contributes `futureAfter`
      // straight through. Top-level cond uses (main + elseifs) are
      // touched at the if-stmt itself before any arm runs.
      const armIns: ReadonlySet<string>[] = [];
      armIns.push(touchSeq(s.thenBody, futureAfter, ctx));
      for (const eif of s.elseifs) {
        armIns.push(touchSeq(eif.body, futureAfter, ctx));
      }
      armIns.push(
        s.elseBody
          ? touchSeq(s.elseBody, futureAfter, ctx)
          : new Set(futureAfter)
      );
      const out = new Set(futureAfter);
      for (const a of armIns) unionInto(out, a);
      unionInto(out, topLevelTensorUses(s));
      return out;
    }
    case "While":
    case "For": {
      // Fixpoint on the "after-body-last" set. After body[last],
      // control either returns to the loop header (continue) or
      // exits to `futureAfter` (break / cond becomes false).
      // Either way, body[last]'s future-touch set must include the
      // touches in the next iteration plus `futureAfter`.
      let bodyAfter = new Set<string>(futureAfter);
      // Lattice is finite (subsets of all tensor vars); fixpoint
      // always converges. Cap iterations defensively to surface bugs
      // rather than hang.
      for (let iter = 0; iter < 64; iter++) {
        const innerCtx: TouchCtx = {
          ...ctx,
          breakOut: futureAfter,
          continueOut: bodyAfter,
        };
        const bodyIn = touchSeq(s.body, bodyAfter, innerCtx);
        // body[last]'s future-touch set = condUses ∪ touchIn(body[0])
        // ∪ futureAfter. (For `For`, condUses is start/step/end —
        // scalars in our subset, so empty for tensor liveness.)
        const newBodyAfter = new Set<string>(futureAfter);
        unionInto(newBodyAfter, bodyIn);
        unionInto(newBodyAfter, topLevelTensorUses(s));
        if (setEquals(newBodyAfter, bodyAfter)) break;
        bodyAfter = newBodyAfter;
      }
      const out = new Set(bodyAfter);
      unionInto(out, topLevelTensorUses(s));
      return out;
    }
    case "Break":
      return new Set(ctx.breakOut);
    case "Continue":
      return new Set(ctx.continueOut);
    case "ReturnFromFunction":
      return new Set(ctx.returnOut);
  }
}

/** Compute per-statement future-touch sets for a body of statements.
 *  The body's fall-through future-touch is `EMPTY` for tensor
 *  liveness — no tensor outlives `main` or a function body. */
export function computeFutureTouches(
  stmts: ReadonlyArray<IRStmt>
): FutureTouchMap {
  const futureTouchOut = new Map<IRStmt, ReadonlySet<string>>();
  const empty: ReadonlySet<string> = new Set();
  const ctx: TouchCtx = {
    breakOut: empty,
    continueOut: empty,
    returnOut: empty,
    futureTouchOut,
  };
  touchSeq(stmts, empty, ctx);
  return futureTouchOut;
}
