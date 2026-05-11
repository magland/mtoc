/**
 * Range / colon / scalar-mix index lowering: `v(a:b)`, `v(:)`,
 * `M(:, j)`, `T(:, i, :)`, … .
 *
 * The lowerer reaches this helper from `lowerFuncCall` whenever an
 * indexing FuncCall has any slot that is a `Range` or bare `Colon`
 * AST node. Two acceptable arities:
 *   - 1 slot         → linear indexing into a multi-element tensor.
 *   - `ndim` slots   → full per-axis indexing. Any mix of `Colon`,
 *                       `Range`, and scalar slots is allowed.
 * Any other arity is rejected with a span (numbl's "partial linear-
 * trailing" semantics are not yet supported).
 *
 * Single-slot result-shape rules (matching numbl):
 *   - `Range` slot, base is row-vec  → row-vec (preserves)
 *   - `Range` slot, base is col-vec  → col-vec (preserves)
 *   - `Range` slot, base is matrix   → row-vec (the range is itself
 *                                       a row)
 *   - `Colon` slot                    → col-vec (always linearized)
 *
 * Multi-slot result-shape rules (one result axis per slot):
 *   - `Colon`  at axis k → result.dims[k] = base.dims[k]
 *   - `Range`  at axis k → result.dims[k] = {notOne}
 *   - `Scalar` at axis k → result.dims[k] = {one}
 * Trailing singletons are stripped by `numericTypeND`.
 *
 * Char-tensor slices and complex-step ranges are deferred — the
 * codegen path here assumes a real-or-complex `mtoc_tensor_t` base
 * with a numeric-literal step.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr, IndexSliceArg } from "./ir.js";
import {
  isColVec,
  isRowVec,
  isScalarReal,
  numericTypeND,
  scalarDouble,
  type DimInfo,
  type MType,
  type NumericType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";
import { resolveIndexBase } from "./indexResolve.js";

/** Lower an index-read of an in-scope variable when at least one
 *  index slot is a `Range` or `Colon`. */
export function lowerIndexSlice(
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
    { notInScope: "internal", operation: "sliceRead" }
  );

  // Lower each slot. The `end` axis is "linear" for the single-slot
  // form (so `end` resolves to numel(base)); for the multi-slot form
  // it is the slot index (so `M(end, :)` → rows of M, `M(:, end)` →
  // cols of M, etc.).
  const isSingleSlot = argExprs.length === 1;
  const slots: IndexSliceArg[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const axis: number | "linear" = isSingleSlot ? "linear" : i;
    slots.push(lowerSliceArg.call(this, baseCName, baseTy, axis, argExprs[i]));
  }

  // Build the result type. The single-slot path keeps the legacy
  // shape rules; the multi-slot path takes one result axis per slot.
  let resultTy: NumericType;
  if (isSingleSlot) {
    const slot = slots[0];
    let resultRows: DimInfo;
    let resultCols: DimInfo;
    if (slot.kind === "Colon") {
      resultRows = { kind: "notOne" };
      resultCols = { kind: "one" };
    } else if (slot.kind === "Range") {
      if (isRowVec(baseTy)) {
        resultRows = { kind: "one" };
        resultCols = { kind: "notOne" };
      } else if (isColVec(baseTy)) {
        resultRows = { kind: "notOne" };
        resultCols = { kind: "one" };
      } else {
        // Matrix base under linear range: range is itself a row.
        resultRows = { kind: "one" };
        resultCols = { kind: "notOne" };
      }
    } else {
      throw new UnsupportedConstruct(
        `internal: single-slot scalar slice should have routed through ` +
          `lowerIndexLoad`,
        span
      );
    }
    resultTy = numericTypeND(
      [resultRows, resultCols],
      baseTy.isComplex,
      "unknown"
    );
  } else {
    const resultDims: DimInfo[] = slots.map((slot, k) => {
      if (slot.kind === "Colon") return baseTy.dims[k];
      if (slot.kind === "Range") return { kind: "notOne" };
      return { kind: "one" };
    });
    resultTy = numericTypeND(resultDims, baseTy.isComplex, "unknown");
  }

  return {
    kind: "IndexSlice",
    base,
    index: slots,
    ty: resultTy,
    span,
  };
}

/** Lower a `Range` / `Colon` / scalar AST node into an `IndexSliceArg`.
 *  The `endStack` is pushed for the duration of lowering each slot's
 *  sub-expressions so an embedded `end` token resolves against the
 *  right axis of the base. Exported so the sibling store-side helper
 *  can reuse the slot-lowering logic. */
export function lowerSliceArg(
  this: Lowerer,
  baseCName: string,
  baseTy: MType,
  axis: number | "linear",
  arg: Expr
): IndexSliceArg {
  if (arg.type === "Colon") {
    return { kind: "Colon", span: arg.span };
  }
  if (arg.type !== "Range") {
    // Scalar slot — accepted only in the multi-slot mixed form. The
    // caller drives that distinction (single-slot scalar would route
    // through lowerIndexLoad instead).
    this.endStack.push({ baseCName, baseTy, axis });
    let expr: IRExpr;
    try {
      expr = this.lowerExpr(arg);
    } finally {
      this.endStack.pop();
    }
    if (!isScalarReal(expr.ty)) {
      throw new TypeError(
        `index slot must be a real scalar (got ${typeToString(expr.ty)})`,
        arg.span
      );
    }
    return { kind: "Scalar", expr, span: arg.span };
  }
  this.endStack.push({ baseCName, baseTy, axis });
  let start: IRExpr;
  let step: IRExpr;
  let end: IRExpr;
  try {
    start = this.lowerExpr(arg.start);
    if (arg.step === null) {
      // Implicit step of 1.
      step = {
        kind: "NumLit",
        value: 1,
        ty: scalarRealOne(),
        span: arg.span,
      };
    } else {
      step = this.lowerExpr(arg.step);
    }
    end = this.lowerExpr(arg.end);
  } finally {
    this.endStack.pop();
  }
  if (!isScalarReal(start.ty)) {
    throw new TypeError(
      `range start must be a real scalar (got ${typeToString(start.ty)})`,
      arg.start.span
    );
  }
  if (!isScalarReal(end.ty)) {
    throw new TypeError(
      `range end must be a real scalar (got ${typeToString(end.ty)})`,
      arg.end.span
    );
  }
  if (!isScalarReal(step.ty)) {
    throw new TypeError(
      `range step must be a real scalar (got ${typeToString(step.ty)})`,
      arg.step?.span ?? arg.span
    );
  }
  if (step.kind !== "NumLit") {
    throw new UnsupportedConstruct(
      `range step in an index expression must be a numeric literal ` +
        `(got expression)`,
      arg.step?.span ?? arg.span
    );
  }
  if (step.value === 0) {
    throw new UnsupportedConstruct(
      `range step in an index expression must be non-zero`,
      arg.step?.span ?? arg.span
    );
  }
  return { kind: "Range", start, step, end, span: arg.span };
}

function scalarRealOne(): NumericType {
  return scalarDouble("positive");
}
