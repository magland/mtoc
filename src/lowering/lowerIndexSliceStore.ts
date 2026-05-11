/**
 * Range / colon / scalar-mix indexed-write lowering: `v(a:b) = w`,
 * `v(:) = w`, `M(:, j) = w`, `T(:, i, :) = w`, … .
 *
 * Companion to `lowerIndexSlice` for slice writes. Same per-slot
 * lowering and arity rules: 1 slot (linear) or `ndim` slots (full
 * per-axis). The codegen runs a per-slot loop that mutates the base
 * buffer in place.
 *
 * RHS shapes:
 *   - tensor RHS: copied slot-by-slot into the slice. A runtime
 *     count check (numel(rhs) == count(slice)) protects against
 *     buffer overruns; emitted by codegen.
 *   - scalar RHS: broadcast — same value written into every slot.
 *
 * Type rules mirror `lowerIndexStore`:
 *   - real RHS into real base    → write `.real[off] = rhs;`
 *   - real RHS into complex base → write `.real = rhs; .imag = 0;`
 *     per slot (numbl semantics).
 *   - complex RHS into complex base → write both halves.
 *   - complex RHS into real base    → rejected at lowering with a span.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRStmt, IndexSliceArg } from "./ir.js";
import { isNumeric, isScalar, typeToString } from "./types.js";
import type { Lowerer } from "./lower.js";
import { lowerSliceArg } from "./lowerIndexSlice.js";
import { resolveIndexBase } from "./indexResolve.js";

/** Lower `<v>(slice) = <expr>` where the lvalue has at least one
 *  `Range` or bare `Colon` slot. */
export function lowerIndexSliceStore(
  this: Lowerer,
  lvalue: Extract<LValue, { type: "Index" }>,
  exprAst: Expr,
  span: Span
): IRStmt {
  if (lvalue.base.type !== "Ident") {
    throw new UnsupportedConstruct(
      `indexed assignment requires a simple variable on the left ` +
        `(got ${lvalue.base.type})`,
      span
    );
  }
  const name = lvalue.base.name;
  const { baseTy, baseCName, base } = resolveIndexBase.call(
    this,
    name,
    lvalue.indices.length,
    span,
    {
      baseSpan: lvalue.base.span,
      notInScope: "user-facing",
      operation: "sliceWrite",
    }
  );

  const isSingleSlot = lvalue.indices.length === 1;
  const slots: IndexSliceArg[] = [];
  for (let i = 0; i < lvalue.indices.length; i++) {
    const axis: number | "linear" = isSingleSlot ? "linear" : i;
    slots.push(
      lowerSliceArg.call(this, baseCName, baseTy, axis, lvalue.indices[i])
    );
  }

  // Lower the RHS — accepted shapes are scalar (broadcast) or any
  // multi-element tensor (copy, with a runtime count check).
  const rhs = this.lowerExpr(exprAst);
  if (!isNumeric(rhs.ty)) {
    throw new TypeError(
      `right-hand side of an indexed assignment must be numeric ` +
        `(got ${typeToString(rhs.ty)})`,
      exprAst.span
    );
  }
  if (rhs.ty.elem === "char") {
    throw new UnsupportedConstruct(
      `range/colon indexed write with a char-tensor RHS is not yet ` +
        `supported`,
      exprAst.span
    );
  }
  if (!baseTy.isComplex && rhs.ty.isComplex) {
    throw new TypeError(
      `cannot store a complex RHS into a real tensor '${name}' ` +
        `(would lose the imaginary part)`,
      span
    );
  }
  // Codegen accepts only a scalar (broadcast) or a Var (per-slot
  // copy) as RHS. A TensorLit / string-concat / IndexSlice / Binary
  // would either leak its temporary buffer or require materializing
  // an owned temp first; we ask the user to do that explicitly with
  // an intermediate assignment so the lifetime is named.
  if (!isScalar(rhs.ty) && rhs.kind !== "Var") {
    throw new UnsupportedConstruct(
      `right-hand side of a range/colon indexed write must be a scalar ` +
        `or a named tensor variable; assign the expression to a name first`,
      exprAst.span
    );
  }

  return { kind: "IndexSliceStore", base, index: slots, rhs, span };
}
