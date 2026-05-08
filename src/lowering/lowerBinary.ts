/**
 * Binary-expression lowering. Today's grammar splits cleanly into three
 * groups; each gets a focused helper:
 *   - `lowerComparison` — `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`
 *     (scalar-real operands only)
 *   - `lowerPow` — `^`, `.^` (scalar-real operands only)
 *   - `lowerArith` — `+`, `-`, `*`, `/`, `.*`, `./`
 *
 * The structural-square refinement (`x*x` is statically nonneg) lives
 * in `lowerArith`.
 */

import type { Expr, BinaryOperation as BinOp } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  arithResult,
  isScalar,
  isScalarComplex,
  isScalarReal,
  isNumeric,
  scalarComplex,
  scalarDouble,
  type MType,
  typeToString,
} from "./types.js";
import type { Lowerer } from "./lower.js";

const SUPPORTED_BIN_OPS: ReadonlySet<BinOp> = new Set([
  "Add",
  "Sub",
  "Mul",
  "Div",
  "Pow",
  "ElemMul",
  "ElemDiv",
  "ElemPow",
  "Equal",
  "NotEqual",
  "Less",
  "LessEqual",
  "Greater",
  "GreaterEqual",
  "AndAnd",
  "OrOr",
] as BinOp[]);

const COMPARISON_BIN_OPS: ReadonlySet<BinOp> = new Set([
  "Equal",
  "NotEqual",
  "Less",
  "LessEqual",
  "Greater",
  "GreaterEqual",
  "AndAnd",
  "OrOr",
] as BinOp[]);

/** Map a parser BinaryOperation onto the abstract arith kind used by
 *  the type system's `arithResult`. Returns null for non-arithmetic
 *  ops (caller dispatches comparisons/power separately). */
function arithKindForOp(op: BinOp): "Add" | "Sub" | "Mul" | "Div" | null {
  switch (op) {
    case "Add":
      return "Add";
    case "Sub":
      return "Sub";
    case "Mul":
    case "ElemMul":
      return "Mul";
    case "Div":
    case "ElemDiv":
      return "Div";
    default:
      return null;
  }
}

export function lowerBinary(
  this: Lowerer,
  e: Extract<Expr, { type: "Binary" }>
): IRExpr {
  if (!SUPPORTED_BIN_OPS.has(e.op)) {
    throw new UnsupportedConstruct(
      `binary operator ${e.op} is not yet supported`,
      e.span
    );
  }
  const left = this.lowerExpr(e.left);
  const right = this.lowerExpr(e.right);
  // Fold the parser's `Number * ImagUnit` shape into a single
  // ImagLit. The numbl parser's `parsePostfix` only emits the
  // standalone `ImagUnit` variant on the right side of a synthetic
  // Mul whose left side is a numeric literal — so this fold doesn't
  // touch any user-written multiplication. After this, codegen sees
  // `2.5i` as one ImagLit instead of `Mul(NumLit 2.5, ImagLit 1)`.
  if (
    e.op === "Mul" &&
    left.kind === "NumLit" &&
    right.kind === "ImagLit" &&
    right.value === 1
  ) {
    return {
      kind: "ImagLit",
      value: left.value,
      ty: scalarComplex(),
      span: e.span,
    };
  }
  if (!isNumeric(left.ty) || !isNumeric(right.ty)) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on ${typeToString(left.ty)} and ${typeToString(
        right.ty
      )} is not yet supported`,
      e.span
    );
  }

  if (COMPARISON_BIN_OPS.has(e.op)) {
    return lowerComparison(e, left, right);
  }
  if (e.op === "Pow" || e.op === "ElemPow") {
    return lowerPow(e, left, right);
  }
  return lowerArith(e, left, right);
}

/** Comparisons / logical ops: scalar operands (real or complex).
 *  Element-wise comparison on tensors needs its own codegen path.
 *
 *  Numbl semantics on complex (mirrored by emit's complex branch):
 *    <  <=  >  >=     compare on the real part only
 *    ==  !=           compare both real and imag
 *    && ||            apply `toBool`: re != 0 || im != 0
 *  The IR result type stays a real-scalar logical (0/1, "nonnegative");
 *  codegen dispatches on operand `isComplex` to emit the correct C. */
function lowerComparison(
  e: Extract<Expr, { type: "Binary" }>,
  left: IRExpr,
  right: IRExpr
): IRExpr {
  const ok = (t: IRExpr["ty"]): boolean =>
    isScalarReal(t) || isScalarComplex(t);
  if (!ok(left.ty) || !ok(right.ty)) {
    throw new UnsupportedConstruct(
      `comparison/logical ${e.op} on ${typeToString(left.ty)} and ` +
        `${typeToString(right.ty)} is not yet supported`,
      e.span
    );
  }
  return {
    kind: "Binary",
    op: e.op,
    left,
    right,
    ty: scalarDouble("nonnegative"),
    span: e.span,
  };
}

/** Power ops: scalar-real end-to-end (codegen emits `pow()` inline).
 *  Complex `^` is not yet supported. */
function lowerPow(
  e: Extract<Expr, { type: "Binary" }>,
  left: IRExpr,
  right: IRExpr
): IRExpr {
  if (!isScalar(left.ty) || !isScalar(right.ty)) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on tensors is not yet supported`,
      e.span
    );
  }
  if (
    (isNumeric(left.ty) && left.ty.isComplex) ||
    (isNumeric(right.ty) && right.ty.isComplex)
  ) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on complex operands is not yet supported`,
      e.span
    );
  }
  return {
    kind: "Binary",
    op: e.op,
    left,
    right,
    ty: scalarDouble("unknown"),
    span: e.span,
  };
}

/** Arithmetic ops `+ - * / .* ./` over scalars and tensors (with
 *  scalar broadcast). Rejects the matrix-only variants `* / ^` on
 *  two-tensor operands until we have matrix multiply / divide / power. */
function lowerArith(
  e: Extract<Expr, { type: "Binary" }>,
  left: IRExpr,
  right: IRExpr
): IRExpr {
  const arithOp = arithKindForOp(e.op);
  if (!arithOp) {
    throw new UnsupportedConstruct(
      `unsupported arith operator ${e.op}`,
      e.span
    );
  }
  const leftScalar = isScalar(left.ty);
  const rightScalar = isScalar(right.ty);
  const matrixOnly = e.op === "Mul" || e.op === "Div";
  if (!leftScalar && !rightScalar && matrixOnly) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on two tensors is not yet supported ` +
        `(matrix multiply / divide / power need a separate ` +
        `codegen path; use .* ./ .^ for elementwise instead)`,
      e.span
    );
  }
  let ty: MType = arithResult(arithOp, left.ty, right.ty);
  // Structural square detection: `x*x` (same variable) is nonneg
  // regardless of x's sign. Applies for scalars and tensors.
  if (
    (e.op === "Mul" || e.op === "ElemMul") &&
    left.kind === "Var" &&
    right.kind === "Var" &&
    left.name === right.name &&
    isNumeric(ty)
  ) {
    ty = { ...ty, sign: "nonnegative" };
  }
  if (ty.kind === "Unknown") {
    throw new UnsupportedConstruct(
      `binary ${e.op} on ${typeToString(left.ty)} and ${typeToString(
        right.ty
      )} produces an incompatible result type`,
      e.span
    );
  }
  return { kind: "Binary", op: e.op, left, right, ty, span: e.span };
}
