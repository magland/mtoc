/**
 * Function-call lowering: builtins (libm + mtoc runtime helpers) and
 * user-defined functions. User functions are lazily specialized on
 * the (shape, sign, …) tuple of their argument types so each call
 * site gets the most-precise return type.
 */

import { createHash } from "node:crypto";

import type { Expr, Span } from "../parser/index.js";
import { offsetToLine } from "../parser/sourceLoc.js";
import { argShapeOf, categoryOf, getScalarBuiltin } from "../workspace/builtins.js";
import type { FunctionStmt } from "../workspace/workspace.js";
import { RUNTIME_HELPERS } from "../codegen/runtime.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { CallTarget, IRExpr, IRFunction } from "./ir.js";
import {
  canonicalizeType,
  isMultiElement,
  isScalarReal,
  isTensor,
  isVector,
  scalarDouble,
  signIsNonneg,
  signIsPositive,
  type MType,
  type Sign,
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
  // Statement-only builtins (today: `disp`) cannot appear at expression
  // position. Lowering of `ExprStmt(disp(...))` short-circuits in
  // lower.ts before reaching here; any other position is rejected with
  // a span. Routing through the unified registry means new stmt-only
  // builtins (error, assert, …) get this rejection for free.
  const builtin = getScalarBuiltin(e.name);
  if (builtin && categoryOf(builtin) === "stmt") {
    throw new UnsupportedConstruct(
      `'${e.name}' is a statement-only builtin and cannot be used as a ` +
        `value-producing call`,
      e.span
    );
  }
  return lowerBuiltinCall.call(this, e.name, e.args, e.span);
}

/** Lower a builtin call. Validates per-arg shape + sign domain, then
 *  produces an `IRExpr.Call` with the right `callee` discriminator —
 *  libm vs mtoc runtime helper. */
export function lowerBuiltinCall(
  this: Lowerer,
  name: string,
  argExprs: Expr[],
  span: Span
): IRExpr {
  const builtin = getScalarBuiltin(name);
  if (!builtin) {
    throw new UnsupportedConstruct(
      `builtin '${name}' is not yet supported`,
      span
    );
  }
  if (argExprs.length !== builtin.arity) {
    throw new UnsupportedConstruct(
      `${name} expects ${builtin.arity} argument(s), got ${argExprs.length}`,
      span
    );
  }
  const args = argExprs.map(a => this.lowerExpr(a));
  // Per-arg shape validation: scalar / vector / tensor. The default
  // is scalar (matches every legacy builtin entry).
  for (let i = 0; i < args.length; i++) {
    const shape = argShapeOf(builtin, i);
    const argTy = args[i].ty;
    const argLabel = builtin.arity === 1 ? "x" : `arg ${i + 1}`;
    if (shape === "scalar") {
      if (!isScalarReal(argTy)) {
        throw new UnsupportedConstruct(
          `${name} ${argLabel} must be a real scalar ` +
            `(got ${typeToString(argTy)})`,
          args[i].span
        );
      }
    } else if (shape === "vector") {
      if (!isVector(argTy)) {
        throw new UnsupportedConstruct(
          `${name} ${argLabel} must be a vector ` +
            `(got ${typeToString(argTy)})`,
          args[i].span
        );
      }
    } else if (shape === "tensor") {
      if (!isMultiElement(argTy)) {
        throw new UnsupportedConstruct(
          `${name} ${argLabel} must be a non-scalar tensor ` +
            `(got ${typeToString(argTy)})`,
          args[i].span
        );
      }
    }
  }
  // Sign-domain validation — applies in any shape.
  for (let i = 0; i < args.length; i++) {
    const dom = builtin.argDomains[i];
    if (!dom) continue;
    const argTy = args[i].ty;
    const argSign = isTensor(argTy) ? argTy.sign : "unknown";
    const ok =
      dom === "nonnegative"
        ? signIsNonneg(argSign)
        : signIsPositive(argSign);
    if (!ok) {
      const argLabel = builtin.arity === 1 ? "x" : `arg ${i + 1}`;
      throw new TypeError(
        `${name} requires ${argLabel} to be statically ${dom} ` +
          `(got sign='${argSign}'). ` +
          `Use abs(...) or restructure the expression.`,
        span
      );
    }
  }
  let resultSign: Sign;
  if (builtin.resultSign === "preserve") {
    const argTy = args[0].ty;
    resultSign = isTensor(argTy) ? argTy.sign : "unknown";
  } else {
    resultSign = builtin.resultSign;
  }
  // Pick the codegen-side variant: builtins whose `cFunc` is a
  // registered runtime helper need that helper activated; everything
  // else routes to libm.
  const callee: CallTarget = RUNTIME_HELPERS.has(builtin.cFunc)
    ? { kind: "runtime", helperName: builtin.cFunc }
    : { kind: "libm", cName: builtin.cFunc };
  return {
    kind: "Call",
    name,
    callee,
    args,
    ty: scalarDouble(resultSign),
    span,
  };
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
    if (!isScalarReal(a.ty)) {
      throw new UnsupportedConstruct(
        `function '${name}' currently only accepts real-scalar arguments ` +
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
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${matlabName}__${hash}`;
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
    const inner = new Lowerer(
      this.shared,
      paramBindings,
      fnAst.outputs[0]
    );
    const body = inner.lowerStmts(fnAst.body);
    const outputName = fnAst.outputs[0];
    const returnTy = inner.envLookup(outputName);
    if (!returnTy) {
      throw new TypeError(
        `function '${matlabName}' did not assign its output variable '${outputName}' on any path`,
        fnAst.span
      );
    }
    if (!isScalarReal(returnTy)) {
      throw new UnsupportedConstruct(
        `function '${matlabName}' must return a real scalar ` +
          `(got ${typeToString(returnTy)})`,
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
      outputCName: cNameFor(outputName),
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
