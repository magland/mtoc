/**
 * Indexed-write lowering: `v(i) = x`, `M(i, j) = x`, `v(end) = x`.
 *
 * The parser emits `AssignLValue { lvalue: Index, expr }` for an
 * indexed write. The lowerer routes to this helper from `lowerStmt`
 * whenever the lvalue is `Index` with a simple `Ident` base. Today
 * only scalar writes are supported (one or two scalar indices, scalar
 * RHS); range / colon writes (`v(2:5) = w`) are deferred to a later
 * commit.
 *
 * Type rules:
 *   - real RHS into real base    → `.real[off] = rhs;`
 *   - real RHS into complex base → `.real[off] = rhs; .imag[off] = 0;`
 *   - complex RHS into complex base → write both halves via a
 *                                     temp so creal/cimag don't
 *                                     double-evaluate the RHS.
 *   - complex RHS into real base    → rejected at lowering with a span.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr, IRStmt } from "./ir.js";
import {
  isMultiElement,
  isNumeric,
  isScalar,
  isScalarReal,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Lower `<lvalue> = <expr>` where `lvalue` is an `Index` LValue. */
export function lowerIndexStore(
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
      `indexed write into ${typeToString(baseTy)} is not yet supported`,
      span
    );
  }
  if (!isMultiElement(baseTy)) {
    throw new UnsupportedConstruct(
      `indexed write requires a multi-element tensor (got ` +
        `${typeToString(baseTy)})`,
      span
    );
  }
  if (baseTy.elem === "char") {
    throw new UnsupportedConstruct(
      `indexed write into a char tensor is not yet supported`,
      span
    );
  }
  if (lvalue.indices.length === 0) {
    throw new UnsupportedConstruct(
      `indexed write requires at least one index`,
      span
    );
  }
  if (lvalue.indices.length > 2) {
    throw new UnsupportedConstruct(
      `more than 2 indices in an indexed write is not yet supported ` +
        `(got ${lvalue.indices.length})`,
      span
    );
  }
  // Reject range / colon slots — only scalar writes are supported in
  // this commit. The "v(2:5) = w" path arrives later.
  for (const idx of lvalue.indices) {
    if (idx.type === "Range" || idx.type === "Colon") {
      throw new UnsupportedConstruct(
        `range/colon indexed writes (e.g. \`v(2:5) = w\`) are not yet ` +
          `supported`,
        idx.span
      );
    }
  }

  const baseCName = this.currentCNameFor(name);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: baseTy,
    span: lvalue.base.span,
  };

  const indices: IRExpr[] = [];
  const numSlots = lvalue.indices.length;
  for (let slot = 0; slot < numSlots; slot++) {
    const axis: "row" | "col" | "linear" =
      numSlots === 1 ? "linear" : slot === 0 ? "row" : "col";
    this.endStack.push({ baseCName, baseTy, axis });
    let lowered: IRExpr;
    try {
      lowered = this.lowerExpr(lvalue.indices[slot]);
    } finally {
      this.endStack.pop();
    }
    if (!isScalarReal(lowered.ty)) {
      throw new TypeError(
        `index ${slot + 1} of '${name}' must be a real scalar ` +
          `(got ${typeToString(lowered.ty)})`,
        lvalue.indices[slot].span
      );
    }
    indices.push(lowered);
  }

  const rhs = this.lowerExpr(exprAst);
  if (!isNumeric(rhs.ty) || !isScalar(rhs.ty)) {
    throw new TypeError(
      `right-hand side of an indexed assignment must be a numeric scalar ` +
        `(got ${typeToString(rhs.ty)})`,
      exprAst.span
    );
  }
  // A complex RHS into a real-typed base would silently drop the
  // imaginary part; reject explicitly so the user sees a span.
  if (!baseTy.isComplex && rhs.ty.isComplex) {
    throw new TypeError(
      `cannot store a complex scalar into a real tensor '${name}' ` +
        `(would lose the imaginary part)`,
      span
    );
  }

  return { kind: "IndexStore", base, indices, rhs, span };
}
