/**
 * Unary-expression lowering. Folds literal-targeted unaries at lowering
 * time (so `-3` lowers as `NumLit(-3)`, not `Unary(Minus, NumLit(3))`)
 * and propagates the sign lattice on tensor operands.
 */

import type { Expr, UnaryOperation as UnOp } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isTensor,
  scalarDouble,
  signFromValue,
  signNegate,
  type MType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

const SUPPORTED_UN_OPS: ReadonlySet<UnOp> = new Set([
  "Plus",
  "Minus",
  "Not",
] as UnOp[]);

export function lowerUnary(
  this: Lowerer,
  e: Extract<Expr, { type: "Unary" }>
): IRExpr {
  if (!SUPPORTED_UN_OPS.has(e.op)) {
    throw new UnsupportedConstruct(
      `unary operator ${e.op} is not yet supported`,
      e.span
    );
  }
  const operand = this.lowerExpr(e.operand);
  if (!isTensor(operand.ty) || operand.ty.isComplex) {
    throw new UnsupportedConstruct(
      `unary ${e.op} on ${typeToString(operand.ty)} is not yet supported`,
      e.span
    );
  }
  if (operand.kind === "NumLit") {
    if (e.op === "Plus") {
      return { ...operand, span: e.span };
    }
    if (e.op === "Minus") {
      const v = -operand.value;
      return {
        ...operand,
        value: v,
        ty: scalarDouble(signFromValue(v)),
        span: e.span,
      };
    }
    if (e.op === "Not") {
      return {
        kind: "NumLit",
        value: operand.value !== 0 ? 0 : 1,
        ty: scalarDouble("nonnegative"),
        span: e.span,
      };
    }
  }
  let ty: MType = operand.ty;
  if (isTensor(operand.ty)) {
    if (e.op === "Minus") {
      ty = { ...operand.ty, sign: signNegate(operand.ty.sign) };
    } else if (e.op === "Not") {
      ty = scalarDouble("nonnegative");
    }
  }
  return { kind: "Unary", op: e.op, operand, ty, span: e.span };
}
