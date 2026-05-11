/**
 * Index-read lowering: `v(i)` / `M(i, j)` / `v(end)` / `M(end, end)`.
 *
 * The lowerer reaches this helper from `lowerFuncCall` whenever the
 * `name` of a `FuncCall` resolves to a variable in scope (MATLAB's
 * "workspace shadows functions" rule). Today only scalar reads are
 * supported — every index expression must lower to a real scalar; a
 * range or colon index belongs on a future `IndexSlice` IR node.
 *
 * For each index slot the helper pushes an `end` context onto the
 * Lowerer's `endStack` so an `end` token inside the slot resolves
 * to the right axis size of the base. Linear (one-index) addressing
 * resolves `end` to `numel(base)`; 2D (two-index) addressing
 * resolves slot 0 to `rows(base)` and slot 1 to `cols(base)`,
 * matching MATLAB semantics.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isScalarReal,
  scalarChar,
  scalarComplex,
  scalarDouble,
  typeToString,
  type MType,
} from "./types.js";
import type { Lowerer } from "./lower.js";
import { resolveIndexBase } from "./indexResolve.js";

/** Lower an index-read of an in-scope variable.
 *
 *  - 1 index  → linear addressing into a multi-element tensor.
 *  - 2 indices → 2D row/col addressing; valid for any multi-element shape.
 *  - 0 or >2 indices → rejected with a span.
 *  - Indexing a scalar (MATLAB's `x(1)` returning `x`) is deferred. */
export function lowerIndexLoad(
  this: Lowerer,
  name: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const { baseTy, baseCName, base } = resolveIndexBase.call(
    this,
    name,
    argExprs.length,
    span,
    { allowCharArray: true, notInScope: "internal", operation: "read" }
  );

  const indices: IRExpr[] = [];
  const numSlots = argExprs.length;
  for (let slot = 0; slot < numSlots; slot++) {
    const axis: number | "linear" = numSlots === 1 ? "linear" : slot;
    this.endStack.push({ baseCName, baseTy, axis });
    let lowered: IRExpr;
    try {
      lowered = this.lowerExpr(argExprs[slot]);
    } finally {
      this.endStack.pop();
    }
    if (!isScalarReal(lowered.ty)) {
      throw new TypeError(
        `index ${slot + 1} of '${name}' must be a real scalar ` +
          `(got ${typeToString(lowered.ty)}); range and colon indices are ` +
          `not yet supported`,
        argExprs[slot].span
      );
    }
    indices.push(lowered);
  }

  // Result type tracks the base's element kind / complexity. Sign is
  // unknown — the indexed element is one specific value out of a
  // tensor whose per-element sign we don't track.
  const resultTy: MType =
    baseTy.elem === "char"
      ? scalarChar()
      : baseTy.isComplex
        ? scalarComplex()
        : scalarDouble("unknown");

  return {
    kind: "IndexLoad",
    base,
    indices,
    ty: resultTy,
    span,
  };
}
