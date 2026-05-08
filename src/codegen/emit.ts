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
} from "../lowering/ir.js";
import {
  isMultiElement,
  isScalarReal,
  isTensor,
  staticNumElements,
  typeToString,
  type MType,
  type TensorType,
} from "../lowering/types.js";
import {
  MTOC_DISP_DOUBLE,
  MTOC_TENSOR_STRUCT,
  RUNTIME_HELPERS,
  type RuntimeSnippet,
} from "./runtime.js";

// Reserved C identifiers that need mangling. Mirrors numbl's
// cJit/codegen.ts list.
const C_RESERVED: ReadonlySet<string> = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "main",
]);

function mangle(name: string): string {
  return C_RESERVED.has(name) ? `v_${name}` : name;
}

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

function emitExpr(e: IRExpr, parentPrec: number): string {
  // Tensor-typed sub-expressions can only be materialized via the
  // dedicated tensor-assignment path (which uses emitElementwise +
  // a per-element loop). If we land in `emitExpr` with a tensor
  // result, the caller is trying to use the tensor in a context that
  // requires a single C value (printf arg, function call arg, etc.).
  // Today the workaround is to assign to an intermediate variable
  // first; eventually we'll lift these to temporaries automatically.
  if (e.kind !== "Var" && e.kind !== "TensorLit" && isMultiElement(e.ty)) {
    throw new Error(
      `codegen: tensor-valued expression (${typeToString(e.ty)}) cannot ` +
        `appear here yet — assign it to a variable first and then use ` +
        `the variable. Auto-materialization of tensor temporaries is on ` +
        `the roadmap.`
    );
  }

  switch (e.kind) {
    case "NumLit":
      return formatNumLit(e.value);

    case "Var":
      return mangle(e.name);

    case "TensorLit":
      // Tensor literals don't have a useful "C expression" form — they
      // need to write into a known target buffer. The Assign handler
      // intercepts TensorLit RHS directly. Reaching here means a tensor
      // literal showed up somewhere we don't yet support (inside an
      // arithmetic expression, as a function argument, etc.).
      throw new Error(
        "codegen: tensor literals are only supported as the right-hand " +
          "side of an assignment so far"
      );

    case "Call": {
      // Activation of mtoc_* helpers is handled by `collectBuiltinHelpers`
      // before `emitExpr` is called.
      const argList = e.args.map(a => emitExpr(a, 0)).join(", ");
      return `${e.cFunc}(${argList})`;
    }

    case "Binary": {
      const cOp = BIN_OP_C[e.op];
      if (cOp) {
        const p = precedence(e.op);
        // Left-associative: left at p, right at p+1 to force parens on
        // equal-precedence right-nested operators.
        const inner = `${emitExpr(e.left, p)} ${cOp} ${emitExpr(e.right, p + 1)}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      if (e.op === "Pow" || e.op === "ElemPow") {
        return `pow(${emitExpr(e.left, 0)}, ${emitExpr(e.right, 0)})`;
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
          ? `(${emitExpr(e.operand, 0)})`
          : emitExpr(e.operand, p);
      const inner = `${cOp}${operandStr}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
  }
}

interface EmitState {
  needMath: boolean;
  /** Runtime helpers used by the program, in stable order. */
  runtime: RuntimeSnippet[];
  /** Names of helpers already added to `runtime` (dedup). */
  runtimeNames: Set<string>;
  lines: string[];
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

/** Walks an expression to decide whether <math.h> must be included. */
function exprNeedsMath(e: IRExpr): boolean {
  switch (e.kind) {
    case "NumLit":
      // INFINITY / NAN macros come from <math.h>.
      return !Number.isFinite(e.value);
    case "Var":
      return false;
    case "TensorLit":
      return e.elements.some(row => row.some(c => exprNeedsMath(c)));
    case "Call":
      // Every builtin we currently emit lives in <math.h>; if that ever
      // changes, look up `getScalarBuiltin(e.name).needsMath` instead.
      return true;
    case "Binary":
      if (e.op === "Pow" || e.op === "ElemPow") return true;
      return exprNeedsMath(e.left) || exprNeedsMath(e.right);
    case "Unary":
      return exprNeedsMath(e.operand);
  }
}

/** Walks an expression and activates any runtime helper its Calls
 *  reference (e.g. `mtoc_mod`, `mtoc_sign`). Libm names are skipped. */
function activateExprHelpers(state: EmitState, e: IRExpr): void {
  switch (e.kind) {
    case "NumLit":
    case "Var":
      return;
    case "TensorLit":
      for (const row of e.elements)
        for (const c of row) activateExprHelpers(state, c);
      return;
    case "Call": {
      // Libm names + user-function specializations don't have a runtime
      // helper; only mtoc_* helper names appear in RUNTIME_HELPERS.
      const snippet = RUNTIME_HELPERS.get(e.cFunc);
      if (snippet) useRuntime(state, e.cFunc, snippet);
      for (const a of e.args) activateExprHelpers(state, a);
      return;
    }
    case "Binary":
      activateExprHelpers(state, e.left);
      activateExprHelpers(state, e.right);
      return;
    case "Unary":
      activateExprHelpers(state, e.operand);
      return;
  }
}

function activateStmtHelpers(state: EmitState, s: IRStmt): void {
  switch (s.kind) {
    case "Assign":
      activateExprHelpers(state, s.rhs);
      return;
    case "ExprStmt":
      activateExprHelpers(state, s.expr);
      return;
    case "Disp":
      activateExprHelpers(state, s.arg);
      return;
    case "If":
      activateExprHelpers(state, s.cond);
      for (const t of s.thenBody) activateStmtHelpers(state, t);
      for (const eif of s.elseifs) {
        activateExprHelpers(state, eif.cond);
        for (const t of eif.body) activateStmtHelpers(state, t);
      }
      if (s.elseBody)
        for (const t of s.elseBody) activateStmtHelpers(state, t);
      return;
    case "For":
      activateExprHelpers(state, s.start);
      activateExprHelpers(state, s.step);
      activateExprHelpers(state, s.end);
      for (const t of s.body) activateStmtHelpers(state, t);
      return;
    case "While":
      activateExprHelpers(state, s.cond);
      for (const t of s.body) activateStmtHelpers(state, t);
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
      if (s.rhs.kind === "TensorLit") {
        emitTensorLitAssign(state, level, s.name, s.rhs);
        break;
      }
      if (isScalarReal(s.ty)) {
        if (exprNeedsMath(s.rhs)) state.needMath = true;
        pushStmt(state, level, `${mangle(s.name)} = ${emitExpr(s.rhs, 0)};`);
        break;
      }
      if (isMultiElement(s.ty)) {
        emitTensorElemwiseAssign(state, level, s.name, s.rhs, s.ty);
        break;
      }
      throw new Error(
        `codegen: assignment to '${s.name}' with type ${typeToString(s.ty)} ` +
          `is not yet supported`
      );
    }

    case "ExprStmt": {
      if (exprNeedsMath(s.expr)) state.needMath = true;
      pushStmt(state, level, `(void)(${emitExpr(s.expr, 0)});`);
      break;
    }

    case "Disp": {
      const ty = s.arg.ty;
      if (isScalarReal(ty)) {
        if (exprNeedsMath(s.arg)) state.needMath = true;
        useRuntime(state, "mtoc_disp_double", MTOC_DISP_DOUBLE);
        // Non-variadic call — `int` operands auto-promote to `double`,
        // so no manual cast is needed (unlike `printf("%g", ...)`).
        pushStmt(state, level, `mtoc_disp_double(${emitExpr(s.arg, 0)});`);
        break;
      }
      if (isTensor(ty) && isMultiElement(ty) && !ty.isComplex && ty.elem === "double") {
        // Today only Var args are supported — tensor literals or other
        // expressions would need a temporary, which we'll add when we
        // teach the codegen to materialize tensor expressions.
        if (s.arg.kind !== "Var") {
          throw new Error(
            "codegen: disp of a tensor expression is only supported for " +
              "variables; assign the value to a name first"
          );
        }
        useRuntimeByName(state, "mtoc_disp_tensor");
        pushStmt(state, level, `mtoc_disp_tensor(${mangle(s.arg.name)});`);
        break;
      }
      throw new Error(
        `codegen: disp of ${typeToString(ty)} is not yet supported`
      );
    }

    case "If": {
      if (exprNeedsMath(s.cond)) state.needMath = true;
      pushStmt(state, level, `if (${emitExpr(s.cond, 0)}) {`);
      for (const t of s.thenBody) emitStmt(state, level + 1, t);
      for (const eif of s.elseifs) {
        if (exprNeedsMath(eif.cond)) state.needMath = true;
        pushStmt(state, level, `} else if (${emitExpr(eif.cond, 0)}) {`);
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
      if (exprNeedsMath(s.cond)) state.needMath = true;
      pushStmt(state, level, `while (${emitExpr(s.cond, 0)}) {`);
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
      pushStmt(state, level, `return ${mangle(s.outputVar)};`);
      break;

    case "For": {
      // Step is guaranteed to be a NumLit by lowering.
      if (s.step.kind !== "NumLit") {
        throw new Error("codegen: for-loop step must be a NumLit");
      }
      // floor() comes from <math.h>; the iteration-count formula needs it.
      state.needMath = true;
      if (exprNeedsMath(s.start) || exprNeedsMath(s.end)) state.needMath = true;

      const v = mangle(s.var);
      const startStr = emitExpr(s.start, 0);
      const endStr = emitExpr(s.end, 0);
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

/**
 * Emit a single-element expression in "tensor element" context.
 *
 * Behaves like `emitExpr` for the most part, but where the scalar
 * version emits a tensor `Var` as `name`, this version emits
 * `name.data[_mtoc_i]` so the surrounding per-element loop reads/writes
 * the right slot. Scalar `Var`s (and NumLits) pass through unchanged —
 * they get broadcast across the loop body.
 *
 * Constructs we don't yet support inside tensor expressions throw —
 * the assign-level orchestration only invokes this for arithmetic on
 * tensor `Var`s + scalar literals/vars.
 */
function emitElementwise(e: IRExpr, parentPrec: number): string {
  switch (e.kind) {
    case "NumLit":
      return formatNumLit(e.value);
    case "Var":
      if (isMultiElement(e.ty)) {
        return `${mangle(e.name)}.data[_mtoc_i]`;
      }
      return mangle(e.name);
    case "TensorLit":
      throw new Error(
        "codegen: nested tensor literal inside a tensor expression " +
          "is not yet supported; assign the literal to a name first"
      );
    case "Call":
      throw new Error(
        "codegen: function calls inside a tensor expression are not " +
          "yet supported"
      );
    case "Binary": {
      const cOp = BIN_OP_C[e.op];
      if (cOp) {
        const p = precedence(e.op);
        const inner =
          `${emitElementwise(e.left, p)} ${cOp} ` +
          `${emitElementwise(e.right, p + 1)}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      if (e.op === "Pow" || e.op === "ElemPow") {
        return `pow(${emitElementwise(e.left, 0)}, ${emitElementwise(e.right, 0)})`;
      }
      throw new Error(
        `codegen: binary op ${e.op} not supported in tensor expression`
      );
    }
    case "Unary": {
      const cOp = UN_OP_C[e.op];
      if (!cOp) throw new Error(`codegen: unary op ${e.op}`);
      const p = precedence(e.op);
      const operandStr =
        e.operand.kind === "Unary"
          ? `(${emitElementwise(e.operand, 0)})`
          : emitElementwise(e.operand, p);
      const inner = `${cOp}${operandStr}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
  }
}

/** Emit an elementwise tensor assignment as a per-element loop. The
 *  target has already been predeclared with the right storage; we
 *  just walk the RHS and write each slot. */
function emitTensorElemwiseAssign(
  state: EmitState,
  level: number,
  targetName: string,
  rhs: IRExpr,
  ty: MType
): void {
  const numel = staticNumElements(ty);
  if (numel === null) {
    throw new Error(
      `codegen: tensor assignment with dynamic dimensions ` +
        `(${typeToString(ty)}) is not yet supported`
    );
  }
  if (exprNeedsMath(rhs)) state.needMath = true;
  const target = mangle(targetName);
  pushStmt(state, level, `{`);
  pushStmt(state, level + 1, `long _mtoc_n = ${numel};`);
  pushStmt(
    state,
    level + 1,
    `for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {`
  );
  pushStmt(
    state,
    level + 2,
    `${target}.data[_mtoc_i] = ${emitElementwise(rhs, 0)};`
  );
  pushStmt(state, level + 1, `}`);
  pushStmt(state, level, `}`);
}

/** Emit element-by-element column-major writes for a tensor literal
 *  assignment. The target's storage was set up by predeclaration, so
 *  we just write into `<name>.data[idx]`. The literal's element rows
 *  are nested row-major as written in source — we re-order to
 *  column-major when computing the linear index. */
function emitTensorLitAssign(
  state: EmitState,
  level: number,
  targetName: string,
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
  const target = mangle(targetName);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cellExpr = lit.elements[r][c];
      if (exprNeedsMath(cellExpr)) state.needMath = true;
      const idx = r + c * rows;
      pushStmt(
        state,
        level,
        `${target}.data[${idx}] = ${emitExpr(cellExpr, 0)};`
      );
    }
  }
}

/** Emit predeclarations for a {name → type} table. Scalars become
 *  `double <name> = 0.0;`. Multi-element tensors get a stack-backed
 *  `mtoc_tensor_t <name>` plus an underlying `double <name>_data[N]`
 *  buffer sized to the unified type's exact dims. Activates the
 *  `mtoc_tensor_t` typedef snippet whenever any tensor is declared. */
function emitDeclarations(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, MType>
): void {
  const names = [...vars.keys()].sort();
  for (const name of names) {
    const ty = vars.get(name)!;
    if (isScalarReal(ty)) {
      pushStmt(state, level, `double ${mangle(name)} = 0.0;`);
      continue;
    }
    if (isTensor(ty) && isMultiElement(ty) && !ty.isComplex && ty.elem === "double") {
      const numel = staticNumElements(ty);
      if (numel === null) {
        throw new Error(
          `codegen: variable '${name}' has dynamic dimensions ` +
            `(${typeToString(ty)}); dynamic-size tensors are not yet ` +
            `supported. Try keeping the tensor's shape constant across ` +
            `all assignments.`
        );
      }
      useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
      const buf = `_mtoc_${mangle(name)}_data`;
      const r = (ty.rows as { kind: "exact"; n: number }).n;
      const c = (ty.cols as { kind: "exact"; n: number }).n;
      pushStmt(state, level, `double ${buf}[${numel}];`);
      pushStmt(
        state,
        level,
        `mtoc_tensor_t ${mangle(name)} = { ${buf}, ${r}, ${c} };`
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
  return { lines: bodyLines, cReturn: `return ${mangle(fn.outputVar)};` };
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
    .map(p => `double ${mangle(p.name)}`)
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
    needMath: false,
    runtime: [],
    runtimeNames: new Set(),
    lines: [],
  };

  // Activate runtime helpers referenced by the program (main + every
  // function body). Walking everything before emitting keeps the helper
  // ordering stable.
  for (const fn of prog.functions) {
    for (const s of fn.body) activateStmtHelpers(state, s);
  }
  for (const s of prog.stmts) activateStmtHelpers(state, s);

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
  if (state.needMath) headerSet.add("<math.h>");
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
