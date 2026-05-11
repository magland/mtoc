/**
 * Range / colon indexed-write lowering: `v(a:b) = w`, `v(:) = w`,
 * `v(:) = scalar`, `v(a:s:b) = scalar`.
 *
 * Companion to `lowerIndexStore` for slice (multi-slot) writes.
 * Today only single-slot range/colon writes are supported, on
 * real-or-complex double tensors. The codegen runs a per-slot loop
 * that mutates the base buffer in place.
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
import type { IRExpr, IRStmt, IndexSliceArg } from "./ir.js";
import {
  isHigherDim,
  isMultiElement,
  isNumeric,
  isScalar,
  isScalarReal,
  scalarDouble,
  type MType,
  type NumericType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Lower `<v>(slice) = <expr>` where the lvalue's single index slot
 *  is a `Range` or bare `Colon`. */
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
  const baseTy = this.envLookup(name);
  if (baseTy === undefined) {
    throw new TypeError(
      `use of undefined variable '${name}'`,
      lvalue.base.span
    );
  }
  if (!isNumeric(baseTy)) {
    throw new UnsupportedConstruct(
      `range/colon indexed write into ${typeToString(baseTy)} is not yet ` +
        `supported`,
      span
    );
  }
  if (!isMultiElement(baseTy)) {
    throw new UnsupportedConstruct(
      `range/colon indexed write requires a multi-element tensor (got ` +
        `${typeToString(baseTy)})`,
      span
    );
  }
  if (baseTy.elem === "char") {
    throw new UnsupportedConstruct(
      `range/colon indexed write into a char tensor is not yet supported`,
      span
    );
  }
  if (isHigherDim(baseTy)) {
    throw new UnsupportedConstruct(
      `range/colon indexed write into a tensor with ndim > 2 is not yet ` +
        `supported (reshape to 2-D first)`,
      span
    );
  }
  if (lvalue.indices.length !== 1) {
    throw new UnsupportedConstruct(
      `multi-slot range/colon indexed writes (got ${lvalue.indices.length} ` +
        `slots) are not yet supported`,
      span
    );
  }

  const baseCName = this.currentCNameFor(name);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: baseTy,
    span: lvalue.base.span,
  };

  // Lower the slice slot inside an `endStack` push so embedded `end`
  // resolves to numel(base).
  const arg = lvalue.indices[0];
  const slice = lowerSliceSlot.call(this, baseCName, baseTy, arg);

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

  return { kind: "IndexSliceStore", base, index: slice, rhs, span };
}

/** Same as `lowerIndexSlice`'s slot lowering — kept inline here so
 *  the slice-write path doesn't depend on the slice-read module. */
function lowerSliceSlot(
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
      `internal: lowerIndexSliceStore reached lowerSliceSlot with a ` +
        `non-Range/Colon arg ${arg.type}`,
      arg.span
    );
  }
  this.endStack.push({ baseCName, baseTy, axis: "linear" });
  let start: IRExpr;
  let step: IRExpr;
  let end: IRExpr;
  try {
    start = this.lowerExpr(arg.start);
    if (arg.step === null) {
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
