/**
 * Function-call lowering: builtins (libm + mtoc runtime helpers) and
 * user-defined functions. User functions are lazily specialized on
 * the (shape, sign, …) tuple of their argument types so each call
 * site gets the most-precise return type.
 */

import type { Expr, Span } from "../parser/index.js";
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
  canonicalizeType,
  isMultiElement,
  isScalar,
  isScalarReal,
  isNumeric,
  isString,
  isVector,
  scalarDouble,
  signIsNonneg,
  signIsPositive,
  type MType,
  typeToString,
} from "./types.js";
import { Lowerer, assertNotMtocReserved, cNameFor } from "./lower.js";

/** Top-level dispatcher for `name(args)` syntax. Splits out the
 *  reserved `disp` (only valid as a stmt) and routes user functions
 *  vs builtins. */
export function lowerFuncCall(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncCall" }>
): IRExpr {
  const target = this.shared.workspace.resolve(e.name);
  if (!target) {
    throw new UnsupportedConstruct(
      `unresolved function or builtin '${e.name}'`,
      e.span
    );
  }
  if (target.kind === "userFunction") {
    return lowerUserCall.call(this, e.name, e.args, e.span);
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
  // String fast-paths: `length(s) == 1`, `numel(s) == 1` per numbl
  // semantics (a numbl `string` is a scalar handle, not a char
  // vector). Fold to a NumLit at lowering — no runtime helper needed.
  // Lower the arg once and reuse it on the fall-through path so
  // expression-level side effects (e.g. recording fresh assignments)
  // aren't applied twice.
  if ((e.name === "length" || e.name === "numel") && e.args.length === 1) {
    const arg = this.lowerExpr(e.args[0]);
    if (isString(arg.ty)) {
      return {
        kind: "NumLit",
        value: 1,
        ty: scalarDouble("positive"),
        span: e.span,
      };
    }
    return lowerBuiltinCallWithArgs.call(this, e.name, [arg], e.span);
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
  if (args.length !== builtin.params.length) {
    throw new UnsupportedConstruct(
      `${name} expects ${builtin.params.length} argument(s), got ${args.length}`,
      span
    );
  }
  // Per-arg shape + complex-domain + sign-domain validation, all driven
  // by ParamConstraint. Order matters: the complex-domain check runs
  // before the sign-domain check so a complex arg fails with "cannot
  // accept a complex argument" rather than a confusing sign error.
  const argLabel = (i: number): string =>
    builtin.params.length === 1 ? "x" : `arg ${i + 1}`;
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

/** Lower a user-function call. Specializes (or reuses an existing
 *  specialization) keyed by argument-type tuple, then emits a Call
 *  with `callee.kind="userFunc"`. */
export function lowerUserCall(
  this: Lowerer,
  name: string,
  argExprs: Expr[],
  span: Span
): IRExpr {
  const fnAst = this.shared.workspace.localFunctions.get(name);
  if (!fnAst) {
    throw new UnsupportedConstruct(
      `internal: workspace claimed '${name}' is a user function but no AST is registered`,
      span
    );
  }
  if (fnAst.outputs.length !== 1) {
    throw new UnsupportedConstruct(
      `function '${name}' must have exactly one output (got ${fnAst.outputs.length})`,
      span
    );
  }
  if (argExprs.length !== fnAst.params.length) {
    throw new TypeError(
      `function '${name}' expects ${fnAst.params.length} argument(s), got ${argExprs.length}`,
      span
    );
  }
  const args = argExprs.map(a => this.lowerExpr(a));
  for (const a of args) {
    if (!isNumeric(a.ty)) {
      throw new UnsupportedConstruct(
        `function '${name}' only accepts numeric arguments ` +
          `(got ${typeToString(a.ty)})`,
        a.span
      );
    }
  }
  const argTypes = args.map(a => a.ty);
  const mangledName = mangleSpecName(name, argTypes);

  let spec = this.shared.cache.get(mangledName);
  if (!spec) {
    if (this.shared.inFlight.has(mangledName)) {
      throw new UnsupportedConstruct(
        `recursive call to '${name}' is not yet supported`,
        span
      );
    }
    spec = specialize.call(this, name, fnAst, argTypes, mangledName);
  }
  return {
    kind: "Call",
    name,
    callee: { kind: "userFunc", mangled: mangledName },
    args,
    ty: spec.returnTy,
    span,
  };
}

/**
 * Build the C identifier for a specialization.
 *
 * Hashes the full canonicalized argument-type tuple (every field of
 * every type, including sign). Two calls with identical type tuples
 * produce the same hash and so land on the same specialization; any
 * difference — sign, shape, complex, future fields — produces a
 * different specialization with its own emitted C function.
 */
function mangleSpecName(matlabName: string, argTypes: MType[]): string {
  const canonical = JSON.stringify(argTypes.map(canonicalizeType));
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

    const paramBindings = fnAst.params.map((p, i) => ({
      name: p,
      cName: cNameFor(p),
      ty: argTypes[i],
    }));
    const inner = new Lowerer(this.shared, paramBindings, fnAst.outputs[0]);
    const body = inner.lowerStmts(fnAst.body);
    const outputName = fnAst.outputs[0];
    const returnTy = inner.envLookup(outputName);
    if (!returnTy) {
      throw new TypeError(
        `function '${matlabName}' did not assign its output variable '${outputName}' on any path`,
        fnAst.span
      );
    }
    if (!isScalar(returnTy)) {
      throw new UnsupportedConstruct(
        `function '${matlabName}' must return a scalar — ` +
          `tensor returns are not yet supported (got ${typeToString(returnTy)})`,
        fnAst.span
      );
    }
    const file = fnAst.span.file;
    const source = this.shared.workspace.files.get(file)?.source ?? "";
    const sourceLocation = {
      file,
      startLine: offsetToLine(source, fnAst.span.start),
      endLine: offsetToLine(source, fnAst.span.end),
    };
    const spec: IRFunction = {
      mangledName,
      matlabName,
      params: paramBindings,
      outputVar: outputName,
      // After body lowering, the output variable's binding may have
      // been split (top-level reassignment with an incompatible type);
      // ask the lowerer for the current cName so the implicit
      // end-of-function `return <cName>;` reads the live binding.
      outputCName: inner.currentCNameFor(outputName),
      returnTy,
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
