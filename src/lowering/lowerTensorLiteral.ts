/**
 * Tensor-literal lowering: `[a b c; d e f]` → `IRExpr.TensorLit`.
 *
 * Validates row uniformity and per-cell scalar-real-ness, then packs
 * the cells into the row-major nested array the codegen expects. Sign
 * is the join across every cell.
 */

import type { Expr } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isScalar,
  isNumeric,
  joinSign,
  matrixDouble,
  type NumericType,
  type Sign,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

export function lowerTensorLiteral(
  this: Lowerer,
  e: Extract<Expr, { type: "Tensor" }>
): IRExpr {
  if (e.rows.length === 0) {
    throw new UnsupportedConstruct(
      `empty tensor literal '[]' is not yet supported`,
      e.span
    );
  }
  const numRows = e.rows.length;
  const numCols = e.rows[0].length;
  if (numCols === 0) {
    throw new UnsupportedConstruct(
      `tensor literal with zero-length row is not yet supported`,
      e.span
    );
  }
  const elements: IRExpr[][] = [];
  const elementSigns: Sign[] = [];
  // The literal is complex iff any cell is complex. We track this
  // here so codegen can emit a parallel `_im` buffer and write both
  // halves per cell. Sign is meaningless on the resulting complex
  // type — `matrixDouble` already passes the joined sign through, but
  // for a complex literal we override to "unknown" (the type-system
  // invariant; `canonicalizeType`/`unify` would normalize anyway, but
  // setting it directly keeps debug-prints honest).
  let isComplex = false;
  for (let r = 0; r < numRows; r++) {
    const row = e.rows[r];
    if (row.length !== numCols) {
      throw new TypeError(
        `tensor literal has rows of different lengths ` +
          `(row 1 has ${numCols}, row ${r + 1} has ${row.length})`,
        e.span
      );
    }
    const loweredRow: IRExpr[] = [];
    for (const cell of row) {
      const ir = this.lowerExpr(cell);
      // Cells must be scalar (1×1 numeric); real or complex are both
      // admissible. Multi-element cells (nested tensors, concatenation)
      // remain unsupported.
      if (!isNumeric(ir.ty) || !isScalar(ir.ty)) {
        throw new UnsupportedConstruct(
          `tensor literal elements must be scalar today ` +
            `(got ${typeToString(ir.ty)}); nested tensors and ` +
            `concatenation are not yet supported`,
          cell.span
        );
      }
      if (ir.ty.isComplex) isComplex = true;
      loweredRow.push(ir);
      // Sign only matters on the all-real path; once any cell goes
      // complex the result type's sign is forced "unknown" anyway.
      if (!ir.ty.isComplex) elementSigns.push(ir.ty.sign);
    }
    elements.push(loweredRow);
  }
  // Sign of the literal: the join of every real element's sign. If any
  // cell is complex, the result type's sign is meaningless.
  let ty: NumericType;
  if (isComplex) {
    ty = {
      ...matrixDouble(numRows, numCols, "unknown"),
      isComplex: true,
    };
  } else {
    let sign: Sign = elementSigns[0];
    for (let i = 1; i < elementSigns.length; i++) {
      sign = joinSign(sign, elementSigns[i]);
    }
    ty = matrixDouble(numRows, numCols, sign);
  }
  return { kind: "TensorLit", elements, ty, span: e.span };
}
