/**
 * Expression-level codegen.
 *
 * `emitExpr` renders an `IRExpr` into a C expression string;
 * `analyzeExpr` is the pre-walk that flips header flags
 * (`needMath` / `needComplex`) for any node that forces them. Both
 * traversals dispatch on `IRExpr.kind` and stay in lock-step so the
 * activation order (`useRuntime` calls inside builtin emit closures)
 * matches what the emitted C consumes.
 *
 * `wrapOwnedArgCopy` is the small helper that puts an owned-typed
 * user-function arg through its kind's `copy` helper at the call
 * site (copy-on-arg-pass).
 */

import type { IRExpr } from "../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  isScalar,
  isString,
  typeToString,
  type MType,
} from "../lowering/types.js";
import { forEachSubExpr } from "../lowering/walk.js";
import {
  BIN_OP_C,
  CMP_OR_LOGICAL,
  formatCharLit,
  formatNumLit,
  formatStringLit,
  precedence,
  stringLitByteLen,
  UN_OP_C,
} from "./emitFormat.js";
import { ownedOps } from "./ownedKinds.js";
import {
  builtinEmitFacade,
  useRuntimeByName,
  type EmitState,
} from "./emitState.js";

/** Copy-on-arg-pass: wrap an owned-typed argument in its kind's `copy`
 *  helper so the callee gets a freshly-owned value to manage. Tensors
 *  (real / complex) and char arrays follow this protocol; strings
 *  don't — they're not yet accepted as user-function args. Returns
 *  `inner` unchanged for non-owned arg types. Activates the chosen
 *  copy helper as a side effect. */
export function wrapOwnedArgCopy(
  state: EmitState,
  argTy: MType,
  inner: string
): string {
  const owned = ownedOps(argTy);
  if (owned === null || !isMultiElement(argTy)) return inner;
  const helper = owned.copy(argTy);
  useRuntimeByName(state, helper);
  return `${helper}(${inner})`;
}

export function emitExpr(
  state: EmitState,
  e: IRExpr,
  parentPrec: number
): string {
  // Tensor-typed sub-expressions in scalar codegen contexts are caught
  // by the lowering-pass validator (lower.ts: `validateIR`). If one
  // reaches here, the lowerer let it through — that's an internal bug.
  // Inside an iter context, multi-element Binary/Unary nodes are
  // expected (each iteration consumes one element), so we only enforce
  // the check at the top level.
  // `CharLit` is excluded: a non-owning literal handle (char scalar or
  // char array) is safe in any expression position — no allocation.
  if (
    state.iterStack.length === 0 &&
    e.kind !== "Var" &&
    e.kind !== "TensorLit" &&
    e.kind !== "CharLit" &&
    isMultiElement(e.ty)
  ) {
    throw new Error(
      `codegen internal: tensor-valued expression (${typeToString(e.ty)}) ` +
        `reached emitExpr; should have been rejected at lowering`
    );
  }

  switch (e.kind) {
    case "NumLit":
      return formatNumLit(e.value);

    case "StringLit": {
      // Build a non-owning `mtoc_string_t` whose `data` field points
      // straight at a C string literal in `.rodata`. Cheap — no
      // allocation. Activates the typedef + the helper.
      useRuntimeByName(state, "mtoc_string_t");
      useRuntimeByName(state, "mtoc_string_from_literal");
      const lit = formatStringLit(e.value);
      const len = stringLitByteLen(e.value);
      return `mtoc_string_from_literal(${lit}, ${len})`;
    }

    case "ImagLit": {
      // Render as `<value> * I`. C99's `_Complex_I` macro expands to
      // a `const float _Complex` (or `const double _Complex`) value
      // representing 0+1i; multiplying a `double` by it produces a
      // `double _Complex`. Wrap in parens so adjacent operators (e.g.
      // a unary `-`, or an Add) bind correctly. The `<complex.h>`
      // header was already activated by analyzeExpr.
      return `(${formatNumLit(e.value)} * I)`;
    }

    case "Var":
      // Inside a per-element loop, a multi-element `Var` reads the
      // current slot; scalar `Var`s broadcast unchanged. Real
      // multi-element Vars render as `<v>.real[<iter>]`; complex
      // multi-element Vars compose `<v>.real[<iter>] + <v>.imag[<iter>] * I`
      // so the resulting C value is a `double _Complex` that mixes
      // cleanly with both real and complex sub-exprs in the body.
      // Char-array Vars in iter context widen to double (char arithmetic
      // always produces double; the iter loop stores into a double
      // tensor staging buffer).
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = state.iterStack[state.iterStack.length - 1];
        if (isNumeric(e.ty) && e.ty.elem === "char") {
          return `(double)(${e.cName}.data[${iter}])`;
        }
        if (isNumeric(e.ty) && e.ty.isComplex) {
          return `(${e.cName}.real[${iter}] + ${e.cName}.imag[${iter}] * I)`;
        }
        return `${e.cName}.real[${iter}]`;
      }
      return e.cName;

    case "CharLit": {
      // Multi-element char in iter context: each iteration reads one
      // byte and widens to double for arithmetic.
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = state.iterStack[state.iterStack.length - 1];
        return `(double)(${formatStringLit(e.value)}[${iter}])`;
      }
      // Scalar char literal: render as a C char literal.
      if (isScalar(e.ty)) {
        return formatCharLit(e.value);
      }
      // Multi-element char in non-iter context: build a non-owning
      // `mtoc_char_tensor_t` pointing at the string literal in .rodata.
      useRuntimeByName(state, "mtoc_char_tensor_t");
      useRuntimeByName(state, "mtoc_char_tensor_from_literal");
      const lit = formatStringLit(e.value);
      return `mtoc_char_tensor_from_literal(${lit}, ${e.value.length})`;
    }

    case "TensorLit":
      // Tensor literals are only legal at the top level of Assign.rhs
      // (handled directly by `emitTensorLitAssign`); every other
      // position is rejected by the lowering-pass validator. Reaching
      // here means the lowerer let one through.
      throw new Error(
        "codegen internal: TensorLit reached emitExpr; should have been " +
          "rejected at lowering"
      );

    case "Call": {
      // User-function calls render as `mangled(args)`. Builtins delegate
      // to the registry's `emit` closure, which renders the C call and
      // activates any runtime helper it depends on (libm builtins return
      // a plain `cName(args)`; runtime-helper builtins also call
      // `state.useRuntime(name)`). The closure can also flip
      // `needMath` for builtins that conditionally pull in <math.h>.
      // The closure receives the arg MTypes so it can dispatch on
      // `isComplex` (e.g. `sqrt(x)` vs `sqrt(z)` → `csqrt(z)`).
      //
      // Copy-on-arg-pass: for user-function calls, every tensor-typed
      // argument is wrapped in `mtoc_tensor_copy(...)` so the callee
      // gets an owned tensor (which it may freely reassign or free at
      // scope exit). Builtins are known read-only and skip the wrap.
      const isUserCall = e.callee.kind === "userFunc";
      const argStrs = e.args.map(a => {
        const inner = emitExpr(state, a, 0);
        return isUserCall ? wrapOwnedArgCopy(state, a.ty, inner) : inner;
      });
      if (e.callee.kind === "userFunc") {
        return `${e.callee.mangled}(${argStrs.join(", ")})`;
      }
      const argTys = e.args.map(a => a.ty);
      return e.callee.sig.emit(argStrs, argTys, builtinEmitFacade(state));
    }

    case "Binary": {
      // String concatenation has its own helper; route there before
      // the numeric-binary branches.
      if (isString(e.ty)) {
        if (e.op !== "Add") {
          throw new Error(
            `codegen internal: string Binary with non-Add op ${e.op}; ` +
              `should have been rejected at lowering`
          );
        }
        useRuntimeByName(state, "mtoc_string_t");
        useRuntimeByName(state, "mtoc_string_concat");
        const left = emitExpr(state, e.left, 0);
        const right = emitExpr(state, e.right, 0);
        return `mtoc_string_concat(${left}, ${right})`;
      }
      // Comparison / logical ops with any complex operand take a
      // dedicated branch — C's bare `<`/`==`/`&&` operators don't
      // match numbl's complex semantics (real-part-only for ordering;
      // both parts for equality; toBool for `&& ||`).
      const lc = isNumeric(e.left.ty) && e.left.ty.isComplex;
      const rc = isNumeric(e.right.ty) && e.right.ty.isComplex;
      if ((lc || rc) && CMP_OR_LOGICAL.has(e.op)) {
        return emitComplexCmpOrLogical(state, e, parentPrec);
      }
      const cOp = BIN_OP_C[e.op];
      if (cOp) {
        const p = precedence(e.op);
        // Left-associative: left at p, right at p+1 to force parens on
        // equal-precedence right-nested operators.
        const inner = `${emitExpr(state, e.left, p)} ${cOp} ${emitExpr(state, e.right, p + 1)}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      if (e.op === "Pow" || e.op === "ElemPow") {
        return `pow(${emitExpr(state, e.left, 0)}, ${emitExpr(state, e.right, 0)})`;
      }
      throw new Error(
        `codegen internal: unsupported binary op ${e.op}; ` +
          `should have been caught at lowering`
      );
    }

    case "Unary": {
      // Complex `~z` (Not) is the toBool negation: 1 iff re==0 && im==0.
      if (e.op === "Not" && isNumeric(e.operand.ty) && e.operand.ty.isComplex) {
        const s = emitExpr(state, e.operand, 0);
        return `(!(creal(${s}) != 0.0 || cimag(${s}) != 0.0))`;
      }
      const cOp = UN_OP_C[e.op];
      if (!cOp) {
        throw new Error(
          `codegen internal: unsupported unary op ${e.op}; ` +
            `should have been caught at lowering`
        );
      }
      const p = precedence(e.op);
      // Parenthesize a nested unary operand to avoid C's `--`/`++` token
      // (e.g. `-(-x)` not `--x`, which would be a decrement).
      const operandStr =
        e.operand.kind === "Unary"
          ? `(${emitExpr(state, e.operand, 0)})`
          : emitExpr(state, e.operand, p);
      const inner = `${cOp}${operandStr}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
  }
}

/** Emit a comparison or logical op when at least one operand is
 *  complex. Mirrors numbl's semantics:
 *    <  <=  >  >=     real-part only
 *    ==  !=           both real and imag parts
 *    &&  ||           toBool: re != 0 || im != 0
 *  Real operands are unwrapped (no creal/cimag) since C's implicit
 *  promotion rules don't help us here — we want plain `double`s on
 *  the C side wherever the IR side is real. */
function emitComplexCmpOrLogical(
  state: EmitState,
  e: Extract<IRExpr, { kind: "Binary" }>,
  parentPrec: number
): string {
  const lc = isNumeric(e.left.ty) && e.left.ty.isComplex;
  const rc = isNumeric(e.right.ty) && e.right.ty.isComplex;
  const left = emitExpr(state, e.left, 0);
  const right = emitExpr(state, e.right, 0);
  const reOf = (s: string, isComplex: boolean): string =>
    isComplex ? `creal(${s})` : s;
  const imOf = (s: string, isComplex: boolean): string =>
    isComplex ? `cimag(${s})` : "0.0";
  const truthy = (s: string, isComplex: boolean): string =>
    isComplex ? `(creal(${s}) != 0.0 || cimag(${s}) != 0.0)` : `(${s} != 0.0)`;

  let inner: string;
  switch (e.op) {
    case "Less":
    case "LessEqual":
    case "Greater":
    case "GreaterEqual": {
      const cOp = BIN_OP_C[e.op]!;
      inner = `${reOf(left, lc)} ${cOp} ${reOf(right, rc)}`;
      break;
    }
    case "Equal": {
      inner =
        `${reOf(left, lc)} == ${reOf(right, rc)} && ` +
        `${imOf(left, lc)} == ${imOf(right, rc)}`;
      break;
    }
    case "NotEqual": {
      inner =
        `${reOf(left, lc)} != ${reOf(right, rc)} || ` +
        `${imOf(left, lc)} != ${imOf(right, rc)}`;
      break;
    }
    case "AndAnd": {
      inner = `${truthy(left, lc)} && ${truthy(right, rc)}`;
      break;
    }
    case "OrOr": {
      inner = `${truthy(left, lc)} || ${truthy(right, rc)}`;
      break;
    }
    default:
      throw new Error(
        `codegen internal: emitComplexCmpOrLogical called with op ${e.op}`
      );
  }
  // Always parenthesize at parent>=1 since the inner is a logical-style
  // expression; at top level we let it pass through.
  const p = precedence(e.op);
  return p < parentPrec ? `(${inner})` : inner;
}

/**
 * One-pass walker over an expression. Mutates `state.needMath`
 * whenever a node forces `<math.h>` (Call, Pow/ElemPow, infinite
 * NumLit) and activates any runtime snippet referenced by a Call.
 * Libm and user-function callees don't need a snippet; runtime
 * helpers do.
 *
 * Per-node analysis: runs `forEachSubExpr` so the per-node recursion
 * stays in one place. Each sub-expression flips the header flags it
 * forces, regardless of nesting depth.
 *   - Any complex-typed node forces <complex.h> (its rendering touches
 *     `I` / `creal` / `cimag` / `double _Complex`).
 *   - Non-finite NumLit / ImagLit forces <math.h> for INFINITY/NAN.
 *   - Pow / ElemPow forces <math.h> (rendered as `pow(...)`).
 *   - Any Call forces <math.h> (every builtin we currently emit lives
 *     in <math.h>; runtime-helper activation happens inside the
 *     closure when the call renders).
 */
export function analyzeExpr(state: EmitState, e: IRExpr): void {
  forEachSubExpr(e, sub => {
    if (isNumeric(sub.ty) && sub.ty.isComplex) {
      state.needComplex.value = true;
    }
    if (sub.kind === "NumLit" || sub.kind === "ImagLit") {
      if (!Number.isFinite(sub.value)) state.needMath.value = true;
      return;
    }
    if (sub.kind === "Call") {
      state.needMath.value = true;
      return;
    }
    if (sub.kind === "Binary" && (sub.op === "Pow" || sub.op === "ElemPow")) {
      state.needMath.value = true;
      return;
    }
  });
}
