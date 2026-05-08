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
  isScalarReal,
  isNumeric,
  joinSign,
  matrixDouble,
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
      if (!isScalarReal(ir.ty)) {
        throw new UnsupportedConstruct(
          `tensor literal elements must be real scalars today ` +
            `(got ${typeToString(ir.ty)}); nested tensors and ` +
            `concatenation are not yet supported`,
          cell.span
        );
      }
      loweredRow.push(ir);
      if (isNumeric(ir.ty)) elementSigns.push(ir.ty.sign);
    }
    elements.push(loweredRow);
  }
  // Sign of the literal: the join of every element's sign.
  let sign: Sign = elementSigns[0];
  for (let i = 1; i < elementSigns.length; i++) {
    sign = joinSign(sign, elementSigns[i]);
  }
  const ty = matrixDouble(numRows, numCols, sign);
  return { kind: "TensorLit", elements, ty, span: e.span };
}
