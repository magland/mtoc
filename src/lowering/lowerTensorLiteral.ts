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
  charArrayType,
  isScalar,
  isNumeric,
  joinSign,
  numericType,
  scalarChar,
  type DimInfo,
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

  // Special case: char horzcat `['ab' 'cd']` / `['a' 'b' 'c']`.
  // When any cell in any row is a Char AST node, dispatch entirely to
  // the char horzcat path. In numbl, `[c1 c2 ... cN]` where every c_i
  // is a char literal (single or multi-element) is horizontal
  // concatenation — equivalent to Octave/MATLAB string concat.
  // numbl also widens char arrays to double when mixed with numeric, but
  // that path is deferred; we reject mixed-type tensor rows with a clear
  // message. 2D char matrices (multiple rows) are also deferred.
  if (e.rows.flat().some(cell => cell.type === "Char")) {
    if (numRows > 1) {
      throw new UnsupportedConstruct(
        `2D char-array literals (multiple rows of char literals) are not ` +
          `yet supported`,
        e.span
      );
    }
    if (!e.rows[0].every(cell => cell.type === "Char")) {
      throw new UnsupportedConstruct(
        `mixed char and non-char cells in a tensor literal are not yet ` +
          `supported (got a mix of char literals and other expressions)`,
        e.span
      );
    }
    // Concatenate all char values into a single CharLit.
    let combined = "";
    for (const cell of e.rows[0]) {
      const ir = this.lowerExpr(cell);
      if (ir.kind !== "CharLit") {
        throw new UnsupportedConstruct(
          `internal: expected CharLit from char cell lowering`,
          cell.span
        );
      }
      combined += ir.value;
    }
    if (combined.length === 0) {
      throw new UnsupportedConstruct(
        `empty char-array literal is not yet supported`,
        e.span
      );
    }
    const n = combined.length;
    const cols: DimInfo = n === 1 ? { kind: "one" } : { kind: "notOne" };
    const ty: NumericType = n === 1 ? scalarChar() : charArrayType(cols);
    return { kind: "CharLit", value: combined, ty, span: e.span };
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
  // The literal's coarse dim shape: each axis is `one` if the literal
  // has exactly that many cells in that axis, else `notOne`. The
  // specific size is carried by the IR node's `elements` array;
  // codegen reads `elements.length` / `elements[0].length` directly.
  const rowsDim: DimInfo = numRows === 1 ? { kind: "one" } : { kind: "notOne" };
  const colsDim: DimInfo = numCols === 1 ? { kind: "one" } : { kind: "notOne" };
  // Sign of the literal: the join of every real element's sign. If any
  // cell is complex, the result type's sign is meaningless.
  let ty: NumericType;
  if (isComplex) {
    ty = numericType(rowsDim, colsDim, true, "unknown");
  } else {
    let sign: Sign = elementSigns[0];
    for (let i = 1; i < elementSigns.length; i++) {
      sign = joinSign(sign, elementSigns[i]);
    }
    ty = numericType(rowsDim, colsDim, false, sign);
  }
  return { kind: "TensorLit", elements, ty, span: e.span };
}
