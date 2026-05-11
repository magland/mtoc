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
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  arithResult,
  isCharArray,
  isCharScalar,
  isHigherDim,
  isMultiElement,
  isScalar,
  isScalarComplex,
  isScalarReal,
  isNumeric,
  isString,
  isText,
  numericTypeND,
  rowVecDouble,
  scalarComplex,
  scalarDouble,
  STRING,
  type MType,
  type NumericType,
  type Sign,
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
  // String concatenation: `+` lowers to a string-typed Binary whenever
  // at least one operand is a string. The other operand may be a
  // string or a char-array (numbl coerces char into string at the `+`
  // boundary); mtoc bridges via the text view at codegen. A scalar
  // char or any non-text operand still rejects with a `TypeError` so
  // the user can wrap the other side explicitly. Any non-Add op on a
  // string operand is rejected. char-array + char-array is NOT
  // concat — it's element-wise numeric addition, handled by the
  // numeric path below.
  if (isString(left.ty) || isString(right.ty)) {
    if (e.op !== "Add") {
      throw new UnsupportedConstruct(
        `binary ${e.op} on string operands is not supported ` +
          `(only \`+\` is defined; numbl uses it for concatenation)`,
        e.span
      );
    }
    if (!isText(left.ty) || !isText(right.ty)) {
      throw new TypeError(
        `binary + with a string operand requires the other operand to ` +
          `be a string or char array ` +
          `(got ${typeToString(left.ty)} and ${typeToString(right.ty)})`,
        e.span
      );
    }
    return {
      kind: "Binary",
      op: e.op,
      left,
      right,
      ty: STRING,
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

/** Comparisons / logical ops: scalar operands (real or complex) or
 *  char scalars / char arrays (element-wise comparison).
 *
 *  Numbl semantics on complex (mirrored by emit's complex branch):
 *    <  <=  >  >=     compare on the real part only
 *    ==  !=           compare both real and imag
 *    && ||            apply `toBool`: re != 0 || im != 0
 *  Char comparisons are element-wise; the result is a double scalar
 *  (for scalar chars) or a 1×N double row-vec (for char arrays). */
function lowerComparison(
  e: Extract<Expr, { type: "Binary" }>,
  left: IRExpr,
  right: IRExpr
): IRExpr {
  const leftIsCharArr = isCharArray(left.ty);
  const rightIsCharArr = isCharArray(right.ty);
  // Element-wise char array comparison (both must be char arrays).
  if (leftIsCharArr || rightIsCharArr) {
    if (!leftIsCharArr || !rightIsCharArr) {
      throw new UnsupportedConstruct(
        `comparison ${e.op} between char array and non-char operand ` +
          `(${typeToString(left.ty)} vs ${typeToString(right.ty)}) ` +
          `is not yet supported`,
        e.span
      );
    }
    // Result is a double row-vec (element-wise 0/1).
    const resultTy: NumericType = rowVecDouble("nonnegative");
    return {
      kind: "Binary",
      op: e.op,
      left,
      right,
      ty: resultTy,
      span: e.span,
    };
  }
  // Scalar char comparison (both scalar chars → scalar double 0/1).
  const leftIsCharSc = isCharScalar(left.ty);
  const rightIsCharSc = isCharScalar(right.ty);
  if (leftIsCharSc || rightIsCharSc) {
    if (!leftIsCharSc || !rightIsCharSc) {
      throw new UnsupportedConstruct(
        `comparison ${e.op} between scalar char and non-char operand ` +
          `(${typeToString(left.ty)} vs ${typeToString(right.ty)}) ` +
          `is not yet supported`,
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
  // Element-wise tensor comparison: at least one side is a multi-element
  // double-elem numeric (real or complex), and both sides are numeric
  // double-elem (scalar or tensor). The result is a multi-element
  // double tensor of 0.0/1.0 values shaped by the broadcast rule
  // (handled by arithResult below).
  //
  // `&&` and `||` stay scalar-only — MATLAB defines them as short-
  // circuit on scalar conditions; elementwise logical conjunction uses
  // `&` / `|`, which the parser doesn't surface yet.
  const isDoubleNumeric = (t: MType): boolean =>
    isNumeric(t) && t.elem === "double";
  if (
    isDoubleNumeric(left.ty) &&
    isDoubleNumeric(right.ty) &&
    (isMultiElement(left.ty) || isMultiElement(right.ty))
  ) {
    if (e.op === "AndAnd" || e.op === "OrOr") {
      throw new UnsupportedConstruct(
        `${e.op === "AndAnd" ? "&&" : "||"} on tensor operands is not ` +
          `supported (only scalars; use a scalar reduction first)`,
        e.span
      );
    }
    if (isHigherDim(left.ty) || isHigherDim(right.ty)) {
      throw new UnsupportedConstruct(
        `comparison ${e.op} on a tensor with ndim > 2 is not yet supported`,
        e.span
      );
    }
    const shape = arithResult("Add", left.ty, right.ty);
    if (!isNumeric(shape)) {
      throw new UnsupportedConstruct(
        `comparison ${e.op} on ${typeToString(left.ty)} and ` +
          `${typeToString(right.ty)} produces an incompatible result type`,
        e.span
      );
    }
    const resultTy: NumericType = numericTypeND(
      shape.dims,
      false,
      "nonnegative"
    );
    return {
      kind: "Binary",
      op: e.op,
      left,
      right,
      ty: resultTy,
      span: e.span,
    };
  }
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

/** Try to evaluate `e` as a compile-time numeric constant. Returns
 *  the value or `null` if not foldable. Handles NumLit, plus Binary
 *  / Unary chains over numeric literals (used by `^` to detect a
 *  non-integer exponent like `1/3` so the result can be widened to
 *  complex). Conservative — anything beyond literal arithmetic
 *  returns `null`. */
function tryConstExprValue(e: IRExpr): number | null {
  if (e.kind === "NumLit") return e.value;
  if (e.kind === "Unary") {
    const v = tryConstExprValue(e.operand);
    if (v === null) return null;
    if (e.op === "Plus") return v;
    if (e.op === "Minus") return -v;
    return null;
  }
  if (e.kind === "Binary") {
    const l = tryConstExprValue(e.left);
    const r = tryConstExprValue(e.right);
    if (l === null || r === null) return null;
    switch (e.op) {
      case "Add":
        return l + r;
      case "Sub":
        return l - r;
      case "Mul":
      case "ElemMul":
        return l * r;
      case "Div":
      case "ElemDiv":
        return l / r;
      case "Pow":
      case "ElemPow":
        return Math.pow(l, r);
      default:
        return null;
    }
  }
  return null;
}

/** Infer the sign of `base ^ exp` (real path only — complex lift is
 *  handled separately). Rules:
 *    - base strictly positive ⇒ result strictly positive (any real exp).
 *    - constant exponent that's a positive even integer ⇒ result is
 *      nonneg; further positive if the base avoids zero.
 *    - constant exponent that's a positive odd integer ⇒ result sign
 *      matches the base sign (incl. zero / nonzero).
 *    - nonneg base + constant non-negative integer exponent ⇒ nonneg.
 *  Otherwise "unknown". The caller is responsible for clamping to
 *  "unknown" when the result is complex. */
function inferPowSign(baseSign: Sign, expVal: number | null): Sign {
  if (baseSign === "positive") return "positive";
  if (expVal !== null && Number.isFinite(expVal)) {
    if (Number.isInteger(expVal)) {
      if (expVal === 0) return "positive"; // x^0 = 1
      if (expVal > 0) {
        const isEven = expVal % 2 === 0;
        if (isEven) {
          if (baseSign === "negative" || baseSign === "nonzero")
            return "positive";
          return "nonnegative";
        }
        // positive odd integer: sign matches base
        return baseSign;
      }
    }
    // Non-integer constant exponent: by this point a negative base would
    // have lifted to complex above, so any real-path base is in
    // {positive, nonnegative, zero, nonzero, unknown}. Only nonneg base
    // gives a useful refinement.
    if (expVal >= 0 && baseSign === "nonnegative") return "nonnegative";
  }
  return "unknown";
}

/** Power ops:
 *    - `^` is scalar-real; lifts to complex when the base is
 *      statically negative AND the exponent folds to a non-integer
 *      constant (e.g. `(-1)^0.5`). Matrix power on two tensors is
 *      rejected with a pointer to `.^`.
 *    - `.^` is element-wise: scalar-real, or broadcastable real-elem
 *      tensors. The negative-base / non-integer-exponent lift is
 *      scalar-only for now.
 *  Codegen renders the real path as `pow(<left>, <right>)`; the
 *  complex-result path emits `cpow(...)` and the variable receiving
 *  it is typed `double _Complex`. Inside an iter loop the operand
 *  strings already reduce to per-slot scalar reads, so the same emit
 *  path covers tensor `.^` for free. */
function lowerPow(
  e: Extract<Expr, { type: "Binary" }>,
  left: IRExpr,
  right: IRExpr
): IRExpr {
  if (
    (isNumeric(left.ty) && left.ty.isComplex) ||
    (isNumeric(right.ty) && right.ty.isComplex)
  ) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on complex operands is not yet supported`,
      e.span
    );
  }
  // Mirror numbl: a statically negative base raised to a non-integer
  // constant exponent produces a complex principal-value result
  // (e.g. `(-1)^0.5 == 1i`). Without this lift the C-emitted `pow`
  // returns NaN and any program that relied on the complex root
  // silently fails. Limited to constant exponents — for a non-folded
  // exponent (variable, complex sub-expression) we keep the real path
  // since most callers feed integer exponents and a blanket lift
  // would force `(-2)^2 → 4 + ε*i`, breaking `== 4` assertions.
  const leftSign = isNumeric(left.ty) ? left.ty.sign : "unknown";
  const baseDefinitelyNegative =
    leftSign === "negative" || leftSign === "nonpositive";
  if (baseDefinitelyNegative) {
    const expVal = tryConstExprValue(right);
    if (
      expVal !== null &&
      Number.isFinite(expVal) &&
      !Number.isInteger(expVal)
    ) {
      if (!isScalar(left.ty) || !isScalar(right.ty)) {
        throw new UnsupportedConstruct(
          `binary ${e.op} producing a complex result is only supported on ` +
            `scalar operands today`,
          e.span
        );
      }
      return {
        kind: "Binary",
        op: e.op,
        left,
        right,
        ty: scalarComplex(),
        span: e.span,
      };
    }
  }
  const expVal = tryConstExprValue(right);
  const resultSign = inferPowSign(leftSign, expVal);
  if (e.op === "Pow") {
    if (!isScalar(left.ty) || !isScalar(right.ty)) {
      throw new UnsupportedConstruct(
        `binary ^ on tensors is not yet supported (matrix power; ` +
          `use .^ for elementwise instead)`,
        e.span
      );
    }
    return {
      kind: "Binary",
      op: e.op,
      left,
      right,
      ty: scalarDouble(resultSign),
      span: e.span,
    };
  }
  // ElemPow: scalar or broadcastable real tensors.
  if (isScalar(left.ty) && isScalar(right.ty)) {
    return {
      kind: "Binary",
      op: e.op,
      left,
      right,
      ty: scalarDouble(resultSign),
      span: e.span,
    };
  }
  const shape = arithResult("Add", left.ty, right.ty);
  if (!isNumeric(shape)) {
    throw new UnsupportedConstruct(
      `binary .^ on ${typeToString(left.ty)} and ${typeToString(right.ty)} ` +
        `produces an incompatible result type`,
      e.span
    );
  }
  const resultTy: NumericType = numericTypeND(shape.dims, false, resultSign);
  return {
    kind: "Binary",
    op: e.op,
    left,
    right,
    ty: resultTy,
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
  if (isHigherDim(left.ty) || isHigherDim(right.ty)) {
    throw new UnsupportedConstruct(
      `binary ${e.op} on a tensor with ndim > 2 is not yet supported ` +
        `(reshape to 2-D first; the elementwise codegen loop is still ` +
        `2-D-shaped)`,
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
