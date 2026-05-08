/**
 * Unary-expression lowering. Folds literal-targeted unaries at lowering
 * time (so `-3` lowers as `NumLit(-3)`, not `Unary(Minus, NumLit(3))`)
 * and propagates the sign lattice on tensor operands.
 */

import type { Expr, UnaryOperation as UnOp } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isNumeric,
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
  if (!isNumeric(operand.ty)) {
    throw new UnsupportedConstruct(
      `unary ${e.op} on ${typeToString(operand.ty)} is not yet supported`,
      e.span
    );
  }
  // Complex `Plus`/`Minus` are valid scalar arithmetic (`+z` identity,
  // `-z` flips both parts). Complex `Not` is the toBool path: `~z` is
  // 1 iff `re == 0 && im == 0`. The codegen branch handles both;
  // lowering just sets the type appropriately.
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
  // Fold a unary on an ImagLit at lowering, mirroring the NumLit case
  // (so `-2i` becomes one ImagLit rather than `Unary(Minus, ImagLit 2)`).
  if (operand.kind === "ImagLit") {
    if (e.op === "Plus") {
      return { ...operand, span: e.span };
    }
    if (e.op === "Minus") {
      return { ...operand, value: -operand.value, span: e.span };
    }
  }
  let ty: MType = operand.ty;
  if (isNumeric(operand.ty)) {
    if (e.op === "Minus") {
      // Sign negation only applies on the real branch — complex `sign`
      // stays "unknown" by the type-system invariant.
      if (!operand.ty.isComplex) {
        ty = { ...operand.ty, sign: signNegate(operand.ty.sign) };
      }
    } else if (e.op === "Not") {
      ty = scalarDouble("nonnegative");
    }
  }
  return { kind: "Unary", op: e.op, operand, ty, span: e.span };
}
