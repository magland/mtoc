/**
 * Unary-expression lowering. Folds literal-targeted unaries at lowering
 * time (so `-3` lowers as `NumLit(-3)`, not `Unary(Minus, NumLit(3))`)
 * and propagates the sign lattice on tensor operands.
 *
 * `NonConjugateTranspose` (`.'`) takes a separate path: scalar inputs
 * fold to the operand (transpose is identity on scalars); 2-D tensor
 * inputs lower to a synthetic `Call` IR node carrying a one-shot
 * `BuiltinSig` that emits `mtoc_tensor_transpose(...)` (or its complex
 * sibling). The `producesOwnedDirectly` flag routes the Call through
 * the same ANF / owned-LHS Assign pipeline as `reshape`.
 */

import type { Expr, Span, UnaryOperation as UnOp } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isHigherDim,
  isNumeric,
  isScalar,
  numericTypeND,
  scalarDouble,
  signFromValue,
  signNegate,
  type MType,
  typeToString,
} from "./types.js";
import type { BuiltinSig } from "../workspace/builtins.js";
import type { Lowerer } from "./lower.js";

const SUPPORTED_UN_OPS: ReadonlySet<UnOp> = new Set([
  "Plus",
  "Minus",
  "Not",
  "NonConjugateTranspose",
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
  if (e.op === "NonConjugateTranspose") {
    return lowerNonConjugateTranspose(operand, e.span);
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
      // `~x` is element-wise on tensors. The result is always real
      // double with sign=nonnegative (0.0/1.0); shape mirrors the
      // operand so the iter-loop codegen materializes a same-shape
      // result tensor.
      ty = numericTypeND(operand.ty.dims, false, "nonnegative");
    }
  }
  return { kind: "Unary", op: e.op, operand, ty, span: e.span };
}

/** Lower `<operand>.'` for a numeric operand. Scalar inputs (including
 *  complex and char scalars) fold to the operand unchanged — transpose
 *  is the identity on a 1×1 value. Multi-element 2-D tensor inputs
 *  lower to a `Call` to `mtoc_tensor_transpose` / its complex sibling.
 *  N-D (ndim > 2) and char arrays are rejected — those numbl runtime
 *  branches have unstable / underspecified behavior (char arrays are
 *  returned unchanged in numbl today; cross-runner parity isn't
 *  reachable until that's resolved upstream). */
function lowerNonConjugateTranspose(operand: IRExpr, span: Span): IRExpr {
  // Scalar (real, complex, or char): identity.
  if (isScalar(operand.ty)) {
    return { ...operand, span };
  }
  // Caller (lowerUnary) gated on isNumeric before dispatching here; the
  // re-check narrows `operand.ty` from `MType` to `NumericType` so the
  // field accesses below type-check without a cast.
  if (!isNumeric(operand.ty)) {
    throw new UnsupportedConstruct(
      `.' on a ${operand.ty.kind} value is not supported`,
      span
    );
  }
  if (operand.ty.elem === "char") {
    throw new UnsupportedConstruct(
      `.' on a char array is not yet supported`,
      span
    );
  }
  if (isHigherDim(operand.ty)) {
    throw new UnsupportedConstruct(
      `.' on a tensor with ndim > 2 is not yet supported`,
      span
    );
  }
  const [d0, d1] = operand.ty.dims;
  const isComplex = operand.ty.isComplex;
  const resultTy = numericTypeND([d1, d0], isComplex, operand.ty.sign);
  const helper = isComplex
    ? "mtoc_tensor_transpose_complex"
    : "mtoc_tensor_transpose";
  const sig: BuiltinSig = {
    name: "transpose",
    category: "expr",
    params: [
      {
        shape: "tensor",
        domain: null,
        elem: "double",
        complexDomain: "real-or-complex",
      },
    ],
    result: () => resultTy,
    emit: (argStrs, _argTys, state) => {
      state.useRuntime(helper);
      return `${helper}(${argStrs[0]})`;
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name: "transpose",
    callee: { kind: "builtin", sig },
    args: [operand],
    ty: resultTy,
    span,
  };
}
