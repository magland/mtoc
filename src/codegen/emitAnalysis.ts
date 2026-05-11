/**
 * Pre-emission analysis helpers for the statement-level codegen.
 *
 * - `analyzeStmts`: pre-walk that flips header flags for every
 *   `analyzeExpr` reachable from a stmt tree.
 * - `deadAfterStmt` / `emitEarlyFrees`: liveness-driven free emission
 *   anchored to one stmt's program point.
 * - `formatArgInit`: renders a single fprintf/sprintf value arg as a
 *   `mtoc_fprintf_arg_t` designated-initializer expression.
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import {
  isCharScalar,
  isMultiElement,
  isNumeric,
  isScalarComplex,
  isScalarReal,
  isText,
  typeToString,
} from "../lowering/types.js";
import { forEachStmtInTree, forEachTopLevelExpr } from "../lowering/walk.js";
import { topLevelOwnedDefs, topLevelOwnedUses } from "./liveness.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import { analyzeExpr, emitExpr, wrapTextView } from "./emitExpr.js";

/**
 * Statement-level companion to `analyzeExpr`. Visits every stmt in the
 * tree (parents before bodies via `forEachStmtInTree`), runs
 * `analyzeExpr` over each stmt's directly-held expressions, and sets
 * `needMath` for stmt kinds whose codegen always emits a math.h call:
 *   - For: the iteration-count formula uses `floor()`.
 *   - MultiAssignCall: mirrors the `Call` case in `analyzeExpr` —
 *     every user-function call we currently emit pulls in <math.h>.
 */
export function analyzeStmts(
  state: EmitState,
  stmts: ReadonlyArray<IRStmt>
): void {
  forEachStmtInTree(stmts, s => {
    if (s.kind === "For" || s.kind === "MultiAssignCall") {
      state.needMath.value = true;
    }
    forEachTopLevelExpr(s, e => analyzeExpr(state, e));
  });
}

/** Owned C-names (tensors and strings) that should be freed
 *  immediately after `s`, computed from the future-touch set produced
 *  by the dataflow pass. A name is "dead-after" iff it appears in
 *  `s`'s top-level uses or defs but is NOT touched (read or written)
 *  at any successor — i.e. `s` was its last touch on this level.
 *  Returns sorted (stable C output) and excludes names already freed
 *  on this linear path. */
export function deadAfterStmt(state: EmitState, s: IRStmt): string[] {
  if (state.futureTouches === null) return [];
  const futureTouchOut = state.futureTouches.get(s);
  if (futureTouchOut === undefined) return [];
  const touched = topLevelOwnedUses(s);
  for (const d of topLevelOwnedDefs(s)) touched.add(d);
  const out: string[] = [];
  for (const v of touched) {
    if (futureTouchOut.has(v)) continue;
    if (state.freedOwned.has(v)) continue;
    out.push(v);
  }
  out.sort();
  return out;
}

/** Emit a free line for every name in `vars`, picking the appropriate
 *  free helper from the owned-kind registry for each variable's type
 *  (`mtoc_tensor_free` / `mtoc_char_tensor_free` / `mtoc_string_free`),
 *  mark them as freed on the current linear path, and activate the
 *  matching helper snippet on first use. The caller has already
 *  filtered against the current `freedOwned` set (see
 *  `deadAfterStmt`). */
export function emitEarlyFrees(
  state: EmitState,
  level: number,
  vars: ReadonlyArray<string>
): void {
  if (vars.length === 0) return;
  if (state.currentScopeVars === null) {
    throw new Error(
      "codegen internal: emitEarlyFrees called outside an emission scope"
    );
  }
  for (const v of vars) {
    const binding = state.currentScopeVars.get(v);
    if (binding === undefined) {
      throw new Error(
        `codegen internal: early-free for unknown var '${v}'; ` +
          `not in the current scope's free-on-exit set`
      );
    }
    const owned = ownedOps(binding.ty);
    if (owned === null) {
      throw new Error(
        `codegen internal: early-free for non-owned var '${v}' ` +
          `(${typeToString(binding.ty)})`
      );
    }
    useRuntimeByName(state, owned.free);
    pushStmt(state, level, `${owned.free}(&${v});`);
    state.freedOwned.add(v);
  }
}

/** Render a single fprintf / sprintf value arg as a `mtoc_fprintf_arg_t`
 *  designated-initializer expression. Dispatches on the arg's static
 *  type — text views go through the existing `mtoc_text_from_*`
 *  adapters; scalar numerics promote to `double` (scalar char widens
 *  to its numeric value); complex scalars pass through unchanged;
 *  multi-element tensors travel as a pointer to the caller's
 *  predeclared `mtoc_tensor_t` local. Wrapping owned-producing RHS
 *  forms in arg position is moot — the surrounding lowering rejects
 *  anything but a Var / literal here. */
export function formatArgInit(state: EmitState, e: IRExpr): string {
  // Activate the format-engine umbrella so the tag enums + struct
  // definition are in scope at the call site. `mtoc_fprintf` /
  // `mtoc_sprintf` callers have already activated their own
  // umbrella, but doing it here keeps this helper self-contained
  // for any future statement that calls it directly.
  useRuntimeByName(state, "mtoc_format_engine");
  const ty = e.ty;
  const c = emitExpr(state, e, 0);
  if (isText(ty)) {
    const view = wrapTextView(state, ty, c);
    return `{.kind=MTOC_FA_TEXT, .u.t=${view}}`;
  }
  if (isScalarComplex(ty)) {
    return `{.kind=MTOC_FA_COMPLEX, .u.z=${c}}`;
  }
  if (isCharScalar(ty)) {
    // Scalar char promotes to its code-unit value for numeric specs
    // (matches numbl's toNumber on a 1-char RuntimeChar). %s of a
    // scalar char isn't supported in v1 — the test corpus doesn't
    // hit it.
    return `{.kind=MTOC_FA_DOUBLE, .u.d=(double)(unsigned char)(${c})}`;
  }
  if (isScalarReal(ty)) {
    return `{.kind=MTOC_FA_DOUBLE, .u.d=${c}}`;
  }
  if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
    useRuntimeByName(state, "mtoc_tensor_t");
    // Post-ANF, every tensor-typed arg here is a `Var` (or an
    // already-rendered owned producer that ANF hoisted into one);
    // emitExpr renders it as the bare struct cName, so `&<cName>`
    // is a valid pointer to the caller's stack-allocated handle.
    return `{.kind=MTOC_FA_TENSOR, .u.tensor=&${c}}`;
  }
  throw new Error(
    `codegen internal: fprintf/sprintf arg with unsupported type ` +
      `${typeToString(ty)} reached formatArgInit (should have been ` +
      `rejected at lowering)`
  );
}
