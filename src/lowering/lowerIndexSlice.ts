/**
 * Range / colon index lowering: `v(a:b)`, `v(a:s:b)`, `v(:)`.
 *
 * The lowerer reaches this helper from `lowerFuncCall` whenever an
 * indexing FuncCall has any slot that is a `Range` or bare `Colon`
 * AST node. Today only single-slot slices are supported (linear
 * indexing into a vector or matrix); 2D mixed scalar/range slicing
 * arrives in a future commit.
 *
 * Result-shape rules (matching numbl):
 *   - `Range` slot, base is row-vec  → row-vec (preserves)
 *   - `Range` slot, base is col-vec  → col-vec (preserves)
 *   - `Range` slot, base is matrix   → col-vec (linearized)
 *   - `Colon` slot                    → col-vec (always linearized)
 *
 * Char-tensor slices and complex-step ranges are deferred — the
 * codegen path here assumes a real-or-complex `mtoc_tensor_t` base
 * with a numeric-literal step; non-conforming cases are rejected at
 * lowering with a span.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr, IndexSliceArg } from "./ir.js";
import {
  isColVec,
  isMultiElement,
  isNumeric,
  isRowVec,
  isScalarReal,
  numericType,
  type DimInfo,
  type MType,
  type NumericType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Lower an index-read of an in-scope variable when at least one
 *  index slot is a `Range` or `Colon`. */
export function lowerIndexSlice(
  this: Lowerer,
  name: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const baseTy = this.envLookup(name);
  if (baseTy === undefined) {
    throw new UnsupportedConstruct(
      `internal: lowerIndexSlice called for '${name}' which is not in scope`,
      span
    );
  }
  if (!isNumeric(baseTy)) {
    throw new UnsupportedConstruct(
      `range/colon indexing into ${typeToString(baseTy)} is not yet supported`,
      span
    );
  }
  if (!isMultiElement(baseTy)) {
    throw new UnsupportedConstruct(
      `range/colon indexing requires a multi-element tensor (got ` +
        `${typeToString(baseTy)})`,
      span
    );
  }
  if (baseTy.elem === "char") {
    throw new UnsupportedConstruct(
      `range/colon indexing into a char tensor is not yet supported`,
      span
    );
  }
  if (argExprs.length !== 1) {
    throw new UnsupportedConstruct(
      `multi-slot range/colon indexing (got ${argExprs.length} slots) is ` +
        `not yet supported; use single-slot linear or full-colon forms`,
      span
    );
  }

  const baseCName = this.currentCNameFor(name);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: baseTy,
    span,
  };

  // The single index slot. The lowerer's endStack is pushed for the
  // duration of lowering each Range component so an embedded `end`
  // resolves to the right axis size of the base. Colon has no sub-
  // expressions and so doesn't need the stack push.
  const arg = argExprs[0];
  const slice = lowerSliceArg.call(this, baseCName, baseTy, arg);

  // Result shape (matching numbl):
  //   - Colon            → always linearizes to a column vector.
  //   - Range, base row  → row vector (preserves base orientation).
  //   - Range, base col  → col vector (preserves base orientation).
  //   - Range, base mtx  → row vector (since the range `a:b` is itself
  //                        a row, and the index orientation wins for
  //                        a matrix base under linear indexing).
  let resultRows: DimInfo;
  let resultCols: DimInfo;
  if (slice.kind === "Colon") {
    resultRows = { kind: "notOne" };
    resultCols = { kind: "one" };
  } else if (isRowVec(baseTy)) {
    resultRows = { kind: "one" };
    resultCols = { kind: "notOne" };
  } else if (isColVec(baseTy)) {
    resultRows = { kind: "notOne" };
    resultCols = { kind: "one" };
  } else {
    // Matrix base under range indexing: row result.
    resultRows = { kind: "one" };
    resultCols = { kind: "notOne" };
  }
  const resultTy: NumericType = numericType(
    resultRows,
    resultCols,
    baseTy.isComplex,
    baseTy.isComplex ? "unknown" : "unknown"
  );

  return {
    kind: "IndexSlice",
    base,
    index: slice,
    ty: resultTy,
    span,
  };
}

/** Lower a `Range` or `Colon` AST node into an `IndexSliceArg`. The
 *  endStack is pushed for the duration of lowering the Range's
 *  sub-expressions so an embedded `end` token resolves correctly. */
function lowerSliceArg(
  this: Lowerer,
  baseCName: string,
  baseTy: MType,
  arg: Expr
): IndexSliceArg {
  if (arg.type === "Colon") {
    return { kind: "Colon", span: arg.span };
  }
  if (arg.type !== "Range") {
    throw new UnsupportedConstruct(
      `internal: lowerSliceArg called with non-Range/Colon arg ${arg.type}`,
      arg.span
    );
  }
  // Single-slot context → axis is "linear" for `end` resolution.
  this.endStack.push({ baseCName, baseTy, axis: "linear" });
  let start: IRExpr;
  let step: IRExpr;
  let end: IRExpr;
  try {
    start = this.lowerExpr(arg.start);
    if (arg.step === null) {
      // Implicit step of 1. Synthesize the IR node directly so the
      // codegen path stays uniform — a numeric-literal step lets
      // codegen emit a well-typed iteration-count expression.
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
  // Codegen requires a literal step today (matches the for-loop
  // convention) — a runtime step changes the iteration-count
  // formula and isn't worth the extra complexity for the first cut.
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

/** Local helper: `scalarDouble("positive")` for the implicit step.
 *  Defined inline here so this file doesn't need to thread through
 *  the broader sign helpers. */
function scalarRealOne(): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    rows: { kind: "one" },
    cols: { kind: "one" },
    sign: "positive",
  };
}
