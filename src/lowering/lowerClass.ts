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
 *  every declared property (own + inherited from every superclass)
 *  starts at `scalarDouble("zero")`. Property types widen as the
 *  constructor body assigns through them.
 *
 *  Property ordering: parent-first, then child-own. This is the
 *  numbl-natural order — the parent's constructor sets its own
 *  properties before the child's constructor reaches `obj.Breed = ...`.
 *  The order is encoded into the typedef hash (via `classType`'s
 *  alphabetical sort), so two child classes with the same flattened
 *  property set share a typedef. */
function initialClassType(this: Lowerer, info: ClassInfo): ClassType {
  const propNames = flattenedPropertyNames.call(this, info);
  const properties = propNames.map(name => ({
    name,
    type: scalarDouble("zero") as MType,
  }));
  return classType({
    className: info.qualifiedName,
    file: info.fileName,
    properties,
  });
}

/** Walk the inheritance chain rooted at `info` and accumulate every
 *  declared property name (parent-first, then child-own). Uses
 *  numbl's `LoweringContext.getClassInfo` to walk superclasses. */
function flattenedPropertyNames(this: Lowerer, info: ClassInfo): string[] {
  // Collect chain root-first so the parent's properties come first.
  const chain: ClassInfo[] = [];
  let cur: ClassInfo | null = info;
  while (cur !== null) {
    chain.unshift(cur);
    cur =
      cur.superClass === null
        ? null
        : this.shared.workspace.ctx.getClassInfo(cur.superClass);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chain) {
    for (const p of c.propertyNames) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
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
  const initialTy = initialClassType.call(this, info);
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
  // Salt the specialization name with the defining class so a
  // parent method and a child method with the same name (and same
  // file when the classes are co-located in one .m) get distinct
  // specializations. Without this salt, the in-flight set's
  // recursion check fires falsely on super-method calls.
  return finishClassCall.call(
    this,
    classMethodSpecName(target.className, target.methodName),
    target.ast,
    target.file,
    irArgs,
    span
  );
}

/** Compose the MATLAB-side name used as the `mangleSpecName` salt
 *  for a class method's specialization. The `__` separator never
 *  appears in numbl identifiers, so this guarantees a unique hash
 *  input across the (className, methodName) pairs. */
function classMethodSpecName(className: string, methodName: string): string {
  return `${className}__${methodName}`;
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

/** Lower a `SuperMethodCall` AST node — both shapes:
 *
 *   - **Super method-call**: `result = <methodName>@<ParentClass>(receiver, ...)`.
 *     Detected when `methodName` is a method on `ParentClass` (via
 *     numbl's `classHasMethod`). Dispatches via
 *     `resolveForTargetClass(methodName, ..., targetClassName=ParentClass)`
 *     so the resolver's short-circuit pins the call into the parent.
 *     The verdict drives `findDefiningClass`-aware AST lookup the same
 *     way regular method calls do.
 *
 *   - **Super constructor-call**: `<outputBinding> = <outputBinding>@<ParentClass>(args)`.
 *     Detected when `methodName` is NOT a method on `ParentClass`
 *     (i.e. it's the constructor's output binding name). Specializes
 *     the parent class's constructor body against the CURRENT receiver's
 *     ClassType (the child's flattened typedef). The parent's constructor
 *     body only touches its own properties — all of which are also
 *     present in the child's flattened typedef via inheritance — so the
 *     specialization emits cleanly against the child layout.
 *
 * The shape distinction is made via `classHasMethod`, not via
 * positional analysis of the surrounding statement, so the same
 * `SuperMethodCall` node works inside or outside an Assign. */
export function lowerSuperCall(
  this: Lowerer,
  e: Extract<Expr, { type: "SuperMethodCall" }>
): IRExpr {
  const parentClassName = e.superClassName;
  const ctx = this.shared.workspace.ctx;
  const parentInfo = ctx.getClassInfo(parentClassName);
  if (parentInfo === null) {
    throw new TypeError(
      `super call references unknown class '${parentClassName}'`,
      e.span
    );
  }
  // Disambiguate via numbl's `classHasMethod` (which walks the chain
  // rooted at the parent — also picks up grand-parent methods). If
  // the methodName is a known method on the parent, this is a
  // method super-call; otherwise it's a constructor super-call.
  const isMethodSuper = ctx.classHasMethod(parentClassName, e.methodName);
  if (isMethodSuper) {
    return lowerSuperMethodCall.call(this, parentClassName, e);
  }
  return lowerSuperConstructorCall.call(this, parentInfo, e);
}

/** Method super-call: `result = greet@Parent(obj)`. The receiver is
 *  the FIRST user-arg (explicit in the source). Dispatches via the
 *  resolver pinned to the parent, then specializes. */
function lowerSuperMethodCall(
  this: Lowerer,
  parentClassName: string,
  e: Extract<Expr, { type: "SuperMethodCall" }>
): IRExpr {
  const irArgs = e.args.map(a => this.lowerExpr(a));
  const argTypes = irArgs.map(a => a.ty);
  const target = this.shared.workspace.resolveForTargetClass(
    e.methodName,
    argTypes,
    parentClassName,
    this.callSite(),
    e.span
  );
  if (target === null || target.kind !== "classMethod") {
    throw new UnsupportedConstruct(
      `internal: super-method-call '${e.methodName}@${parentClassName}' ` +
        `did not resolve to a class method`,
      e.span
    );
  }
  // For instance methods, `irArgs[0]` is the receiver — already in
  // the user-args; `dispatchResolvedMethodCall` expects `receiver`
  // and `userArgs` separately. Split here.
  if (irArgs.length === 0) {
    throw new TypeError(
      `super method-call '${e.methodName}@${parentClassName}' requires ` +
        `at least the receiver argument`,
      e.span
    );
  }
  const receiver = irArgs[0];
  const userArgs = irArgs.slice(1);
  return dispatchResolvedMethodCall.call(
    this,
    target,
    receiver,
    userArgs,
    e.span
  );
}

/** Constructor super-call: `<obj> = <obj>@Parent(args)`. The parent's
 *  constructor body is specialized against the CHILD's current
 *  receiver type (the inherited+own flat property set), so its
 *  property writes land on the child's typedef directly. */
function lowerSuperConstructorCall(
  this: Lowerer,
  parentInfo: ClassInfo,
  e: Extract<Expr, { type: "SuperMethodCall" }>
): IRExpr {
  // The receiver for the parent constructor is the enclosing scope's
  // `<methodName>` binding (the child constructor's output, which has
  // already been seeded as a ClassType param via `seedFromClassType`).
  const receiverName = e.methodName;
  const receiverTy = this.envLookup(receiverName);
  if (receiverTy === undefined) {
    throw new TypeError(
      `super constructor-call '${receiverName}@${parentInfo.qualifiedName}': ` +
        `'${receiverName}' is not in scope`,
      e.span
    );
  }
  // Look up the parent's constructor AST. We reuse the lookup
  // already done by `Workspace.resolve` by going through the
  // resolver via `resolveForTargetClass` with the parent's
  // constructor name as the methodName — but `classConstructor` is a
  // separate verdict, so we route through `Workspace.resolve` with
  // the parent class name as the call name. The resolver returns
  // `workspaceClassConstructor` for that case.
  const target = this.shared.workspace.resolve(
    parentInfo.qualifiedName,
    [], // arg types don't drive constructor dispatch
    this.callSite(),
    e.span
  );
  if (target === null || target.kind !== "classConstructor") {
    throw new TypeError(
      `super constructor-call '${receiverName}@${parentInfo.qualifiedName}' ` +
        `could not resolve the parent's constructor`,
      e.span
    );
  }
  // Build IR args: receiver (typed with the CHILD's full ClassType,
  // so the parent's body writes hit the child's typedef) + user args.
  const receiverIR: IRExpr = {
    kind: "Var",
    name: receiverName,
    cName: this.currentCNameFor(receiverName),
    ty: receiverTy,
    span: e.span,
  };
  const userArgs = e.args.map(a => this.lowerExpr(a));
  const irArgs: IRExpr[] = [receiverIR, ...userArgs];
  return finishClassCall.call(
    this,
    target.className,
    target.ast,
    target.file,
    irArgs,
    e.span
  );
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
