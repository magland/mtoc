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
import { typeToString } from "../lowering/types.js";
import { forEachStmtInTree, forEachTopLevelExpr } from "../lowering/walk.js";
import { renderFprintfArgInit } from "../workspace/builtins.js";
import { topLevelOwnedDefs, topLevelOwnedUses } from "./liveness.js";
import { ownedOps } from "./ownedKinds.js";
import {
  builtinEmitFacade,
  pushStmt,
  useRuntimeByName,
  type EmitState,
} from "./emitState.js";
import { analyzeExpr, emitExpr } from "./emitExpr.js";

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
 *  designated-initializer expression — thin wrapper that renders `e`
 *  to a C expression then delegates to `renderFprintfArgInit` (the
 *  single source of truth for the format-arg ABI, in `builtins.ts`).
 *  The sprintf one-shot sig's emit closure calls `renderFprintfArgInit`
 *  directly with its already-rendered arg strings.
 *
 *  Post-ANF, every tensor-typed arg here is a `Var` (or an already-
 *  hoisted owned producer rendered as one), so `&<cName>` is a valid
 *  pointer to the caller's stack-allocated handle. */
export function formatArgInit(state: EmitState, e: IRExpr): string {
  const c = emitExpr(state, e, 0);
  return renderFprintfArgInit(builtinEmitFacade(state), e.ty, c);
}
