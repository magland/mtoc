/**
 * Lowering helpers for class constructor calls and method calls.
 *
 * Three entry points:
 *
 *   - `lowerClassConstructorCall` — `MyClass(args)` (resolver verdict:
 *     `classConstructor`). Builds the receiver-as-first-param call,
 *     specializes the constructor body, and returns an `IRExpr.Call`
 *     whose type is the post-mutation `ClassType`.
 *
 *   - `lowerClassMethodCall` — `obj.method(args)` (parser `MethodCall`
 *     whose base resolves to a `ClassType`). Calls
 *     `Workspace.resolveForTargetClass` to pin dispatch into the
 *     receiver's class, then specializes the method's AST. Honors the
 *     resolver's `stripInstance` flag for static-method dispatch.
 *
 *   - `lowerClassMethodCallByName` — `method(obj, args)` form. Called
 *     by `lowerFuncCall` after the resolver returns `classMethod`. The
 *     receiver is the first arg; the rest pass through unchanged.
 *
 * Dispatch decisions never happen here — they happen inside
 * `Workspace.resolve` / `Workspace.resolveForTargetClass`, which
 * delegate to numbl's vendored `resolveFunction`. These helpers only
 * consume the resolver's verdict and route to specialization.
 */

import type { Expr, Span } from "../parser/index.js";
import { Lowerer } from "./lower.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  classType,
  scalarDouble,
  type ClassType,
  type MType,
} from "./types.js";
import type { FunctionStmt, ResolvedTarget } from "../workspace/workspace.js";
import type { ClassInfo } from "../numbl-core/lowering/loweringContext.js";
import { specializeUserCallWithIRArgs } from "./lowerFuncCall.js";

/** Build the initial `ClassType` for a fresh constructor receiver:
 *  every declared property starts at `scalarDouble("zero")` (matching
 *  numbl's `[]`→`0` default-property semantics for unannotated
 *  properties). Property types widen as the constructor body assigns
 *  through them. */
function initialClassType(info: ClassInfo): ClassType {
  const properties = info.propertyNames.map(name => ({
    name,
    type: scalarDouble("zero") as MType,
  }));
  return classType({
    className: info.qualifiedName,
    file: info.fileName,
    properties,
  });
}

/** Lower a class constructor call: resolver verdict was
 *  `classConstructor`. Specializes the constructor with an initial
 *  empty-class `obj` as the first param + the user's args; returns an
 *  `IRExpr.Call` whose `ty` is the constructor's output type (the
 *  post-mutation `ClassType`). */
export function lowerClassConstructorCall(
  this: Lowerer,
  target: Extract<ResolvedTarget, { kind: "classConstructor" }>,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const info = this.shared.workspace.ctx.getClassInfo(target.className);
  if (info === null) {
    throw new UnsupportedConstruct(
      `internal: no ClassInfo for '${target.className}' at constructor call`,
      span
    );
  }
  const initialTy = initialClassType(info);
  // The constructor AST has the receiver-output prepended as its
  // first param (Workspace.resolve's lookupClassMethodAST did this).
  // We feed a synthetic-IR initial receiver as the first arg.
  const initialArg: IRExpr = synthesizeInitialClassValue.call(
    this,
    info,
    initialTy,
    span
  );
  const irArgs: IRExpr[] = [initialArg];
  for (const a of argExprs) irArgs.push(this.lowerExpr(a));
  return finishClassCall.call(
    this,
    info.qualifiedName,
    target.ast,
    target.file,
    irArgs,
    span
  );
}

/** Lower `obj.method(args)`: parser node is `MethodCall` whose base
 *  resolves to a `ClassType`. Calls
 *  `Workspace.resolveForTargetClass` to pin dispatch into the
 *  receiver's class; the verdict's `stripInstance` flag decides
 *  whether the receiver rides along as the method's first param. */
export function lowerClassMethodCall(
  this: Lowerer,
  classTy: ClassType,
  receiver: IRExpr,
  methodName: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const userArgs: IRExpr[] = argExprs.map(a => this.lowerExpr(a));
  const argTypes: MType[] = [classTy, ...userArgs.map(a => a.ty)];
  const target = this.shared.workspace.resolveForTargetClass(
    methodName,
    argTypes,
    classTy.className,
    this.callSite(),
    span
  );
  if (target === null) {
    throw new TypeError(
      `class '${classTy.className}' has no method '${methodName}'`,
      span
    );
  }
  if (target.kind !== "classMethod") {
    throw new UnsupportedConstruct(
      `internal: targetClassName-pinned resolve for '${classTy.className}.` +
        `${methodName}' returned non-classMethod target '${target.kind}'`,
      span
    );
  }
  return dispatchResolvedMethodCall.call(
    this,
    target,
    receiver,
    userArgs,
    span
  );
}

/** Lower `method(obj, args)`: the resolver returned `classMethod` for
 *  a function-call-syntax site. The receiver is already in the IR-arg
 *  list (first slot); pass through to the shared dispatch helper. */
export function lowerClassMethodCallByName(
  this: Lowerer,
  target: Extract<ResolvedTarget, { kind: "classMethod" }>,
  irArgs: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr {
  if (irArgs.length === 0) {
    throw new TypeError(
      `class method '${target.methodName}' requires at least one argument ` +
        `(the receiver)`,
      span
    );
  }
  const receiver = irArgs[0];
  const userArgs = irArgs.slice(1);
  return dispatchResolvedMethodCall.call(
    this,
    target,
    receiver,
    userArgs,
    span
  );
}

/** Shared "resolver verdict → specialization → IR call" pipeline for
 *  both method-call syntax and function-call syntax. Honors
 *  `stripInstance` for static-method dispatch (receiver dropped from
 *  the IR-arg list AND the param-binding seed). */
function dispatchResolvedMethodCall(
  this: Lowerer,
  target: Extract<ResolvedTarget, { kind: "classMethod" }>,
  receiver: IRExpr,
  userArgs: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr {
  const irArgs: IRExpr[] = target.stripInstance
    ? userArgs.slice()
    : [receiver, ...userArgs];
  return finishClassCall.call(
    this,
    target.methodName,
    target.ast,
    target.file,
    irArgs,
    span
  );
}

/** Tail-end of the constructor/method-call pipelines: specialize via
 *  `specializeUserCallWithIRArgs` and build the resulting `IRExpr.Call`. */
function finishClassCall(
  this: Lowerer,
  callName: string,
  fnAst: FunctionStmt,
  fnFile: string,
  irArgs: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr {
  const { args, mangledName, spec } = specializeUserCallWithIRArgs.call(
    this,
    callName,
    fnAst,
    fnFile,
    irArgs.slice(),
    span
  );
  if (spec.outputs.length !== 1) {
    throw new UnsupportedConstruct(
      `class method/constructor '${callName}' must have exactly one output ` +
        `(got ${spec.outputs.length}); multi-output methods are not yet ` +
        `supported by mtoc Stage 1`,
      span
    );
  }
  return {
    kind: "Call",
    name: callName,
    callee: { kind: "userFunc", mangled: mangledName },
    args,
    ty: spec.outputs[0].ty,
    span,
  };
}

/** Synthesize the initial receiver value for a constructor call. A
 *  fresh synthetic name is registered in the lowerer's `assignedVars`
 *  with the class type; codegen predeclares it as
 *  `<typedef> <cName> = <typedef>_empty();` via the standard
 *  owned-kind predeclaration path. Returns a `Var` IRExpr pointing
 *  at that cName. */
function synthesizeInitialClassValue(
  this: Lowerer,
  info: ClassInfo,
  initialTy: ClassType,
  span: Span
): IRExpr {
  void info;
  // Reserved-prefix synthetic name; `recordAssignment` will register
  // it in `assignedVars` and return the cName. The
  // `assertNotMtocReserved` guard there only checks user-supplied
  // names — synthetic names with the `_mtoc_` prefix pass through.
  const baseName = `_mtoc_class_init_${this.nextClassInitId()}`;
  const cName = this.registerSyntheticBinding(baseName, initialTy);
  return {
    kind: "Var",
    name: baseName,
    cName,
    ty: initialTy,
    span,
  };
}
