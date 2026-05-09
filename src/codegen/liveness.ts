/**
 * Backward dataflow over the lowered IR computing per-statement
 * "future-touch" sets for owned-heap-value variables — currently
 * multi-element tensors and strings (see `isOwned` in types.ts). An
 * owned `v`'s future-touch set at statement `s` is the union of vars
 * touched (read OR written) by any successor of `s` in the structured
 * CFG. Drives the "early free" emission in `emit.ts`: an owned `v`
 * whose last touch is statement `s` (i.e. `v` is in
 * `(uses ∪ defs)(s)` but NOT in `futureTouchOut(s)`) gets a free
 * call (`mtoc_tensor_free` / `mtoc_string_free`, picked from `v`'s
 * type) immediately after `s`'s C output, rather than waiting for
 * scope exit.
 *
 * Why "touch" (uses ∪ defs) rather than standard liveness (just uses,
 * with kill on def)? A reassignment `v = …;` lowers to
 * `mtoc_tensor_assign(&v, …)` / `mtoc_string_assign(&v, …)`, both of
 * which already release the prior buffer. So if `v`'s next statement-
 * level interaction is a reassignment, the early free at the previous
 * use would be redundant — better to let the assign helper handle it.
 * The future-touch set captures exactly that: a redef counts as a
 * future touch and suppresses the early-free emission, just like a
 * future use does.
 *
 * Only owned variables are tracked; scalar `double` /
 * `double _Complex` locals live in C automatic storage and have no
 * heap to release.
 *
 * The IR is structured (no goto), so the analysis is structural
 * recursion. Loops (`While`, `For`) are resolved by fixpoint over the
 * body's "after-body-last" set; `Break` / `Continue` /
 * `ReturnFromFunction` consult the enclosing context for their
 * target's future touches.
 *
 * Conservative model:
 *   - The fall-through end of a function body has future-touch ∅
 *     (the scalar return value is stored in a non-owned `outputCName`).
 *   - The end of `main` has future-touch ∅.
 *   - A `ReturnFromFunction` jumps to the function exit — future
 *     touch ∅ (no further statements run on this path).
 *   - Loops may run zero times: `futureTouchIn(While/For)` includes
 *     `futureTouchOut(While/For)` directly.
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import { isOwned } from "../lowering/types.js";
import { forEachSubExpr, forEachTopLevelExpr } from "../lowering/walk.js";

/** Per-statement future-touch sets, keyed by the IRStmt object
 *  reference. Each entry holds the set of owned C-names that may be
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
   *  empty for owned-value liveness today — function returns are
   *  scalars. Kept as a field so the recursion threads through it
   *  cleanly in case we ever support owned-value returns. */
  readonly returnOut: ReadonlySet<string>;
  /** Mutated map of per-statement future-touch sets (the analysis
   *  output). */
  readonly futureTouchOut: Map<IRStmt, ReadonlySet<string>>;
}

/** Owned C-names referenced by an IR expression. Only owned `Var`
 *  nodes contribute; scalars and literals do not. CharLit is a
 *  non-owning handle (.rodata or bare char) and contributes nothing. */
export function collectOwnedVarsInExpr(e: IRExpr, out: Set<string>): void {
  forEachSubExpr(e, sub => {
    if (sub.kind === "Var" && isOwned(sub.ty)) out.add(sub.cName);
  });
}

/** Top-level owned uses for a statement — the owned vars read by the
 *  statement at its own level, NOT including its body (control-flow
 *  body uses are accounted for in the body's per-stmt future-touch
 *  results). Used by `emit.ts` to compute "free after this stmt"
 *  candidates as `(uses(s) ∪ defs(s)) - futureTouchOut(s)`.
 *
 *  `MultiAssignCall` args contribute the same way `Call` args do
 *  through `Assign.rhs` — user-function calls copy each tensor/char
 *  arg at the call site, but the read of the source still counts as
 *  a touch for the future-touch dataflow. */
export function topLevelOwnedUses(s: IRStmt): Set<string> {
  const out = new Set<string>();
  forEachTopLevelExpr(s, e => collectOwnedVarsInExpr(e, out));
  return out;
}

/** Top-level owned defs for a statement — `Assign` to an owned-typed
 *  variable contributes; so does any non-null owned-typed slot of a
 *  `MultiAssignCall`. (The latter is structural: today's user-
 *  function outputs must be scalars and so are never owned, but the
 *  pattern matches `Assign` for the day they can be.) The assigned
 *  C-name is the variable's predeclared identifier (in main /
 *  function scope). */
export function topLevelOwnedDefs(s: IRStmt): Set<string> {
  const out = new Set<string>();
  if (s.kind === "Assign" && isOwned(s.ty)) {
    out.add(s.cName);
  } else if (s.kind === "MultiAssignCall") {
    for (const slot of s.outputs) {
      if (slot.binding !== null && isOwned(slot.ty)) {
        out.add(slot.binding.cName);
      }
    }
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
    case "Error":
    case "MultiAssignCall":
    case "IndexStore":
    case "IndexSliceStore": {
      const out = new Set(futureAfter);
      unionInto(out, topLevelOwnedUses(s));
      unionInto(out, topLevelOwnedDefs(s));
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
      unionInto(out, topLevelOwnedUses(s));
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
      // Lattice is finite (subsets of all owned vars); fixpoint
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
        // scalars in our subset, so empty for owned-value liveness.)
        const newBodyAfter = new Set<string>(futureAfter);
        unionInto(newBodyAfter, bodyIn);
        unionInto(newBodyAfter, topLevelOwnedUses(s));
        if (setEquals(newBodyAfter, bodyAfter)) break;
        bodyAfter = newBodyAfter;
      }
      const out = new Set(bodyAfter);
      unionInto(out, topLevelOwnedUses(s));
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
 *  The body's fall-through future-touch is `EMPTY` for owned-value
 *  liveness — no owned value outlives `main` or a function body. */
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
