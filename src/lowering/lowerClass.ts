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

import type { Expr, Span, Stmt } from "../parser/index.js";
import { Lowerer } from "./lower.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  charArrayType,
  classType,
  scalarChar,
  scalarDouble,
  signFromValue,
  STRING,
  unify,
  type ClassType,
  type DimInfo,
  type MType,
} from "./types.js";
import type { FunctionStmt, ResolvedTarget } from "../workspace/workspace.js";
import type { ClassInfo } from "../numbl-core/lowering/loweringContext.js";
import { specializeUserCallWithIRArgs } from "./lowerFuncCall.js";
import { decodeNumblQuotedLexeme } from "./lexerHelpers.js";

/** Build the initial `ClassType` for a fresh constructor receiver.
 *  Property types come from a best-effort static analysis of the
 *  constructor body (`predictConstructorPropertyTypes`): the analysis
 *  walks `obj.<prop> = <RHS>` writes plus super-constructor calls and
 *  derives each property's eventual MType from literals / arg
 *  references / nested super-ctor returns. Properties that the
 *  analysis can't pin down stay at the conservative
 *  `scalarDouble("zero")` placeholder.
 *
 *  Why this matters: the constructor's `obj` C param uses this initial
 *  type as its typedef, and `return obj;` returns the post-body
 *  widened type. Without the pre-pass, the param's typedef (all-
 *  placeholders) and the post-body typedef (real types) would differ,
 *  causing C-side type-check failures. With the pre-pass, the param
 *  typedef already has the right C representation for each property,
 *  and the body's writes just fill in values.
 *
 *  Property ordering: parent-first, then child-own. The order is
 *  encoded into the typedef hash (via `classType`'s alphabetical
 *  sort), so two child classes with the same flattened property set
 *  share a typedef. */
function initialClassType(
  this: Lowerer,
  info: ClassInfo,
  userArgTypes: ReadonlyArray<MType>
): ClassType {
  const propNames = flattenedPropertyNames.call(this, info);
  const predicted = predictConstructorPropertyTypes.call(
    this,
    info,
    userArgTypes
  );
  const properties = propNames.map(name => ({
    name,
    type: (predicted.get(name) ?? scalarDouble("zero")) as MType,
  }));
  return classType({
    className: info.qualifiedName,
    file: info.fileName,
    properties,
  });
}

/** Predict property types by walking the constructor body's AST. The
 *  result map keys are property names; values are best-effort MTypes
 *  derived from RHS expression analysis. Properties absent from the
 *  map stay at the placeholder default in the caller.
 *
 *  The analysis is conservative — it only commits to a type when the
 *  RHS is something we can confidently type without full lowering.
 *  Specifically:
 *
 *   - Number literal → `scalarDouble(signFromValue)`.
 *   - String literal → `STRING`.
 *   - Char literal → `scalarChar()` or `charArrayType(notOne)`.
 *   - Ident referring to a constructor param → that param's type.
 *   - SuperMethodCall to the parent's constructor (super-ctor form)
 *     → recursively predict the parent's property types and merge
 *     into the result.
 *   - Anything else → conservative `scalarDouble("unknown")`.
 *
 *  Multiple writes to the same property unify, so a write that's
 *  hard to type doesn't pin the property to "unknown" if a later
 *  write is more precise. */
function predictConstructorPropertyTypes(
  this: Lowerer,
  info: ClassInfo,
  userArgTypes: ReadonlyArray<MType>
): Map<string, MType> {
  const ctorAst = lookupClassConstructorAST(info);
  if (ctorAst === null) return new Map();

  // The constructor AST's `params` has been transformed (via
  // `lookupClassMethodAST` in Workspace.resolve) to prepend the
  // receiver-output var name. So params[0] is the receiver, and
  // params[1..] are the user-declared args.
  const receiverName = ctorAst.params[0] ?? "obj";
  const paramTypes = new Map<string, MType>();
  for (let i = 1; i < ctorAst.params.length; i++) {
    const argTy = userArgTypes[i - 1];
    if (argTy !== undefined) {
      paramTypes.set(ctorAst.params[i], argTy);
    }
  }

  const result = new Map<string, MType>();
  const ctx = this.shared.workspace.ctx;

  const recordWrite = (propName: string, ty: MType): void => {
    const prior = result.get(propName);
    if (prior === undefined) {
      result.set(propName, ty);
      return;
    }
    const merged = unify(prior, ty);
    if (merged.kind !== "Unknown") result.set(propName, merged);
  };

  const visitStmt = (s: Stmt): void => {
    switch (s.type) {
      case "Assign": {
        // Watch for `obj = obj@Parent(args)` — super-constructor
        // call. The parent's pre-pass result is merged into the
        // child's so inherited properties get their predicted types.
        if (
          s.name === receiverName &&
          s.expr.type === "SuperMethodCall" &&
          !ctx.classHasMethod(s.expr.superClassName, s.expr.methodName)
        ) {
          const parentInfo = ctx.getClassInfo(s.expr.superClassName);
          if (parentInfo !== null) {
            const parentArgTys = s.expr.args.map(predictExprType);
            const parentResult = predictConstructorPropertyTypes.call(
              this,
              parentInfo,
              parentArgTys
            );
            for (const [k, v] of parentResult) recordWrite(k, v);
          }
        }
        return;
      }
      case "AssignLValue": {
        // `<root>.<prop> = <rhs>` where <root> is the receiver. We
        // only handle single-step paths here; nested paths
        // (`obj.x.y = ...`) aren't writable on classes today, so
        // they'd fail at lowering anyway.
        if (s.lvalue.type !== "Member") return;
        const lv = s.lvalue;
        if (lv.base.type !== "Ident") return;
        if (lv.base.name !== receiverName) return;
        recordWrite(lv.name, predictExprType(s.expr));
        return;
      }
      case "If": {
        for (const t of s.thenBody) visitStmt(t);
        for (const eif of s.elseifBlocks) {
          for (const t of eif.body) visitStmt(t);
        }
        if (s.elseBody !== null) {
          for (const t of s.elseBody) visitStmt(t);
        }
        return;
      }
      case "While":
        for (const t of s.body) visitStmt(t);
        return;
      case "For":
        for (const t of s.body) visitStmt(t);
        return;
      default:
        return;
    }
  };

  const predictExprType = (e: Expr): MType => {
    switch (e.type) {
      case "Number": {
        const n = Number(e.value);
        return scalarDouble(signFromValue(n));
      }
      case "String":
        return STRING;
      case "Char": {
        const raw = e.value;
        if (raw.length < 2 || raw[0] !== "'") return scalarDouble("unknown");
        const inner = decodeNumblQuotedLexeme(raw);
        if (inner.length === 0) return scalarDouble("unknown");
        if (inner.length === 1) return scalarChar();
        const cols: DimInfo = { kind: "notOne" };
        return charArrayType(cols);
      }
      case "Ident": {
        const t = paramTypes.get(e.name);
        if (t !== undefined) return t;
        return scalarDouble("unknown");
      }
      case "SuperMethodCall": {
        // Only recognize the super-CONSTRUCTOR form here (receiver
        // bound to the parent's constructor return). Super-method
        // calls in a constructor's RHS are unusual; predict
        // conservatively.
        if (!ctx.classHasMethod(e.superClassName, e.methodName)) {
          const parentInfo = ctx.getClassInfo(e.superClassName);
          if (parentInfo !== null) {
            const flatNames = function walkChain(
              this: Lowerer,
              i: ClassInfo
            ): string[] {
              return flattenedPropertyNames.call(this, i);
            }.call(this, parentInfo);
            const parentArgTys = e.args.map(predictExprType);
            const predicted = predictConstructorPropertyTypes.call(
              this,
              parentInfo,
              parentArgTys
            );
            const properties = flatNames.map(name => ({
              name,
              type: (predicted.get(name) ?? scalarDouble("zero")) as MType,
            }));
            return classType({
              className: parentInfo.qualifiedName,
              file: parentInfo.fileName,
              properties,
            });
          }
        }
        return scalarDouble("unknown");
      }
      default:
        return scalarDouble("unknown");
    }
  };

  for (const s of ctorAst.body) visitStmt(s);
  return result;
}

/** Look up the constructor AST for a class via numbl's already-
 *  vendored mechanism. The AST has the receiver-output prepended as
 *  the first param (mirrors `getOrCreateClassFileContext`'s
 *  transform). Returns null when the class has no explicit
 *  constructor — caller handles. */
function lookupClassConstructorAST(info: ClassInfo): FunctionStmt | null {
  const ctorName = info.constructorName;
  if (ctorName === null) return null;
  for (const member of info.ast.members) {
    if (member.type !== "Methods") continue;
    for (const stmt of member.body) {
      if (stmt.type !== "Function") continue;
      if (stmt.name !== ctorName) continue;
      const outputName = stmt.outputs.length > 0 ? stmt.outputs[0] : "obj";
      return { ...stmt, params: [outputName, ...stmt.params] };
    }
  }
  return null;
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
  // Lower user args first so we know their MTypes — the pre-pass
  // predictor uses them to type Ident references in the constructor
  // body (e.g. `obj.x = v` where `v` is a constructor param).
  const userArgs: IRExpr[] = argExprs.map(a => this.lowerExpr(a));
  const userArgTypes = userArgs.map(a => a.ty);
  const initialTy = initialClassType.call(this, info, userArgTypes);
  // The constructor AST has the receiver-output prepended as its
  // first param (Workspace.resolve's lookupClassMethodAST did this).
  // We feed a synthetic-IR initial receiver as the first arg.
  const initialArg: IRExpr = synthesizeInitialClassValue.call(
    this,
    info,
    initialTy,
    span
  );
  const irArgs: IRExpr[] = [initialArg, ...userArgs];
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

/** Lower `ClassName.method(args)` — the static-method-call syntax,
 *  where the base of the MethodCall AST node is an Ident that names a
 *  registered class (not an in-scope variable). Routes through
 *  `Workspace.resolveForTargetClass` with the named class pinned;
 *  the resolver's `stripInstance` logic does the right thing because
 *  no class-instance arg is in the argTypes list — i.e. the resolver
 *  returns `stripInstance=false`, so we pass the user's args
 *  through unchanged. */
export function lowerStaticClassMethodCall(
  this: Lowerer,
  className: string,
  methodName: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const userArgs: IRExpr[] = argExprs.map(a => this.lowerExpr(a));
  const argTypes: MType[] = userArgs.map(a => a.ty);
  const target = this.shared.workspace.resolveForTargetClass(
    methodName,
    argTypes,
    className,
    this.callSite(),
    span
  );
  if (target === null) {
    throw new TypeError(
      `class '${className}' has no method '${methodName}'`,
      span
    );
  }
  if (target.kind !== "classMethod") {
    throw new UnsupportedConstruct(
      `internal: targetClassName-pinned resolve for '${className}.` +
        `${methodName}' returned non-classMethod target '${target.kind}'`,
      span
    );
  }
  // For `ClassName.method(args)` the resolver returns stripInstance=false
  // (no class-instance in argTypes). The user args go straight through
  // to specialize — no receiver to prepend.
  const irArgs = target.stripInstance ? userArgs.slice() : userArgs.slice();
  return finishClassCall.call(
    this,
    classMethodSpecName(target.className, target.methodName),
    target.ast,
    target.file,
    irArgs,
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
