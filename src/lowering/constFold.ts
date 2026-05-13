/**
 * Compile-time constant folding for literal-kind operands.
 *
 * Stage-C consumer of Stage-A's `exact` plumbing: when both sides of a
 * binary op (or the operand of a unary op) are literal IR nodes whose
 * exact value is known, we evaluate the op at lowering time and
 * collapse the IR to a single literal node. The emitted C is the same
 * a competent C compiler would produce after its own constant-folding
 * pass — what we gain is cleaner C source, tighter type-system info
 * (the folded NumLit carries an exact-tagged scalarDouble), and a
 * foundation for branch-condition reasoning in follow-up stages.
 *
 * Scope: covers the cases that fit existing IR literal shapes —
 *   - real scalar arithmetic / comparisons / power → NumLit
 *   - char scalar ops (chars promote to double per numbl) → NumLit
 *   - pure-imaginary scalar arithmetic (ImagLit) when the result is
 *     also pure-imaginary or pure-real → ImagLit / NumLit
 *   - string concat (StringLit + StringLit) → StringLit
 * General `a + bi` complex arithmetic (mixed real + imag operand)
 * isn't folded because there's no `ComplexLit` IR node; those calls
 * fall through to the regular Binary path and get folded by C.
 */

import type {
  Span,
  BinaryOperation as BinOp,
  UnaryOperation as UnOp,
} from "../parser/index.js";
import type { IRExpr } from "./ir.js";
import {
  scalarComplex,
  scalarDouble,
  signFromValue,
  stringType,
} from "./types.js";

/** Read a scalar real value out of an IR literal: NumLit directly,
 *  scalar CharLit via its byte (numbl's char→double promotion).
 *  Returns null for any other shape. */
function asScalarReal(e: IRExpr): number | null {
  if (e.kind === "NumLit") return e.value;
  if (e.kind === "CharLit" && e.value.length === 1) {
    return e.value.charCodeAt(0);
  }
  return null;
}

/** Read the imaginary coefficient of a pure-imag literal (ImagLit
 *  carries `0 + value*i`). Returns null for anything else. */
function asPureImag(e: IRExpr): number | null {
  return e.kind === "ImagLit" ? e.value : null;
}

function numLit(value: number, span: Span): IRExpr {
  return {
    kind: "NumLit",
    value,
    ty: Number.isFinite(value)
      ? scalarDouble(signFromValue(value), value)
      : scalarDouble(signFromValue(value)),
    span,
  };
}

function imagLit(im: number, span: Span): IRExpr {
  return {
    kind: "ImagLit",
    value: im,
    ty: scalarComplex({ re: 0, im }),
    span,
  };
}

/** Logical-as-double — 1.0 for true, 0.0 for false. Mirrors numbl's
 *  `==`/`<`/etc. result shape. */
function boolLit(b: boolean, span: Span): IRExpr {
  return numLit(b ? 1 : 0, span);
}

/** Real-scalar binary fold. Both operands resolved to plain numbers
 *  via `asScalarReal`; the dispatch table covers every arith,
 *  comparison, and short-circuit logical op the parser produces.
 *  Returns null for unsupported ops (e.g. transpose ops never reach
 *  here). Pow with a negative base + non-integer exp returns null so
 *  the caller's complex-lift path can kick in. */
function foldRealBinary(
  op: BinOp,
  l: number,
  r: number,
  span: Span
): IRExpr | null {
  // Logical interpretation: numbl treats nonzero (excluding NaN) as
  // true, zero / NaN as false. JS `!Number.isNaN(x) && x !== 0` matches.
  const toBool = (x: number): boolean => !Number.isNaN(x) && x !== 0;
  switch (op) {
    case "Add":
      return numLit(l + r, span);
    case "Sub":
      return numLit(l - r, span);
    case "Mul":
    case "ElemMul":
      return numLit(l * r, span);
    case "Div":
    case "ElemDiv":
      return numLit(l / r, span);
    case "Pow":
    case "ElemPow":
      // Mirror lowerPow's complex lift: negative base + non-integer
      // exponent returns a principal-value complex result. Defer to
      // the existing path so it emits `cpow`.
      if (l < 0 && Number.isFinite(r) && !Number.isInteger(r)) return null;
      return numLit(Math.pow(l, r), span);
    case "Equal":
      return boolLit(l === r, span);
    case "NotEqual":
      return boolLit(l !== r, span);
    case "Less":
      return boolLit(l < r, span);
    case "LessEqual":
      return boolLit(l <= r, span);
    case "Greater":
      return boolLit(l > r, span);
    case "GreaterEqual":
      return boolLit(l >= r, span);
    case "AndAnd":
    case "BitAnd":
      return boolLit(toBool(l) && toBool(r), span);
    case "OrOr":
    case "BitOr":
      return boolLit(toBool(l) || toBool(r), span);
    default:
      return null;
  }
}

/** Pure-imag arithmetic that lands back on a representable literal:
 *   ImagLit ± ImagLit → ImagLit (or NumLit(0) when canceling)
 *   ImagLit * ImagLit → NumLit  (i*i = -1: `(bi)(di) = -bd`)
 *   ImagLit ./* NumLit → ImagLit (scale the imag part)
 *   NumLit * ImagLit  → ImagLit
 *   ImagLit / NumLit  → ImagLit (when the divisor is finite)
 *  Returns null for any case the existing real/complex codegen
 *  already handles cheaply (e.g. NumLit + ImagLit forms an `a+bi`
 *  that has no literal IR shape today). */
function foldImagBinary(
  op: BinOp,
  left: IRExpr,
  right: IRExpr,
  span: Span
): IRExpr | null {
  const li = asPureImag(left);
  const ri = asPureImag(right);
  const lr = asScalarReal(left);
  const rr = asScalarReal(right);
  // bi op di
  if (li !== null && ri !== null) {
    switch (op) {
      case "Add":
        return imagLit(li + ri, span);
      case "Sub":
        return imagLit(li - ri, span);
      case "Mul":
      case "ElemMul":
        // (bi)(di) = -bd  (a real number)
        return numLit(-li * ri, span);
      case "Div":
      case "ElemDiv":
        // (bi) / (di) = b/d  (a real number)
        return numLit(li / ri, span);
      default:
        return null;
    }
  }
  // a * bi  /  bi * a  → (a*b)i
  if (op === "Mul" || op === "ElemMul") {
    if (lr !== null && ri !== null) return imagLit(lr * ri, span);
    if (li !== null && rr !== null) return imagLit(li * rr, span);
  }
  // bi / a → (b/a)i  (avoid the converse a / bi which is complex)
  if (op === "Div" || op === "ElemDiv") {
    if (li !== null && rr !== null) return imagLit(li / rr, span);
  }
  return null;
}

/** String concat fold. Today only `StringLit + StringLit` qualifies —
 *  mixed string/char-array concat involves the runtime text view and
 *  isn't representable as a single literal until char-array literal
 *  IR can hold an exact text payload. */
function foldStringBinary(
  op: BinOp,
  left: IRExpr,
  right: IRExpr,
  span: Span
): IRExpr | null {
  if (op !== "Add") return null;
  if (left.kind !== "StringLit" || right.kind !== "StringLit") return null;
  const value = left.value + right.value;
  return { kind: "StringLit", value, ty: stringType(value), span };
}

/** Public binary fold entry point. Dispatches to the real / imag /
 *  string fold helpers and returns the first non-null match. */
export function tryFoldBinaryLit(
  op: BinOp,
  left: IRExpr,
  right: IRExpr,
  span: Span
): IRExpr | null {
  // String concat first — its predicate is the most specific.
  const s = foldStringBinary(op, left, right, span);
  if (s !== null) return s;
  // Pure-imag arithmetic.
  const c = foldImagBinary(op, left, right, span);
  if (c !== null) return c;
  // Real-scalar (incl. char promotion) arithmetic / comparisons / pow.
  const lr = asScalarReal(left);
  const rr = asScalarReal(right);
  if (lr !== null && rr !== null) {
    return foldRealBinary(op, lr, rr, span);
  }
  return null;
}

/** Public unary fold entry point. Returns null when no fold applies
 *  — the caller keeps its existing typed-Unary path. Plus / Minus
 *  on NumLit and ImagLit are already folded inline in
 *  `lowerUnary`; this helper covers the CharLit-scalar cases
 *  (char promotes to double) and exposes a single fold surface so
 *  later additions land in one place. */
export function tryFoldUnaryLit(
  op: UnOp,
  operand: IRExpr,
  span: Span
): IRExpr | null {
  if (operand.kind === "CharLit" && operand.value.length === 1) {
    const v = operand.value.charCodeAt(0);
    switch (op) {
      case "Plus":
        // `+'a'` keeps char identity in numbl (no promotion); leave
        // the CharLit so existing codegen handles it. Returning null
        // signals "no fold applied".
        return null;
      case "Minus":
        return numLit(-v, span);
      case "Not":
        // `~'a'` — true iff byte is zero. Scalar chars are non-zero
        // by literal construction (parser rejects empty `''`), so we
        // know the value here is nonzero and the result is 0.
        return numLit(v !== 0 ? 0 : 1, span);
      default:
        return null;
    }
  }
  return null;
}
