/**
 * Function-call lowering: builtins (libm + mtoc runtime helpers) and
 * user-defined functions. User functions are lazily specialized on
 * the (shape, sign, …) tuple of their argument types so each call
 * site gets the most-precise return type.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { offsetToLine } from "../parser/sourceLoc.js";
import {
  getBuiltin,
  type BuiltinSig,
  type ParamConstraint,
} from "../workspace/builtins.js";
import type { FunctionStmt } from "../workspace/workspace.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr, IRFunction } from "./ir.js";
import {
  arithResult,
  canonicalizeType,
  isMultiElement,
  isOwned,
  isScalar,
  isScalarReal,
  isStruct,
  isNumeric,
  isVector,
  scalarDouble,
  signIsNonneg,
  signIsPositive,
  type DimInfo,
  type MType,
  type NumericType,
  typeToString,
} from "./types.js";
import { Lowerer, assertNotMtocReserved, cNameFor } from "./lower.js";
import { lowerIndexLoad } from "./lowerIndexLoad.js";
import { lowerIndexSlice } from "./lowerIndexSlice.js";
import { isSliceArg } from "./indexResolve.js";

/** Top-level dispatcher for `name(args)` syntax. Splits out the
 *  reserved `disp` (only valid as a stmt) and routes user functions
 *  vs builtins. */
export function lowerFuncCall(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncCall" }>
): IRExpr {
  // MATLAB rule: a name that resolves to an in-scope variable shadows
  // any function with the same name. The parser produces `FuncCall`
  // for both `f(x)` (call) and `v(i)` (index); we disambiguate here.
  // The `IndexSlice` path handles any slot that's a `Range` or
  // bare `Colon`; everything else is scalar-index `IndexLoad`.
  if (this.envLookup(e.name) !== undefined) {
    if (e.args.some(isSliceArg)) {
      return lowerIndexSlice.call(this, e.name, e.args, e.span);
    }
    return lowerIndexLoad.call(this, e.name, e.args, e.span);
  }
  const target = this.shared.workspace.resolve(
    e.name,
    { file: this.currentFile },
    e.span
  );
  if (!target) {
    throw new UnsupportedConstruct(
      `unresolved function or builtin '${e.name}'`,
      e.span
    );
  }
  if (target.kind === "userFunction") {
    return lowerUserCall.call(
      this,
      target.name,
      target.ast,
      target.file,
      e.args,
      e.span
    );
  }
  // Statement-only builtins (today: `disp`, `error`) cannot appear at
  // expression position. Lowering of `ExprStmt(disp(...))` /
  // `ExprStmt(error(...))` short-circuits in lower.ts before reaching
  // here; any other position is rejected with a span.
  const builtin = getBuiltin(e.name);
  if (builtin && builtin.category === "stmt") {
    throw new UnsupportedConstruct(
      `'${e.name}' is a statement-only builtin and cannot be used as a ` +
        `value-producing call`,
      e.span
    );
  }
  return lowerBuiltinCall.call(this, e.name, e.args, e.span);
}

/** Lower a builtin call. Walks the builtin's `params` for shape +
 *  sign-domain validation, asks the builtin for its result type, and
 *  produces an `IRExpr.Call` whose `callee` carries a reference to
 *  the typed `BuiltinSig` (the closure that renders the C call). */
export function lowerBuiltinCall(
  this: Lowerer,
  name: string,
  argExprs: Expr[],
  span: Span
): IRExpr {
  return lowerBuiltinCallWithArgs.call(
    this,
    name,
    argExprs.map(a => this.lowerExpr(a)),
    span
  );
}

/** Same as `lowerBuiltinCall` but consumes already-lowered args. Used
 *  by callers that needed to peek at an arg's type before deciding
 *  which builtin path to take (e.g. `length`/`numel` string folding).
 *  Re-lowering would replay any lowering side effects. */
export function lowerBuiltinCallWithArgs(
  this: Lowerer,
  name: string,
  args: IRExpr[],
  span: Span
): IRExpr {
  const builtin = getBuiltin(name);
  if (!builtin) {
    throw new UnsupportedConstruct(
      `builtin '${name}' is not yet supported`,
      span
    );
  }
  // Optional `lowerExpr` override: lets a builtin constant-fold or
  // rewrite the call before standard validation runs (e.g.
  // `length(string)` folds to `NumLit(1)` regardless of the registry's
  // shape: "tensor" constraint, since strings aren't tensors).
  // Variadic builtins (`size`, `reshape`, ...) own their arity check
  // here; the declared `params` length covers only the default path.
  // Returning null defers to the standard path below.
  if (builtin.lowerExpr) {
    const overridden = builtin.lowerExpr(this, args, span);
    if (overridden !== null) return overridden;
  }
  if (args.length !== builtin.params.length) {
    throw new UnsupportedConstruct(
      `${name} expects ${builtin.params.length} argument(s), got ${args.length}`,
      span
    );
  }
  const argLabel = (i: number): string =>
    builtin.params.length === 1 ? "x" : `arg ${i + 1}`;

  // Elementwise lift: when every param is shape: "scalar" but at least
  // one arg is a multi-element numeric (double-elem) tensor, the call
  // becomes elementwise. Per-slot rendering is handled by the existing
  // iter-loop codegen (`emitTensorAssignFromExpr`); here we only need
  // to validate the args against their scalar-equivalent constraints
  // and widen the builtin's scalar result type to the broadcast shape.
  if (isElementwiseEligible(builtin, args)) {
    const shape = broadcastNumericShape(args.map(a => a.ty));
    if (shape === null) {
      throw new TypeError(
        `${name}: cannot broadcast arguments with incompatible shapes ` +
          `(${args.map(a => typeToString(a.ty)).join(", ")})`,
        span
      );
    }
    for (let i = 0; i < args.length; i++) {
      const constraint = builtin.params[i];
      // Shape check: scalar-real-only params still reject complex args
      // (matches the scalar path); the actual shape mismatch isn't an
      // error here — it's the whole point of the lift.
      validateComplexDomain(name, constraint, args[i], argLabel(i), span);
      validateDomain(name, constraint, args[i], argLabel(i), span);
    }
    const scalarArgTys = args.map(a => scalarifyType(a.ty));
    let scalarResult: MType;
    try {
      scalarResult = builtin.result(scalarArgTys);
    } catch (err) {
      if (err instanceof TypeError && err.span === null) {
        throw new TypeError(err.message, span);
      }
      throw err;
    }
    if (!isNumeric(scalarResult)) {
      throw new TypeError(
        `internal: builtin '${name}' produced non-numeric result type ` +
          `${typeToString(scalarResult)} for elementwise-lifted call`,
        span
      );
    }
    const resultTy: NumericType = { ...scalarResult, dims: shape };
    return {
      kind: "Call",
      name,
      callee: { kind: "builtin", sig: builtin },
      args,
      ty: resultTy,
      span,
    };
  }

  // Per-arg shape + complex-domain + sign-domain validation, all driven
  // by ParamConstraint. Order matters: the complex-domain check runs
  // before the sign-domain check so a complex arg fails with "cannot
  // accept a complex argument" rather than a confusing sign error.
  for (let i = 0; i < args.length; i++) {
    const constraint = builtin.params[i];
    validateShape(name, builtin, constraint, args[i], argLabel(i));
    validateComplexDomain(name, constraint, args[i], argLabel(i), span);
    validateDomain(name, constraint, args[i], argLabel(i), span);
  }
  // The builtin computes its own result MType from the lowered arg
  // types — captures arg-sign-preserving reductions (sum), fixed-sign
  // libm wrappers (sqrt → nonneg), etc. May throw TypeError; rewrap
  // with the call's span if the throw landed without one.
  const argTys: MType[] = args.map(a => a.ty);
  let resultTy: MType;
  try {
    resultTy = builtin.result(argTys);
  } catch (err) {
    if (err instanceof TypeError && err.span === null) {
      throw new TypeError(err.message, span);
    }
    throw err;
  }
  return {
    kind: "Call",
    name,
    callee: { kind: "builtin", sig: builtin },
    args,
    ty: resultTy,
    span,
  };
}

/** True when the builtin's params are all `shape: "scalar"`. Such a
 *  builtin is element-wise by construction — it operates on one slot
 *  at a time, so passing a tensor argument means "apply once per
 *  element". `isElementwiseBuiltin` is the per-sig predicate used by
 *  both lowering (this file) and the IR validator (`validateIR`). */
export function isElementwiseBuiltin(sig: BuiltinSig): boolean {
  return sig.params.every(p => p.shape === "scalar");
}

/** Whether `args` constitute an elementwise lift of a `builtin` call:
 *  the builtin is elementwise-shaped, at least one arg is a
 *  multi-element double-elem numeric, and every arg is a double-elem
 *  numeric (char tensors fall through to the original validation,
 *  which rejects them). */
function isElementwiseEligible(
  builtin: BuiltinSig,
  args: ReadonlyArray<IRExpr>
): boolean {
  if (!isElementwiseBuiltin(builtin)) return false;
  let anyMultiElement = false;
  for (const a of args) {
    if (!isNumeric(a.ty)) return false;
    if (a.ty.elem !== "double") return false;
    if (isMultiElement(a.ty)) anyMultiElement = true;
  }
  return anyMultiElement;
}

/** Drop the dims of a numeric type down to 1×1 (all axes `one`) while
 *  preserving `elem`, `isComplex`, and `sign`. Used to "scalarify" an
 *  element-wise-lifted call's arg types before asking the builtin for
 *  its scalar-equivalent result type; the call site then widens that
 *  result back up to the broadcast shape. */
function scalarifyType(t: MType): MType {
  if (!isNumeric(t)) return t;
  const one: DimInfo = { kind: "one" };
  return { ...t, dims: [one, one] };
}

/** Broadcast shape across a list of numeric arg types — the dim of the
 *  largest-shaped operand per axis (`scalar ⊙ tensor → tensor`,
 *  `tensor ⊙ same-shape tensor → same`, rowVec ⊙ colVec → null).
 *  Returns just the dims array (sign/complex/elem are recomputed by
 *  the builtin's `result` closure). Returns null if any pair is
 *  shape-incompatible (mirrors `arithResult`'s Unknown). */
function broadcastNumericShape(
  tys: ReadonlyArray<MType>
): readonly DimInfo[] | null {
  let acc: MType = scalarDouble("unknown");
  for (const t of tys) {
    if (!isNumeric(t)) return null;
    acc = arithResult("Add", acc, t);
    if (!isNumeric(acc)) return null;
  }
  return acc.dims;
}

function validateShape(
  name: string,
  builtin: BuiltinSig,
  constraint: ParamConstraint,
  arg: IRExpr,
  argLabel: string
): void {
  const argTy = arg.ty;
  switch (constraint.shape) {
    case "any":
      return;
    case "scalar":
      // Real-only "scalar" rejects complex; "real-or-complex"/"complex-only"
      // admit complex scalars too. The complex-domain check
      // (`validateComplexDomain`) runs separately and catches the
      // mismatched-complex case with a more specific message; here we
      // only test the shape (scalar-ness) when complex is allowed.
      {
        const allowsComplex = constraint.complexDomain !== "real-only";
        const ok = allowsComplex ? isScalar(argTy) : isScalarReal(argTy);
        if (!ok) {
          throw new UnsupportedConstruct(
            `${name} ${argLabel} must be a ` +
              `${allowsComplex ? "scalar" : "real scalar"} ` +
              `(got ${typeToString(argTy)})`,
            arg.span
          );
        }
      }
      return;
    case "vector":
      if (!isVector(argTy)) {
        throw new UnsupportedConstruct(
          `${name} ${argLabel} must be a vector (got ${typeToString(argTy)})`,
          arg.span
        );
      }
      return;
    case "tensor":
      if (!isMultiElement(argTy)) {
        throw new UnsupportedConstruct(
          `${name} ${argLabel} must be a non-scalar tensor (got ${typeToString(argTy)})`,
          arg.span
        );
      }
      return;
  }
  // Element-kind validation would live here once we have something
  // other than "double" to compare against; for now `elem` is purely
  // declarative.
  void builtin;
}

/** Reject a complex argument when the param's `complexDomain` doesn't
 *  admit one. Conversely, reject a real argument at a `complex-only`
 *  slot. The error is a plain `TypeError` with the call's span so the
 *  user sees the source location. */
function validateComplexDomain(
  name: string,
  constraint: ParamConstraint,
  arg: IRExpr,
  argLabel: string,
  span: Span
): void {
  const argTy = arg.ty;
  if (!isNumeric(argTy)) return;
  if (constraint.complexDomain === "real-only" && argTy.isComplex) {
    throw new TypeError(
      `${name} ${argLabel} cannot accept a complex argument ` +
        `(got ${typeToString(argTy)})`,
      span
    );
  }
  if (constraint.complexDomain === "complex-only" && !argTy.isComplex) {
    throw new TypeError(
      `${name} ${argLabel} requires a complex argument ` +
        `(got ${typeToString(argTy)})`,
      span
    );
  }
}

function validateDomain(
  name: string,
  constraint: ParamConstraint,
  arg: IRExpr,
  argLabel: string,
  span: Span
): void {
  const dom = constraint.domain;
  if (!dom) return;
  const argTy = arg.ty;
  // Sign is meaningless on complex inputs (the type-system invariant
  // pins it to "unknown"), and the complex sibling implementation
  // (e.g. `csqrt`) is total — so the real-side sign-domain check is
  // moot. Skip when the arg is complex.
  if (isNumeric(argTy) && argTy.isComplex) return;
  const argSign = isNumeric(argTy) ? argTy.sign : "unknown";
  const ok =
    dom === "nonnegative" ? signIsNonneg(argSign) : signIsPositive(argSign);
  if (!ok) {
    throw new TypeError(
      `${name} requires ${argLabel} to be statically ${dom} ` +
        `(got sign='${argSign}'). ` +
        `Use abs(...) or restructure the expression.`,
      span
    );
  }
}

/** Lower a user-function call in *expression position*. Returns an
 *  IRExpr.Call with `callee.kind="userFunc"`. Multi-output (`N≥2`)
 *  and zero-output user functions cannot appear here — they require
 *  the statement-form `MultiAssignCall` lowering (see `lowerMultiAssignCall`)
 *  because their C ABI is `void` + out-pointers, not return-by-value.
 *  Specializes the callee on its argument-type tuple (or reuses an
 *  existing specialization). */
export function lowerUserCall(
  this: Lowerer,
  name: string,
  fnAst: FunctionStmt,
  fnFile: string,
  argExprs: Expr[],
  span: Span
): IRExpr {
  if (fnAst.outputs.length === 0) {
    throw new UnsupportedConstruct(
      `function '${name}' has no outputs and cannot be used in an ` +
        `expression position; call it as a bare statement instead`,
      span
    );
  }
  if (fnAst.outputs.length !== 1) {
    throw new UnsupportedConstruct(
      `function '${name}' has ${fnAst.outputs.length} outputs and cannot be ` +
        `used in an expression position; assign via ` +
        `\`[a, b, ...] = ${name}(...)\` (or call as a bare statement to drop ` +
        `all outputs)`,
      span
    );
  }
  const spec = specializeUserCall.call(
    this,
    name,
    fnAst,
    fnFile,
    argExprs,
    span
  );
  return {
    kind: "Call",
    name,
    callee: { kind: "userFunc", mangled: spec.mangledName },
    args: spec.args,
    ty: spec.spec.outputs[0].ty,
    span,
  };
}

/** Lower a statement-position user-function call:
 *    [a, b] = foo(x);     // lvalues.length >= 1, names + ignores
 *    foo(x);              // lvalues.length === 0  (drop-all)
 *  Returns an `IRStmt` of one of three shapes depending on the
 *  callee's output count:
 *    - 1 output, 1 named lvalue       → `IRStmt.Assign`
 *    - 1 output, 1 ignored lvalue     → `IRStmt.ExprStmt(Call)`  (drop)
 *    - 1 output, 0 lvalues            → `IRStmt.ExprStmt(Call)`  (drop)
 *    - 0 or N≥2 outputs               → `IRStmt.MultiAssignCall`
 *  The 1-output paths reuse the existing return-by-value C ABI.
 *  Multi-output / zero-output go through `MultiAssignCall` because
 *  their C ABI is `void` + out-pointers, which has no return value
 *  to consume. Static checks enforced here:
 *    - lvalues.length must be ≤ fn.outputs.length
 *    - lvalues are simple `Var` or `~` (other lvalue forms aren't
 *      supported in numbl's static subset today)
 *    - args lower as numeric (matching `lowerUserCall`'s constraint) */
export function lowerMultiAssignCall(
  this: Lowerer,
  fnAst: FunctionStmt,
  fnFile: string,
  name: string,
  argExprs: Expr[],
  lvalues: ReadonlyArray<LValue>,
  span: Span
): import("./ir.js").IRStmt {
  if (lvalues.length > fnAst.outputs.length) {
    throw new UnsupportedConstruct(
      `function '${name}' returns ${fnAst.outputs.length} output(s) ` +
        `but ${lvalues.length} were requested`,
      span
    );
  }
  for (const lv of lvalues) {
    if (lv.type !== "Var" && lv.type !== "Ignore") {
      throw new UnsupportedConstruct(
        `multi-assign lvalue must be a simple identifier or '~' ignore ` +
          `(got '${lv.type}')`,
        span
      );
    }
  }

  const { args, mangledName, spec } = specializeUserCall.call(
    this,
    name,
    fnAst,
    fnFile,
    argExprs,
    span
  );

  // 1-output specialization: route to the classic return-by-value
  // shapes. (We arrive here from MultiAssign with 1 lvalue; ExprStmt
  // bare-statement form for a 1-output function never reaches this
  // helper — that path lowers via the regular `ExprStmt(Call)`
  // pipeline already.)
  if (spec.outputs.length === 1) {
    const callExpr: IRExpr = {
      kind: "Call",
      name,
      callee: { kind: "userFunc", mangled: mangledName },
      args,
      ty: spec.outputs[0].ty,
      span,
    };
    if (lvalues.length === 0) {
      // Drop-all of a single-output call: `foo(x);` as a bare stmt
      // — the bare-statement path doesn't reach here today, but
      // handling it keeps the helper total.
      return { kind: "ExprStmt", expr: callExpr, span };
    }
    const lv = lvalues[0];
    if (lv.type !== "Var") {
      // Ignore (validated above as the only other allowed shape)
      return { kind: "ExprStmt", expr: callExpr, span };
    }
    const cName = this.recordAssignment(lv.name, spec.outputs[0].ty, span);
    return {
      kind: "Assign",
      name: lv.name,
      cName,
      rhs: callExpr,
      ty: spec.outputs[0].ty,
      span,
    };
  }

  // 0-output and N≥2-output: build the MultiAssignCall outputs[]
  // array. Each declared output of the callee becomes one slot in
  // the IR. Slots not consumed by an lvalue (either past the end of
  // `lvalues`, or explicitly an `Ignore`) are `null` — codegen
  // synthesizes a discard temp inside the call's `{}` block. Named
  // slots route through `recordAssignment` so the type and cName flow
  // through the lowerer's binding tracking like any other Assign.
  const outputs: {
    ty: MType;
    binding: { name: string; cName: string } | null;
  }[] = [];
  for (let i = 0; i < spec.outputs.length; i++) {
    const slotTy = spec.outputs[i].ty;
    const lv = lvalues[i];
    if (lv === undefined || lv.type !== "Var") {
      // `Ignore` (the only other shape after the validation above)
      // becomes a discard-temp slot. `ty` is always populated so
      // codegen can declare the temp with the right C type.
      outputs.push({ ty: slotTy, binding: null });
      continue;
    }
    const cName = this.recordAssignment(lv.name, slotTy, span);
    outputs.push({ ty: slotTy, binding: { name: lv.name, cName } });
  }
  return {
    kind: "MultiAssignCall",
    name,
    mangled: mangledName,
    args,
    outputs,
    span,
  };
}

/** Shared "lower args + specialize" pipeline used by both
 *  expression-position calls (`lowerUserCall`) and statement-position
 *  multi-assign / drop-all calls (`lowerMultiAssignCall`). Returns
 *  the lowered args, the mangled specialization name, and the
 *  IRFunction itself. */
export function specializeUserCall(
  this: Lowerer,
  name: string,
  fnAst: FunctionStmt,
  fnFile: string,
  argExprs: Expr[],
  span: Span
): { args: IRExpr[]; mangledName: string; spec: IRFunction } {
  if (argExprs.length !== fnAst.params.length) {
    throw new TypeError(
      `function '${name}' expects ${fnAst.params.length} argument(s), got ${argExprs.length}`,
      span
    );
  }
  const args = argExprs.map(a => this.lowerExpr(a));
  for (const a of args) {
    if (!isNumeric(a.ty) && !isStruct(a.ty)) {
      throw new UnsupportedConstruct(
        `function '${name}' only accepts numeric or struct arguments ` +
          `(got ${typeToString(a.ty)})`,
        a.span
      );
    }
  }
  const argTypes = args.map(a => a.ty);
  const mangledName = mangleSpecName(name, fnFile, argTypes);
  let spec = this.shared.cache.get(mangledName);
  if (!spec) {
    if (this.shared.inFlight.has(mangledName)) {
      throw new UnsupportedConstruct(
        `recursive call to '${name}' is not yet supported`,
        span
      );
    }
    spec = specialize.call(this, name, fnAst, fnFile, argTypes, mangledName);
  }
  return { args, mangledName, spec };
}

/** When a function parameter is a struct, seed the inner lowerer's
 *  per-root field-type tracking so member reads on the param work
 *  even before the body has assigned through it. Also augment the
 *  pre-pass struct-shape map to reflect the param's call-site shape.
 *  Recurses into nested-struct fields. */
function seedStructParamFieldTypes(
  inner: Lowerer,
  rootName: string,
  ty: MType
): void {
  if (!isStruct(ty)) return;
  let shape = inner.structShapes.get(rootName);
  if (shape === undefined) {
    shape = { fields: new Map(), firstSpan: { file: "", start: 0, end: 0 } };
    inner.structShapes.set(rootName, shape);
  }
  let fieldTypes = inner.structFieldTypes.get(rootName);
  if (fieldTypes === undefined) {
    fieldTypes = new Map();
    inner.structFieldTypes.set(rootName, fieldTypes);
  }
  seedShape(shape, fieldTypes, ty, []);
}

function seedShape(
  shape: import("./structPrePass.js").StructShape,
  fieldTypes: Map<string, MType>,
  ty: import("./types.js").StructType,
  pathSoFar: string[]
): void {
  for (const f of ty.fields) {
    const newPath = [...pathSoFar, f.name];
    if (isStruct(f.type)) {
      let nested = shape.fields.get(f.name);
      if (nested === undefined || nested === null) {
        nested = { fields: new Map(), firstSpan: shape.firstSpan };
        shape.fields.set(f.name, nested);
      }
      seedShape(nested, fieldTypes, f.type, newPath);
    } else {
      if (!shape.fields.has(f.name)) {
        shape.fields.set(f.name, null);
      }
      if (!fieldTypes.has(newPath.join("."))) {
        fieldTypes.set(newPath.join("."), f.type);
      }
    }
  }
}

/**
 * Build the C identifier for a specialization.
 *
 * Hashes the full canonicalized argument-type tuple (every field of
 * every type, including sign) along with the function's source file.
 * Two calls with identical (file, type-tuple) produce the same hash
 * and so land on the same specialization; any difference — sign,
 * shape, complex, future fields, OR source file — produces a
 * different specialization with its own emitted C function.
 *
 * Salting by file is what lets same-named helpers in different files
 * coexist without colliding on the FNV-1a hash. Without it, a
 * subfunction `helper` in `foo.m` and a different `helper` in `bar.m`
 * would collapse onto one specialization when called with the same
 * arg types.
 */
function mangleSpecName(
  matlabName: string,
  fnFile: string,
  argTypes: MType[]
): string {
  const canonical = JSON.stringify({
    file: fnFile,
    args: argTypes.map(canonicalizeType),
  });
  return `${matlabName}__${fnv1a32Hex(canonical)}`;
}

/** FNV-1a 32-bit hash of a UTF-16 string, returned as zero-padded 8-hex.
 *  Browser-safe replacement for the previous SHA-256-truncated-to-8-hex
 *  scheme; identical entropy (32 bits) and identical mangle width. */
function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    const upper = s.charCodeAt(i) >>> 8;
    if (upper) {
      h ^= upper;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Lower a function body for a specific argument-type signature.
 *  Each unique type tuple gets its own specialization (and its own
 *  emitted C function), so the body sees params bound to the actual
 *  call-site type — including sign. Sign-sensitive ops like
 *  `sqrt(x)` then resolve at the call site that introduced the
 *  type. */
function specialize(
  this: Lowerer,
  matlabName: string,
  fnAst: FunctionStmt,
  fnFile: string,
  argTypes: MType[],
  mangledName: string
): IRFunction {
  this.shared.inFlight.add(mangledName);
  try {
    // Validate param + output names against the `_mtoc_` prefix
    // before doing anything else; otherwise an early body lowering
    // failure could mask the real problem.
    for (const p of fnAst.params) assertNotMtocReserved(p, fnAst.span);
    for (const o of fnAst.outputs) assertNotMtocReserved(o, fnAst.span);

    // `~` params are positional placeholders for ignored arguments — the
    // body cannot reference them. Give each one a synthetic C identifier
    // so the emitted signature is valid C; the MATLAB-side `name` stays
    // `~` for diagnostics (header comment, error messages).
    const paramBindings = fnAst.params.map((p, i) => ({
      name: p,
      cName: p === "~" ? `_mtoc_ignored_p${i}` : cNameFor(p),
      ty: argTypes[i],
    }));
    const inner = new Lowerer(
      this.shared,
      paramBindings,
      fnAst.outputs.slice(),
      true,
      fnFile
    );
    // Pre-pass the function body to collect struct field-sets per
    // root variable. Struct params are already in env with their
    // call-site type — the pre-pass output ONLY adds shapes for
    // variables that get a member assignment (or a `struct(...)`
    // constructor) inside the body itself; param-name entries in
    // the shape map only appear if the body assigns through that
    // param. The first member assignment to a struct PARAM has a
    // shape (from the call-site type) and a pre-pass shape — they
    // must agree, which is checked in `lowerMemberStore`.
    inner.primeStructShapes(fnAst.body);
    // For struct params: seed the per-root field-type tracking with
    // the call-site param types so a member-load on an unassigned
    // field still works (you can read a struct field of a parameter
    // without first assigning it).
    for (const p of paramBindings) {
      seedStructParamFieldTypes(inner, p.name, p.ty);
    }
    const body = inner.lowerStmts(fnAst.body);
    // After body lowering: every declared output must have an assigned
    // type on every path, and must be a scalar (tensor returns aren't
    // supported yet). Each output's `cName` reflects the LIVE binding
    // at the function's exit point — the lowerer's
    // `recordAssignment` may have split the binding to a fresh
    // `_mtoc_<name>__v<N>` if the output's type changed across a
    // top-level reassignment, so we read the post-body cName via
    // `currentCNameFor`. Codegen uses this `cName` for both the
    // implicit fall-through return and the per-output writes
    // emitted at every `IRStmt.ReturnFromFunction`.
    const outputs: { name: string; cName: string; ty: MType }[] = [];
    for (const outName of fnAst.outputs) {
      const ty = inner.envLookup(outName);
      if (!ty) {
        throw new TypeError(
          `function '${matlabName}' did not assign its output variable '${outName}' on any path`,
          fnAst.span
        );
      }
      // Accept scalars (real / complex / char) and owned kinds (real or
      // complex double tensors, char tensors, scalar strings). The
      // owned path carries the return through `mtoc_<kind>_assign` at
      // the caller, and the callee excludes its output from the
      // scope-exit free walk so ownership transfers cleanly.
      const okReturn = isScalar(ty) || isOwned(ty);
      if (!okReturn) {
        throw new UnsupportedConstruct(
          `function '${matlabName}' return type ${typeToString(ty)} is ` +
            `not yet supported`,
          fnAst.span
        );
      }
      outputs.push({
        name: outName,
        cName: inner.currentCNameFor(outName),
        ty,
      });
    }
    const file = fnAst.span.file;
    const source = this.shared.workspace.sourceOf(file) ?? "";
    const sourceLocation = {
      file,
      startLine: offsetToLine(source, fnAst.span.start),
      endLine: offsetToLine(source, fnAst.span.end),
    };
    const spec: IRFunction = {
      mangledName,
      matlabName,
      params: paramBindings,
      outputs,
      assignedVars: inner.getAssignedVars(),
      body,
      span: fnAst.span,
      sourceLocation,
    };
    this.shared.cache.set(mangledName, spec);
    this.shared.order.push(spec);
    return spec;
  } finally {
    this.shared.inFlight.delete(mangledName);
  }
}
