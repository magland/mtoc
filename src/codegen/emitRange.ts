/**
 * `MakeRange` codegen.
 *
 * Bare `a:b` / `a:s:b` used as a value (not as a for-loop iterable,
 * not as an index slot) lowers to a `MakeRange` IR node. The dedicated
 * emitter here materializes the 1×n row-vector tensor via the
 * `mtoc_make_range` runtime helper, then consume-replaces the target
 * with `mtoc_tensor_assign`. Wrapped in `{}` so the staging local is
 * scoped per Assign.
 */

import type { IRExpr } from "../lowering/ir.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import { emitExpr } from "./emitExpr.js";

export function emitMakeRangeAssign(
  state: EmitState,
  level: number,
  target: string,
  rhs: Extract<IRExpr, { kind: "MakeRange" }>
): void {
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");
  useRuntimeByName(state, "mtoc_make_range");
  const startStr = emitExpr(state, rhs.start, 0);
  const stepStr = emitExpr(state, rhs.step, 0);
  const endStr = emitExpr(state, rhs.end, 0);
  pushStmt(
    state,
    level,
    `mtoc_tensor_assign(&${target}, ` +
      `mtoc_make_range(${startStr}, ${stepStr}, ${endStr}));`
  );
}
