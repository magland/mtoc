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
  isScalarReal,
  isTensor,
  staticNumElements,
  typeToString,
  type TensorType,
} from "../lowering/types.js";
import type { BuiltinEmitState } from "../workspace/builtins.js";
import {
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
// `_mtoc_<cName>_data` buffer name are still synthesized here.

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
  /** Runtime helpers used by the program, in stable order. */
  runtime: RuntimeSnippet[];
  /** Names of helpers already added to `runtime` (dedup). */
  runtimeNames: Set<string>;
  lines: string[];
  /** Stack of synthetic per-element loop-index C names from active
   *  `IRStmt.TensorElemwise` blocks. The top of the stack is the
   *  innermost iter name. When non-empty, multi-element `Var`s render
   *  as `<cName>.data[<top>]` instead of `<cName>` (broadcast pattern
   *  for scalar `Var`s and `NumLit`s is unchanged). Empty at the top
   *  level — scalar codegen contexts reject multi-element sub-exprs as
   *  before. */
  iterStack: string[];
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

    case "Var":
      // Inside a per-element loop, a multi-element `Var` reads the
      // current slot; scalar `Var`s broadcast unchanged.
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = state.iterStack[state.iterStack.length - 1];
        return `${e.cName}.data[${iter}]`;
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
      const argStrs = e.args.map(a => emitExpr(state, a, 0));
      if (e.callee.kind === "userFunc") {
        return `${e.callee.mangled}(${argStrs.join(", ")})`;
      }
      return e.callee.sig.emit(argStrs, builtinEmitFacade(state));
    }

    case "Binary": {
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
  switch (e.kind) {
    case "NumLit":
      // INFINITY / NAN macros come from <math.h>.
      if (!Number.isFinite(e.value)) state.needMath.value = true;
      return;
    case "Var":
      return;
    case "TensorLit":
      for (const row of e.elements)
        for (const c of row) analyzeExpr(state, c);
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
    case "TensorElemwise":
      analyzeExpr(state, s.body);
      return;
    case "If":
      analyzeExpr(state, s.cond);
      for (const t of s.thenBody) analyzeStmt(state, t);
      for (const eif of s.elseifs) {
        analyzeExpr(state, eif.cond);
        for (const t of eif.body) analyzeStmt(state, t);
      }
      if (s.elseBody)
        for (const t of s.elseBody) analyzeStmt(state, t);
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
      // Multi-element tensor RHSs are lowered to `TensorElemwise`, so
      // by the time we reach Assign the only multi-element case left is
      // a TensorLit.
      if (s.rhs.kind === "TensorLit") {
        emitTensorLitAssign(state, level, s.cName, s.rhs);
        break;
      }
      if (isScalarReal(s.ty)) {
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
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
        pushStmt(state, level, `mtoc_disp_double(${emitExpr(state, s.arg, 0)});`);
        break;
      }
      if (isTensor(ty) && isMultiElement(ty) && !ty.isComplex && ty.elem === "double") {
        // The lowering pass requires tensor `disp` args to be a Var;
        // anything else would have thrown at lowering with a span.
        if (s.arg.kind !== "Var") {
          throw new Error(
            "codegen internal: non-Var tensor disp arg reached emit; " +
              "should have been rejected at lowering"
          );
        }
        useRuntimeByName(state, "mtoc_disp_tensor");
        pushStmt(state, level, `mtoc_disp_tensor(${s.arg.cName});`);
        break;
      }
      throw new Error(
        `codegen: disp of ${typeToString(ty)} is not yet supported`
      );
    }

    case "TensorElemwise": {
      // Per-element loop emitted for tensor-result assignments. The
      // body is rendered once per element with the iter-name pushed
      // onto `state.iterStack`; multi-element `Var`s in the body then
      // read `<cName>.data[<iterCName>]` (see `emitExpr.Var`). Wrapped
      // in a block so `_mtoc_n` is scoped per stmt — nested elementwise
      // loops (not generated today) would shadow without collision.
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `long _mtoc_n = ${s.numel};`);
      pushStmt(
        state,
        level + 1,
        `for (long ${s.iterCName} = 0; ${s.iterCName} < _mtoc_n; ${s.iterCName}++) {`
      );
      state.iterStack.push(s.iterCName);
      const bodyStr = emitExpr(state, s.body, 0);
      state.iterStack.pop();
      pushStmt(
        state,
        level + 2,
        `${s.cTargetName}.data[${s.iterCName}] = ${bodyStr};`
      );
      pushStmt(state, level + 1, `}`);
      pushStmt(state, level, `}`);
      break;
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
      pushStmt(
        state,
        level + 2,
        `${v} = _mtoc_start + ${stepStr} * _mtoc_i;`
      );
      for (const t of s.body) emitStmt(state, level + 2, t);
      pushStmt(state, level + 1, `}`);
      pushStmt(state, level, `}`);
      break;
    }
  }
}

/** Emit element-by-element column-major writes for a tensor literal
 *  assignment. The target's storage was set up by predeclaration, so
 *  we just write into `<name>.data[idx]`. The literal's element rows
 *  are nested row-major as written in source — we re-order to
 *  column-major when computing the linear index. */
function emitTensorLitAssign(
  state: EmitState,
  level: number,
  target: string,
  lit: Extract<IRExpr, { kind: "TensorLit" }>
): void {
  if (!isTensor(lit.ty)) {
    throw new Error("codegen: tensor literal must produce a tensor type");
  }
  const ty = lit.ty as TensorType;
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
      pushStmt(
        state,
        level,
        `${target}.data[${idx}] = ${emitExpr(state, cellExpr, 0)};`
      );
    }
  }
}

/** Emit predeclarations for a {matlabName → VarBinding} table. Scalars
 *  become `double <cName> = 0.0;`. Multi-element tensors get a
 *  stack-backed `mtoc_tensor_t <cName>` plus an underlying
 *  `double _mtoc_<cName>_data[N]` buffer sized to the unified type's
 *  exact dims. Activates the `mtoc_tensor_t` typedef snippet whenever
 *  any tensor is declared. */
function emitDeclarations(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>
): void {
  // Iteration order: by MATLAB name so the generated declaration order
  // is stable across runs and matches the original (pre-mangling) names.
  const names = [...vars.keys()].sort();
  for (const name of names) {
    const binding = vars.get(name)!;
    const { ty, cName } = binding;
    if (isScalarReal(ty)) {
      pushStmt(state, level, `double ${cName} = 0.0;`);
      continue;
    }
    if (isTensor(ty) && isMultiElement(ty) && !ty.isComplex && ty.elem === "double") {
      const numel = staticNumElements(ty);
      if (numel === null) {
        throw new Error(
          `codegen internal: variable '${name}' has dynamic dimensions ` +
            `(${typeToString(ty)}); should have been rejected at lowering`
        );
      }
      useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
      // Synthetic buffer name keyed off the C identifier (which is
      // unique within the scope). The `_mtoc_` prefix is reserved by
      // lower.ts so it can never collide with a user variable.
      const buf = `_mtoc_${cName}_data`;
      const r = (ty.rows as { kind: "exact"; n: number }).n;
      const c = (ty.cols as { kind: "exact"; n: number }).n;
      pushStmt(state, level, `double ${buf}[${numel}];`);
      pushStmt(
        state,
        level,
        `mtoc_tensor_t ${cName} = { ${buf}, ${r}, ${c} };`
      );
      continue;
    }
    throw new Error(
      `codegen: unsupported declaration for '${name}': ${typeToString(ty)}`
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
  lines.push(`/* User function specialization: ${fn.matlabName}(${argSummary})`);
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
  const paramList = fn.params
    .map(p => `double ${p.cName}`)
    .join(", ");
  const sig = `static double ${fn.mangledName}(${paramList || "void"}) {`;
  const { lines, cReturn } = emitFunctionBody(state, fn);
  return [
    ...functionHeaderComment(fn),
    sig,
    ...lines,
    `  ${cReturn}`,
    "}",
  ];
}

export function emitC(prog: IRProgram): string {
  const state: EmitState = {
    needMath: { value: false },
    runtime: [],
    runtimeNames: new Set(),
    lines: [],
    iterStack: [],
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

  // Headers: union of explicit needs + every runtime snippet's headers.
  const headerSet = new Set<string>(["<stdio.h>"]);
  if (state.needMath.value) headerSet.add("<math.h>");
  for (const snippet of state.runtime) {
    for (const h of snippet.headers) headerSet.add(h);
  }
  const headers = [...headerSet].map(h => `#include ${h}`);

  const runtimeBlocks = state.runtime.map(s => s.code);

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
