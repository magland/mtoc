/**
 * C code generator — typed IR → self-contained C source string.
 *
 * Emits a single .c file with a `main()` body. Today only scalar
 * `double` variables and a tiny subset of operators are supported;
 * everything else should have been rejected upstream.
 */

import { BinaryOperation, UnaryOperation } from "../parser/index.js";
import type {
  IRExpr,
  IRFunction,
  IRProgram,
  IRStmt,
  VarBinding,
} from "../lowering/ir.js";
import {
  isMultiElement,
  isScalarComplex,
  isScalarReal,
  isNumeric,
  staticNumElements,
  typeToString,
  type NumericType,
} from "../lowering/types.js";
import type { BuiltinEmitState } from "../workspace/builtins.js";
import {
  MTOC_DISP_COMPLEX,
  MTOC_DISP_DOUBLE,
  MTOC_TENSOR_STRUCT,
  RUNTIME_HELPERS,
  type RuntimeSnippet,
} from "./runtime.js";

// Note: C-name mangling lives in lower.ts (`cNameFor`). Every IR.Var,
// IR.Assign, IR.For, IR.ReturnFromFunction and IRFunction param /
// output / assignedVars entry already carries the C identifier the
// codegen emits — emit.ts consumes those fields directly. Synthetic
// loop-counter names (`_mtoc_i`, `_mtoc_n`, etc.) and the per-tensor
// `_mtoc_<cName>_re` (and future `_im`) buffer names are still
// synthesized here.

function formatNumLit(n: number): string {
  if (Number.isNaN(n)) return "NAN";
  if (n === Infinity) return "INFINITY";
  if (n === -Infinity) return "(-INFINITY)";
  const s = String(n);
  // Force a `double` literal: append `.0` only when the JS string lacks
  // both a decimal point and an exponent (e.g. "12" → "12.0", but
  // "1.5" and "1e+308" stay as-is — adding ".0" to those is invalid C).
  if (!/[.eE]/.test(s)) {
    return `${s}.0`;
  }
  return s;
}

const BIN_OP_C: Partial<Record<BinaryOperation, string>> = {
  Add: "+",
  Sub: "-",
  Mul: "*",
  Div: "/",
  ElemMul: "*",
  ElemDiv: "/",
  Equal: "==",
  NotEqual: "!=",
  Less: "<",
  LessEqual: "<=",
  Greater: ">",
  GreaterEqual: ">=",
  AndAnd: "&&",
  OrOr: "||",
};

const UN_OP_C: Partial<Record<UnaryOperation, string>> = {
  Plus: "+",
  Minus: "-",
  Not: "!",
};

/** Higher number = tighter binding. parentPrec=0 means no parens by default. */
function precedence(op: BinaryOperation | UnaryOperation): number {
  switch (op) {
    case "OrOr":
      return 1;
    case "AndAnd":
      return 2;
    case "Equal":
    case "NotEqual":
      return 3;
    case "Less":
    case "LessEqual":
    case "Greater":
    case "GreaterEqual":
      return 4;
    case "Add":
    case "Sub":
      return 5;
    case "Mul":
    case "Div":
    case "ElemMul":
    case "ElemDiv":
      return 6;
    case "Pow":
    case "ElemPow":
      return 7;
    case "Plus":
    case "Minus":
    case "Not":
      return 8;
  }
  return 0;
}

interface EmitState {
  /** Boxed so the `BuiltinSig.emit` closure (which receives a small
   *  facade view, not the whole EmitState) can flip it. */
  needMath: { value: boolean };
  /** True when any complex value (literal, declaration, or operation)
   *  has been emitted — drives `<complex.h>` inclusion. Boxed for the
   *  same reason as `needMath`. */
  needComplex: { value: boolean };
  /** Runtime helpers used by the program, in stable order. */
  runtime: RuntimeSnippet[];
  /** Names of helpers already added to `runtime` (dedup). */
  runtimeNames: Set<string>;
  lines: string[];
  /** Stack of synthetic per-element loop-index C names. emit pushes
   *  one when it opens a per-element loop for a multi-element `Assign`
   *  RHS; the top of the stack is the innermost iter name. When the
   *  stack is non-empty, multi-element `Var`s render as
   *  `<cName>.real[<top>]` instead of `<cName>` (scalar `Var`s and
   *  `NumLit`s broadcast unchanged). Empty at the top level — scalar
   *  codegen contexts reject multi-element sub-exprs as before. */
  iterStack: string[];
  /** Counter for synthetic loop-index names so nested elementwise
   *  loops don't shadow each other. */
  elemwiseLoopCounter: number;
}

/** Build the small facade view passed to `BuiltinSig.emit` closures.
 *  Hides the full `EmitState`; exposes only what the closures need
 *  (boxed needMath + a useRuntime function). */
function builtinEmitFacade(state: EmitState): BuiltinEmitState {
  return {
    needMath: state.needMath,
    useRuntime: name => useRuntimeByName(state, name),
  };
}

function emitExpr(state: EmitState, e: IRExpr, parentPrec: number): string {
  // Tensor-typed sub-expressions in scalar codegen contexts are caught
  // by the lowering-pass validator (lower.ts: `validateIR`). If one
  // reaches here, the lowerer let it through — that's an internal bug.
  // Inside an iter context, multi-element Binary/Unary nodes are
  // expected (each iteration consumes one element), so we only enforce
  // the check at the top level.
  if (
    state.iterStack.length === 0 &&
    e.kind !== "Var" &&
    e.kind !== "TensorLit" &&
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
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = state.iterStack[state.iterStack.length - 1];
        if (isNumeric(e.ty) && e.ty.isComplex) {
          return `(${e.cName}.real[${iter}] + ${e.cName}.imag[${iter}] * I)`;
        }
        return `${e.cName}.real[${iter}]`;
      }
      return e.cName;

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
      const argStrs = e.args.map(a => emitExpr(state, a, 0));
      if (e.callee.kind === "userFunc") {
        return `${e.callee.mangled}(${argStrs.join(", ")})`;
      }
      const argTys = e.args.map(a => a.ty);
      return e.callee.sig.emit(argStrs, argTys, builtinEmitFacade(state));
    }

    case "Binary": {
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
      throw new Error(`codegen: unsupported binary op ${e.op}`);
    }

    case "Unary": {
      // Complex `~z` (Not) is the toBool negation: 1 iff re==0 && im==0.
      if (e.op === "Not" && isNumeric(e.operand.ty) && e.operand.ty.isComplex) {
        const s = emitExpr(state, e.operand, 0);
        return `(!(creal(${s}) != 0.0 || cimag(${s}) != 0.0))`;
      }
      const cOp = UN_OP_C[e.op];
      if (!cOp) throw new Error(`codegen: unsupported unary op ${e.op}`);
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

/** Binary ops that take the complex-aware branch in `emitExpr.Binary`
 *  whenever any operand is complex. (Arithmetic ops use C99's native
 *  complex operators, so they don't need this re-routing.) */
const CMP_OR_LOGICAL: ReadonlySet<BinaryOperation> = new Set<BinaryOperation>([
  BinaryOperation.Less,
  BinaryOperation.LessEqual,
  BinaryOperation.Greater,
  BinaryOperation.GreaterEqual,
  BinaryOperation.Equal,
  BinaryOperation.NotEqual,
  BinaryOperation.AndAnd,
  BinaryOperation.OrOr,
]);

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

function useRuntime(
  state: EmitState,
  name: string,
  snippet: RuntimeSnippet
): void {
  if (state.runtimeNames.has(name)) return;
  state.runtimeNames.add(name);
  // Pull in dependencies first so their definitions precede ours.
  for (const dep of snippet.deps) {
    const depSnippet = RUNTIME_HELPERS.get(dep);
    if (depSnippet) useRuntime(state, dep, depSnippet);
  }
  state.runtime.push(snippet);
}

/** Activate a snippet looked up from the registry by name. Throws if
 *  the name isn't registered — that means a codegen path is referring
 *  to a helper that doesn't exist. */
function useRuntimeByName(state: EmitState, name: string): void {
  const snippet = RUNTIME_HELPERS.get(name);
  if (!snippet) {
    throw new Error(`codegen: unknown runtime helper '${name}'`);
  }
  useRuntime(state, name, snippet);
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function pushStmt(state: EmitState, level: number, s: string): void {
  state.lines.push(`${indent(level)}${s}`);
}

/**
 * One-pass walker over an expression. Mutates `state.needMath`
 * whenever a node forces `<math.h>` (Call, Pow/ElemPow, infinite
 * NumLit) and activates any runtime snippet referenced by a Call.
 * Libm and user-function callees don't need a snippet; runtime
 * helpers do.
 */
function analyzeExpr(state: EmitState, e: IRExpr): void {
  // Any expression whose static type is complex forces <complex.h>:
  // its rendering touches `I`, `creal`, `cimag`, or a `double _Complex`
  // declaration somewhere downstream. Setting it on the way down keeps
  // the header activation centralized.
  if (isNumeric(e.ty) && e.ty.isComplex) {
    state.needComplex.value = true;
  }
  switch (e.kind) {
    case "NumLit":
      // INFINITY / NAN macros come from <math.h>.
      if (!Number.isFinite(e.value)) state.needMath.value = true;
      return;
    case "ImagLit":
      // The `I` macro and `double _Complex` type both come from
      // <complex.h>; the type-driven flag above handles activation.
      if (!Number.isFinite(e.value)) state.needMath.value = true;
      return;
    case "Var":
      return;
    case "TensorLit":
      for (const row of e.elements) for (const c of row) analyzeExpr(state, c);
      return;
    case "Call": {
      // Every builtin we currently emit lives in <math.h> (libm + the
      // mtoc runtime helpers all `#include <math.h>` themselves), so
      // any Call forces <math.h>. Runtime-helper activation happens
      // inside `BuiltinSig.emit` when the call renders — see emitExpr's
      // Call case. We don't pre-walk for activation here because emit
      // and analyze share the same traversal order, so the resulting
      // helper-list ordering matches.
      state.needMath.value = true;
      for (const a of e.args) analyzeExpr(state, a);
      return;
    }
    case "Binary":
      if (e.op === "Pow" || e.op === "ElemPow") state.needMath.value = true;
      analyzeExpr(state, e.left);
      analyzeExpr(state, e.right);
      return;
    case "Unary":
      analyzeExpr(state, e.operand);
      return;
  }
}

/**
 * Statement-level companion to `analyzeExpr`. Walks every expression
 * the statement transitively contains, plus sets `needMath` for stmts
 * whose codegen always emits a math.h call (currently only For — its
 * iteration-count formula uses floor()).
 */
function analyzeStmt(state: EmitState, s: IRStmt): void {
  switch (s.kind) {
    case "Assign":
      analyzeExpr(state, s.rhs);
      return;
    case "ExprStmt":
      analyzeExpr(state, s.expr);
      return;
    case "Disp":
      analyzeExpr(state, s.arg);
      return;
    case "If":
      analyzeExpr(state, s.cond);
      for (const t of s.thenBody) analyzeStmt(state, t);
      for (const eif of s.elseifs) {
        analyzeExpr(state, eif.cond);
        for (const t of eif.body) analyzeStmt(state, t);
      }
      if (s.elseBody) for (const t of s.elseBody) analyzeStmt(state, t);
      return;
    case "For":
      // The emitted iteration-count formula calls floor(), so any For
      // forces <math.h> regardless of what its bounds analyze to.
      state.needMath.value = true;
      analyzeExpr(state, s.start);
      analyzeExpr(state, s.step);
      analyzeExpr(state, s.end);
      for (const t of s.body) analyzeStmt(state, t);
      return;
    case "While":
      analyzeExpr(state, s.cond);
      for (const t of s.body) analyzeStmt(state, t);
      return;
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return;
  }
}

function emitStmt(state: EmitState, level: number, s: IRStmt): void {
  switch (s.kind) {
    case "Assign": {
      // `state.needMath` and runtime activations were set up by the
      // analyzeStmt pre-pass; this function only generates lines.
      // Three RHS shapes:
      //   - TensorLit: codegen writes literal values directly into
      //     `<cName>.real[idx]` slots (no runtime loop).
      //   - scalar: a single `<cName> = <expr>;` assignment.
      //   - any other multi-element expression: emit a per-element
      //     loop that walks the RHS body once per slot, with multi-
      //     element `Var`s inside reading from `<varCName>.real[<iter>]`
      //     (see `emitExpr.Var`).
      if (s.rhs.kind === "TensorLit") {
        emitTensorLitAssign(state, level, s.cName, s.rhs);
        break;
      }
      if (isScalarReal(s.ty) || isScalarComplex(s.ty)) {
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
        break;
      }
      if (isNumeric(s.ty) && isMultiElement(s.ty) && s.ty.elem === "double") {
        emitElemwiseLoop(state, level, s.cName, s.rhs);
        break;
      }
      throw new Error(
        `codegen: assignment to '${s.name}' with type ${typeToString(s.ty)} ` +
          `is not yet supported`
      );
    }

    case "ExprStmt": {
      pushStmt(state, level, `(void)(${emitExpr(state, s.expr, 0)});`);
      break;
    }

    case "Disp": {
      const ty = s.arg.ty;
      if (isScalarReal(ty)) {
        useRuntime(state, "mtoc_disp_double", MTOC_DISP_DOUBLE);
        // Non-variadic call — `int` operands auto-promote to `double`,
        // so no manual cast is needed (unlike `printf("%g", ...)`).
        pushStmt(
          state,
          level,
          `mtoc_disp_double(${emitExpr(state, s.arg, 0)});`
        );
        break;
      }
      if (isScalarComplex(ty)) {
        useRuntime(state, "mtoc_disp_complex", MTOC_DISP_COMPLEX);
        pushStmt(
          state,
          level,
          `mtoc_disp_complex(${emitExpr(state, s.arg, 0)});`
        );
        break;
      }
      if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
        // The lowering pass requires tensor `disp` args to be a Var;
        // anything else would have thrown at lowering with a span.
        if (s.arg.kind !== "Var") {
          throw new Error(
            "codegen internal: non-Var tensor disp arg reached emit; " +
              "should have been rejected at lowering"
          );
        }
        const helper = ty.isComplex
          ? "mtoc_disp_tensor_complex"
          : "mtoc_disp_tensor";
        useRuntimeByName(state, helper);
        pushStmt(state, level, `${helper}(${s.arg.cName});`);
        break;
      }
      throw new Error(
        `codegen: disp of ${typeToString(ty)} is not yet supported`
      );
    }

    case "If": {
      pushStmt(state, level, `if (${emitExpr(state, s.cond, 0)}) {`);
      for (const t of s.thenBody) emitStmt(state, level + 1, t);
      for (const eif of s.elseifs) {
        pushStmt(state, level, `} else if (${emitExpr(state, eif.cond, 0)}) {`);
        for (const t of eif.body) emitStmt(state, level + 1, t);
      }
      if (s.elseBody) {
        pushStmt(state, level, `} else {`);
        for (const t of s.elseBody) emitStmt(state, level + 1, t);
      }
      pushStmt(state, level, `}`);
      break;
    }

    case "While": {
      pushStmt(state, level, `while (${emitExpr(state, s.cond, 0)}) {`);
      for (const t of s.body) emitStmt(state, level + 1, t);
      pushStmt(state, level, `}`);
      break;
    }

    case "Break":
      pushStmt(state, level, `break;`);
      break;

    case "Continue":
      pushStmt(state, level, `continue;`);
      break;

    case "ReturnFromFunction":
      pushStmt(state, level, `return ${s.outputCName};`);
      break;

    case "For": {
      // Step is guaranteed to be a NumLit by lowering.
      if (s.step.kind !== "NumLit") {
        throw new Error("codegen: for-loop step must be a NumLit");
      }
      const v = s.cVar;
      const startStr = emitExpr(state, s.start, 0);
      const endStr = emitExpr(state, s.end, 0);
      const stepStr = formatNumLit(s.step.value);

      // MATLAB semantics: after the loop, the loop variable holds the
      // LAST in-bounds value, not one step past it. We compute the
      // iteration count up front and derive `var = start + step * i`
      // each iteration so it never advances past that last value.
      // Wrapped in a block so `_mtoc_*` helpers are scoped per-loop;
      // nested for-loops shadow them without collision.
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
      pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
      pushStmt(
        state,
        level + 1,
        `long _mtoc_n = (long)floor((_mtoc_end - _mtoc_start) / ${stepStr}) + 1;`
      );
      pushStmt(state, level + 1, `if (_mtoc_n < 0) _mtoc_n = 0;`);
      pushStmt(
        state,
        level + 1,
        `for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {`
      );
      pushStmt(state, level + 2, `${v} = _mtoc_start + ${stepStr} * _mtoc_i;`);
      for (const t of s.body) emitStmt(state, level + 2, t);
      pushStmt(state, level + 1, `}`);
      pushStmt(state, level, `}`);
      break;
    }
  }
}

/** Emit a per-element loop that walks an `Assign`'s multi-element
 *  RHS once per slot. The body expression is rendered with the loop's
 *  iter name pushed onto `state.iterStack` so multi-element `Var`s
 *  inside it read `<varCName>.real[<iter>]` (see `emitExpr.Var`).
 *  Scalar `Var`s and `NumLit`s broadcast unchanged. The loop is
 *  wrapped in a `{}` block so `_mtoc_n` is scoped per Assign; the
 *  iter name itself is fresh per call (counter on EmitState) so
 *  nested elementwise loops never shadow each other. */
function emitElemwiseLoop(
  state: EmitState,
  level: number,
  cTarget: string,
  rhs: IRExpr
): void {
  const numel = staticNumElements(rhs.ty);
  if (numel === null) {
    // Lowering rejects non-exact dims for multi-element Assign RHSs,
    // so reaching here means the lowerer let one through.
    throw new Error(
      `codegen internal: elementwise assign target '${cTarget}' has ` +
        `non-exact dims (${typeToString(rhs.ty)}); should have been ` +
        `rejected at lowering`
    );
  }
  const iterId = state.elemwiseLoopCounter++;
  const iterName = iterId === 0 ? "_mtoc_i" : `_mtoc_i${iterId}`;
  const isComplex = isNumeric(rhs.ty) && rhs.ty.isComplex;
  pushStmt(state, level, `{`);
  pushStmt(state, level + 1, `long _mtoc_n = ${numel};`);
  pushStmt(
    state,
    level + 1,
    `for (long ${iterName} = 0; ${iterName} < _mtoc_n; ${iterName}++) {`
  );
  state.iterStack.push(iterName);
  const bodyStr = emitExpr(state, rhs, 0);
  state.iterStack.pop();
  if (isComplex) {
    // Complex elementwise body: stash through a `double _Complex`
    // temp so the body is evaluated once, then split with creal /
    // cimag into the parallel real / imag buffers. Real-typed
    // sub-exprs in the body promote to complex via C99 implicit rules.
    pushStmt(state, level + 2, `double _Complex _mtoc_t = ${bodyStr};`);
    pushStmt(
      state,
      level + 2,
      `${cTarget}.real[${iterName}] = creal(_mtoc_t);`
    );
    pushStmt(
      state,
      level + 2,
      `${cTarget}.imag[${iterName}] = cimag(_mtoc_t);`
    );
  } else {
    pushStmt(state, level + 2, `${cTarget}.real[${iterName}] = ${bodyStr};`);
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(state, level, `}`);
}

/** Emit element-by-element column-major writes for a tensor literal
 *  assignment. The target's storage was set up by predeclaration, so
 *  we just write into `<name>.real[idx]` (and, for a complex literal,
 *  `<name>.imag[idx]`). The literal's element rows are nested
 *  row-major as written in source — we re-order to column-major when
 *  computing the linear index. */
function emitTensorLitAssign(
  state: EmitState,
  level: number,
  target: string,
  lit: Extract<IRExpr, { kind: "TensorLit" }>
): void {
  if (!isNumeric(lit.ty)) {
    throw new Error("codegen: tensor literal must produce a tensor type");
  }
  const ty = lit.ty as NumericType;
  if (ty.rows.kind !== "exact" || ty.cols.kind !== "exact") {
    throw new Error(
      `codegen: tensor literal with non-exact dims (got ${typeToString(ty)})`
    );
  }
  const rows = ty.rows.n;
  const cols = ty.cols.n;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cellExpr = lit.elements[r][c];
      const idx = r + c * rows;
      if (!ty.isComplex) {
        pushStmt(
          state,
          level,
          `${target}.real[${idx}] = ${emitExpr(state, cellExpr, 0)};`
        );
        continue;
      }
      // Complex literal: write both halves. Special-case structurally
      // recognizable cells so the emitted C is the same shape numbl's
      // values would print:
      //   - NumLit v       → real=v, imag=0
      //   - ImagLit v      → real=0, imag=v
      //   - else (a complex-typed expression at this slot): emit a
      //     temporary `double _Complex` and use creal / cimag. This
      //     covers nested complex Binary/Unary/Var cells.
      // Real-typed but not-NumLit cells (e.g. `x` where x is real
      // scalar) write the cell expression to `.real` and 0 to `.imag`.
      if (cellExpr.kind === "NumLit") {
        pushStmt(
          state,
          level,
          `${target}.real[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        pushStmt(state, level, `${target}.imag[${idx}] = 0.0;`);
        continue;
      }
      if (cellExpr.kind === "ImagLit") {
        pushStmt(state, level, `${target}.real[${idx}] = 0.0;`);
        pushStmt(
          state,
          level,
          `${target}.imag[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        continue;
      }
      const cellTy = cellExpr.ty;
      if (isNumeric(cellTy) && !cellTy.isComplex) {
        // Real scalar expression; promotes to (cell, 0i).
        pushStmt(
          state,
          level,
          `${target}.real[${idx}] = ${emitExpr(state, cellExpr, 0)};`
        );
        pushStmt(state, level, `${target}.imag[${idx}] = 0.0;`);
        continue;
      }
      // Generic complex cell: stash into a temp and split with
      // creal/cimag. The temp is scoped per-cell with a `{}` block so
      // adjacent cells don't collide.
      const tmp = `_mtoc_t${state.elemwiseLoopCounter++}`;
      const cellStr = emitExpr(state, cellExpr, 0);
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `double _Complex ${tmp} = ${cellStr};`);
      pushStmt(state, level + 1, `${target}.real[${idx}] = creal(${tmp});`);
      pushStmt(state, level + 1, `${target}.imag[${idx}] = cimag(${tmp});`);
      pushStmt(state, level, `}`);
    }
  }
}

/** Emit predeclarations for a {cName → VarBinding} table. Scalars
 *  become `double <cName> = 0.0;` (real) or `double _Complex <cName> = 0.0;`
 *  (complex). Multi-element real tensors get a stack-backed
 *  `mtoc_tensor_t <cName>` whose `real` points at a sibling
 *  `double _mtoc_<cName>_re[N]` buffer and whose `imag` is NULL.
 *  Multi-element complex tensors additionally allocate a parallel
 *  `double _mtoc_<cName>_im[N]` buffer and pass that as the struct's
 *  `imag` field. Activates the `mtoc_tensor_t` typedef snippet whenever
 *  any tensor is declared. */
function emitDeclarations(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>
): void {
  // Iteration order: by C identifier so the generated declaration order
  // is stable across runs.
  const cNames = [...vars.keys()].sort();
  for (const key of cNames) {
    const binding = vars.get(key)!;
    const { ty, cName } = binding;
    if (isScalarReal(ty)) {
      pushStmt(state, level, `double ${cName} = 0.0;`);
      continue;
    }
    if (isScalarComplex(ty)) {
      pushStmt(state, level, `double _Complex ${cName} = 0.0;`);
      continue;
    }
    if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
      const numel = staticNumElements(ty);
      if (numel === null) {
        throw new Error(
          `codegen internal: variable '${cName}' has dynamic dimensions ` +
            `(${typeToString(ty)}); should have been rejected at lowering`
        );
      }
      useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
      // Synthetic buffer names keyed off the C identifier (which is
      // unique within the scope). The `_mtoc_` prefix is reserved by
      // lower.ts so it can never collide with a user variable. `_re`
      // and `_im` mirror numbl's split storage; `_im` is only emitted
      // when the type is statically complex.
      const reBuf = `_mtoc_${cName}_re`;
      const r = (ty.rows as { kind: "exact"; n: number }).n;
      const c = (ty.cols as { kind: "exact"; n: number }).n;
      pushStmt(state, level, `double ${reBuf}[${numel}];`);
      if (ty.isComplex) {
        const imBuf = `_mtoc_${cName}_im`;
        pushStmt(state, level, `double ${imBuf}[${numel}];`);
        pushStmt(
          state,
          level,
          `mtoc_tensor_t ${cName} = { ${reBuf}, ${imBuf}, ${r}, ${c} };`
        );
      } else {
        pushStmt(
          state,
          level,
          `mtoc_tensor_t ${cName} = { ${reBuf}, NULL, ${r}, ${c} };`
        );
      }
      continue;
    }
    throw new Error(
      `codegen: unsupported declaration for '${cName}': ${typeToString(ty)}`
    );
  }
}

/** Emit the body of a user-defined function (predeclarations + body
 *  stmts + final return) into a fresh local-line buffer. */
function emitFunctionBody(
  state: EmitState,
  fn: IRFunction
): { lines: string[]; cReturn: string } {
  // Swap in a fresh `lines` buffer so the function's body lines don't
  // intermix with main's. Other state (runtime / needMath) is shared.
  const outerLines = state.lines;
  state.lines = [];

  emitDeclarations(state, 1, fn.assignedVars);
  for (const s of fn.body) emitStmt(state, 1, s);

  const bodyLines = state.lines;
  state.lines = outerLines;
  return { lines: bodyLines, cReturn: `return ${fn.outputCName};` };
}

/** Render the per-specialization header comment that goes above each
 *  emitted user function. Includes source location, mangled name, and
 *  the inferred type signature so the generated C is self-explanatory. */
function functionHeaderComment(fn: IRFunction): string[] {
  const labelWidth = Math.max(
    "returns".length,
    ...fn.params.map(p => p.name.length)
  );
  const pad = (s: string) => s.padEnd(labelWidth);
  const argSummary = fn.params.map(p => p.name).join(", ");
  const loc = fn.sourceLocation;
  const lineRange =
    loc.startLine === loc.endLine
      ? `${loc.startLine}`
      : `${loc.startLine}-${loc.endLine}`;
  const lines: string[] = [];
  lines.push(
    `/* User function specialization: ${fn.matlabName}(${argSummary})`
  );
  lines.push(` *   defined : ${loc.file}:${lineRange}`);
  lines.push(` *   mangled : ${fn.mangledName}`);
  for (const p of fn.params) {
    lines.push(` *   ${pad(p.name)} : ${typeToString(p.ty)}`);
  }
  lines.push(` *   ${pad("returns")} : ${typeToString(fn.returnTy)}`);
  lines.push(` */`);
  return lines;
}

function emitFunction(state: EmitState, fn: IRFunction): string[] {
  if (!isScalarReal(fn.returnTy)) {
    throw new Error(
      `codegen: function '${fn.matlabName}' has unsupported return type ${fn.returnTy.kind}`
    );
  }
  const paramList = fn.params.map(p => `double ${p.cName}`).join(", ");
  const sig = `static double ${fn.mangledName}(${paramList || "void"}) {`;
  const { lines, cReturn } = emitFunctionBody(state, fn);
  return [...functionHeaderComment(fn), sig, ...lines, `  ${cReturn}`, "}"];
}

/** Options for `emitC`. */
export interface EmitOptions {
  /** When false, the runtime-helper bodies (`mtoc_format_double`,
   *  `mtoc_disp_double`, `mtoc_tensor_t` typedef, etc.) are omitted
   *  from the output. Headers contributed solely by those snippets
   *  are likewise omitted; standard headers needed by the user code
   *  itself (`<math.h>` for `floor()` in for-loops, `<complex.h>`
   *  when complex appears) stay. The caller is then responsible for
   *  providing `mtoc_*` symbols at link time — useful when embedding
   *  mtoc output into a project that supplies its own runtime.
   *  Default: true (full self-contained translation unit). */
  includeRuntime?: boolean;
}

export function emitC(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;

  const state: EmitState = {
    needMath: { value: false },
    needComplex: { value: false },
    runtime: [],
    runtimeNames: new Set(),
    lines: [],
    iterStack: [],
    elemwiseLoopCounter: 0,
  };

  // One-pass pre-walk: activates runtime helpers referenced by the
  // program (main + every function body) AND sets `state.needMath`
  // for every node that forces <math.h>. Walking everything before
  // emitting keeps the helper ordering stable.
  for (const fn of prog.functions) {
    for (const s of fn.body) analyzeStmt(state, s);
  }
  for (const s of prog.stmts) analyzeStmt(state, s);

  // Emit user-function bodies first into separate buffers; we paste
  // them into the output below, before main.
  const functionBlocks: string[][] = prog.functions.map(fn =>
    emitFunction(state, fn)
  );

  // Predeclare every assigned variable at the top of main. Hoisting
  // keeps the C valid even when an `if` branch introduces a new
  // variable that is read after the block.
  emitDeclarations(state, 1, prog.assignedVars);
  for (const s of prog.stmts) emitStmt(state, 1, s);

  // Headers: explicit needs from user code, plus runtime-snippet
  // headers when those snippets are part of the output. With
  // `includeRuntime: false`, only the user-code-level needs survive
  // — the caller's link environment supplies whatever the runtime
  // helpers would have brought in.
  const headerSet = new Set<string>(["<stdio.h>"]);
  if (state.needMath.value) headerSet.add("<math.h>");
  if (state.needComplex.value) headerSet.add("<complex.h>");
  if (includeRuntime) {
    for (const snippet of state.runtime) {
      for (const h of snippet.headers) headerSet.add(h);
    }
  }
  const headers = [...headerSet].map(h => `#include ${h}`);

  const runtimeBlocks = includeRuntime ? state.runtime.map(s => s.code) : [];

  const out: string[] = [...headers, ""];
  for (const block of runtimeBlocks) {
    out.push(block, "");
  }
  for (const fnLines of functionBlocks) {
    out.push(...fnLines, "");
  }
  out.push("int main(void) {", ...state.lines, "  return 0;", "}", "");
  return out.join("\n");
}
