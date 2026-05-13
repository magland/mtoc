/**
 * Function-handle lowering: `@name` (named handle to a user function
 * or builtin) and `@(...) ...` (anonymous function). v1 produces a
 * phantom `HandleType` carrying the resolved target identity — there
 * is no runtime representation. Every later `h(args)` call site reads
 * the bound variable's MType and dispatches statically to the
 * underlying user-function specialization (or builtin emit).
 *
 * Anonymous functions are synthesized into a `FunctionStmt`-shaped AST
 * and threaded through the existing `specializeUserCall` pipeline by
 * `lowerHandleCall`. v1 rejects any anonymous body that references an
 * outer-scope local (a "capture") — the rejection points at Phase 2.
 */

import type { Expr, Span } from "../parser/index.js";
import { getBuiltin } from "../workspace/builtins.js";
import { getConstant } from "../workspace/constants.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { FunctionStmt } from "./astAliases.js";
import type { IRExpr } from "./ir.js";
import { Lowerer } from "./lower.js";
import {
  lowerBuiltinCall,
  specializeUserCallWithIRArgs,
} from "./lowerFuncCall.js";
import {
  anonymousHandle,
  builtinHandle,
  isHandle,
  typeToString,
  userFuncHandle,
  type HandleType,
  type MType,
} from "./types.js";

/** Lower a `@name` AST node to a phantom `HandleLit`. Resolves the
 *  target through the workspace; the result carries the resolved AST
 *  (for user functions) or the builtin name (for builtins). Anything
 *  else — class methods, package paths, an unknown name — raises
 *  `UnsupportedConstruct` with a span.
 *
 *  A leading-scope check excludes the `@<varName>` case (numbl
 *  semantics: `@name` is always a function reference, never a
 *  variable read). */
export function lowerFuncHandle(
  this: Lowerer,
  e: Extract<Expr, { type: "FuncHandle" }>
): IRExpr {
  if (this.envLookup(e.name) !== undefined) {
    throw new TypeError(
      `function-handle target '@${e.name}' refers to an in-scope variable, ` +
        `not a function (numbl forbids '@' on a non-function name)`,
      e.span
    );
  }
  let ty: HandleType;
  const target = this.shared.workspace.resolve(
    e.name,
    { file: this.currentFile },
    e.span
  );
  if (target?.kind === "userFunction") {
    ty = userFuncHandle(target.name, target.file, target.ast);
  } else if (getBuiltin(e.name)) {
    ty = builtinHandle(e.name);
  } else {
    throw new UnsupportedConstruct(
      `unresolved function-handle target '@${e.name}'`,
      e.span
    );
  }
  // Named handles never capture — empty captures list, empty struct
  // literal at codegen.
  return { kind: "HandleLit", captures: [], ty, span: e.span };
}

/** Lower a `@(p1, ..., pN) <body>` anonymous function. Detects every
 *  variable in the body that's bound in the enclosing scope and not in
 *  the param list ("captures"), snapshots each one's value into the
 *  handle struct at the `@(...)` site, and appends the captures to the
 *  synthesized function's tail params so the body's references resolve
 *  naturally. The captures travel with the handle wherever it goes;
 *  at each `h(x)` call site, the handle's struct fields supply the
 *  captures' values as additional positional arguments to the underlying
 *  specialization. */
export function lowerAnonFunc(
  this: Lowerer,
  e: Extract<Expr, { type: "AnonFunc" }>
): IRExpr {
  // Disallow `~` params (they'd require the ignore-marker plumbing in
  // the synthesized body, which v1 doesn't need).
  for (const p of e.params) {
    if (p === "~") {
      throw new UnsupportedConstruct(
        `'~' is not allowed as an anonymous-function parameter`,
        e.span
      );
    }
  }
  // Capture collection: every free Ident in the body that's bound in
  // the enclosing scope (env) and not in the param list is a capture.
  // Order matters — we use registration order for both the synth
  // function's tail-params and the handle struct's field order, so
  // the underlying call site can match positions.
  const paramSet = new Set(e.params);
  const captureNames: string[] = [];
  const captureSet = new Set<string>();
  collectCaptures(this, e.body, paramSet, captureNames, captureSet);

  // Disallow capture name conflicting with user-declared params (numbl
  // shadowing rule prohibits this at the source level; defensive
  // check here so an unusual parser path doesn't sneak past).
  for (const c of captureNames) {
    if (paramSet.has(c)) {
      throw new UnsupportedConstruct(
        `anonymous-function parameter '${c}' shadows a captured variable; rename the parameter`,
        e.span
      );
    }
  }

  // Build the capture-value IR expressions: each capture reads the
  // outer scope's binding at the @-site. The outer scope's env tells
  // us the captured variable's TYPE; the C-level snapshot lives in
  // the handle struct's `cap_<name>` field, populated by the
  // codegen's compound-literal renderer.
  const captureValues: { name: string; value: IRExpr }[] = [];
  const captures: { name: string; ty: MType }[] = [];
  for (const cname of captureNames) {
    const capTy = this.envLookup(cname);
    if (capTy === undefined) {
      // Should never happen — collectCaptures only added names whose
      // envLookup returned non-undefined. Belt-and-suspenders.
      throw new UnsupportedConstruct(
        `internal: capture '${cname}' lost between detection and lowering`,
        e.span
      );
    }
    captures.push({ name: cname, ty: capTy });
    captureValues.push({
      name: cname,
      value: {
        kind: "Var",
        name: cname,
        cName: this.currentCNameFor(cname),
        ty: capTy,
        span: e.span,
      },
    });
  }

  // Synthesize a FunctionStmt:
  //
  //   function <outName> = <synthName>(p1, ..., pN, c1, ..., cM)
  //     <outName> = <body>;
  //   end
  //
  // The captures appear as TAIL parameters of the synth function.
  // When the body lowers, the inner Lowerer's env has both the
  // user-params and the capture-params bound — so a body reference
  // to a captured `k` resolves to the synth function's `k` param,
  // not the (no-longer-in-scope) outer binding.
  const idx = this.shared.anonCounter.value++;
  const synthName = `anon_${idx}`;
  const outName = `anonOut_${idx}`;
  const assignStmt = {
    type: "Assign" as const,
    name: outName,
    expr: e.body,
    suppressed: true,
    span: e.span,
  };
  const synthAst: FunctionStmt = {
    type: "Function",
    name: synthName,
    functionId: synthName,
    params: [...e.params, ...captureNames],
    outputs: [outName],
    body: [assignStmt],
    argumentsBlocks: [],
    span: e.span,
  };
  const ty = anonymousHandle(synthName, synthAst, this.currentFile, captures);
  return {
    kind: "HandleLit",
    captures: captureValues,
    ty,
    span: e.span,
  };
}

/** Lower `h(args...)` where `h` resolves to an in-scope variable of
 *  `HandleType` in expression position. Reads the handle's resolved
 *  target off the variable's MType and dispatches:
 *    - userFunc / anonymous: route through `specializeUserCall`,
 *      which builds the lowered args, mangles a fresh specialization
 *      key, and caches the resulting `IRFunction`. The emitted IR
 *      Call's `callee.mangled` is the underlying user-function name.
 *    - builtin: route through `lowerBuiltinCall` — the existing path
 *      validates args against the sig, dispatches the elementwise
 *      lift if applicable, and produces an `IRExpr.Call` with
 *      `callee = {kind: "builtin", sig}`.
 *
 *  Multi-output and zero-output handle calls are rejected at this
 *  expression-position entry — they require the statement-position
 *  forms (`[a, b] = h(x);` or bare-statement `h(x);`), which
 *  `lower.ts` routes directly through `lowerMultiAssignCall` after
 *  unwrapping the handle's target via `handleUserCallable`. */
export function lowerHandleCall(
  this: Lowerer,
  handleName: string,
  handleTy: MType,
  argExprs: Expr[],
  span: Span
): IRExpr {
  if (!isHandle(handleTy)) {
    throw new Error(
      `lowerHandleCall: '${handleName}' is not a handle (got ${typeToString(handleTy)})`
    );
  }
  const t = handleTy.target;
  if (t.kind === "builtin") {
    // Builtin handles never carry captures. Defer to the regular
    // builtin-call path — the builtin's `lowerExpr` hook (if any)
    // runs as it would for `<name>(args)`; sign-domain and shape
    // checks fire with the args' spans.
    return lowerBuiltinCall.call(this, t.name, argExprs, span);
  }
  // userFunc / anonymous: same machinery. Both have an AST + a source
  // file. The CALLEE's params are `[...userParams, ...captureNames]`,
  // so the args we hand to specialization must mirror that order:
  // user-source args first, then the handle's captures read off the
  // struct via `HandleCaptureLoad` nodes.
  const fnAst = t.ast;
  const fnFile = t.file;
  const matlabName = t.kind === "userFunc" ? t.name : t.mangledBase;
  if (fnAst.outputs.length === 0) {
    throw new UnsupportedConstruct(
      `handle '@${matlabName}' refers to a zero-output function and cannot ` +
        `be invoked in expression position; call it as a bare statement instead`,
      span
    );
  }
  if (fnAst.outputs.length !== 1) {
    throw new UnsupportedConstruct(
      `handle '@${matlabName}' refers to a ${fnAst.outputs.length}-output ` +
        `function; invoke via '[a, b, ...] = ${handleName}(...)' instead`,
      span
    );
  }
  const userArgs = argExprs.map(a => this.lowerExpr(a));
  const captureArgs = buildCaptureArgs(this, handleName, handleTy, span);
  const allArgs = [...userArgs, ...captureArgs];
  const spec = specializeUserCallWithIRArgs.call(
    this,
    matlabName,
    fnAst,
    fnFile,
    allArgs,
    span
  );
  return {
    kind: "Call",
    name: matlabName,
    callee: { kind: "userFunc", mangled: spec.mangledName },
    args: spec.args,
    ty: spec.spec.outputs[0].ty,
    span,
  };
}

/** Build the per-capture `HandleCaptureLoad` IR nodes for a
 *  handle-call site. Each capture becomes a read of `<handle>.cap_<name>`
 *  passed as a positional arg to the underlying specialization. */
function buildCaptureArgs(
  outer: Lowerer,
  handleName: string,
  handleTy: HandleType,
  span: Span
): IRExpr[] {
  if (handleTy.captures.length === 0) return [];
  const baseTy = handleTy;
  const baseCName = outer.currentCNameFor(handleName);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name: handleName,
    cName: baseCName,
    ty: baseTy,
    span,
  };
  return handleTy.captures.map(c => ({
    kind: "HandleCaptureLoad" as const,
    base,
    captureName: c.name,
    ty: c.ty,
    span,
  }));
}

/** Extract the user-callable (AST + file + name) underlying a handle
 *  variable's MType. Used by the statement-position dispatchers in
 *  `lower.ts` (bare-statement / multi-assign call form) when the
 *  callee name resolves to a handle in env. Builtin handles cannot
 *  appear at multi-output / zero-output positions — they're rejected
 *  here with a clear span-carrying error. */
export function handleUserCallable(
  handleTy: MType,
  span: Span
): { ast: FunctionStmt; file: string; name: string } {
  if (!isHandle(handleTy)) {
    throw new Error(`handleUserCallable: not a handle`);
  }
  const t = handleTy.target;
  if (t.kind === "builtin") {
    throw new UnsupportedConstruct(
      `builtin function handles ('@${t.name}') return a single value and ` +
        `cannot be invoked through multi-assign or bare-statement zero/multi-output syntax`,
      span
    );
  }
  return {
    ast: t.ast,
    file: t.file,
    name: t.kind === "userFunc" ? t.name : t.mangledBase,
  };
}

/** Walk a parser AST expression and return the first `Ident` whose
 *  name is bound in the enclosing scope (`outerLowerer.envLookup`) and
 *  not in `params`. Used by `lowerAnonFunc` to detect captures.
 *
 *  Idents that hit a known constant / builtin / workspace function are
 *  NOT captures — they're function references or constant reads. A
 *  workspace function check is intentionally deferred to the call-site
 *  inspection: walking through `workspace.resolve` for every Ident
 *  would be expensive and a stray "Identifier that happens to share a
 *  workspace function name" is unusual enough to surface clearly at
 *  the real lowering of the body. */
function collectCaptures(
  outer: Lowerer,
  e: Expr,
  params: ReadonlySet<string>,
  names: string[],
  seen: Set<string>
): void {
  const register = (name: string): void => {
    if (params.has(name)) return;
    if (seen.has(name)) return;
    if (getConstant(name)) return;
    if (getBuiltin(name)) return;
    if (outer.envLookup(name) === undefined) return;
    seen.add(name);
    names.push(name);
  };
  switch (e.type) {
    case "Ident":
      register(e.name);
      return;
    case "Number":
    case "Char":
    case "String":
    case "EndKeyword":
    case "ImagUnit":
    case "Colon":
    case "MetaClass":
      return;
    case "Binary":
      collectCaptures(outer, e.left, params, names, seen);
      collectCaptures(outer, e.right, params, names, seen);
      return;
    case "Unary":
      collectCaptures(outer, e.operand, params, names, seen);
      return;
    case "Range":
      collectCaptures(outer, e.start, params, names, seen);
      if (e.step) collectCaptures(outer, e.step, params, names, seen);
      collectCaptures(outer, e.end, params, names, seen);
      return;
    case "FuncCall": {
      // A bare `name(args)` inside the body may resolve to a
      // captured variable (e.g. the body calls `f(x)` where `f` is
      // a captured handle) OR to a builtin / workspace function.
      // We register `name` as a capture only when it matches an
      // enclosing-scope binding — same `register` predicate as
      // Ident. Args recurse normally.
      register(e.name);
      for (const a of e.args) collectCaptures(outer, a, params, names, seen);
      return;
    }
    case "Index":
    case "IndexCell":
      collectCaptures(outer, e.base, params, names, seen);
      for (const i of e.indices) collectCaptures(outer, i, params, names, seen);
      return;
    case "Member":
      collectCaptures(outer, e.base, params, names, seen);
      return;
    case "MemberDynamic":
      collectCaptures(outer, e.base, params, names, seen);
      collectCaptures(outer, e.nameExpr, params, names, seen);
      return;
    case "MethodCall":
      collectCaptures(outer, e.base, params, names, seen);
      for (const a of e.args) collectCaptures(outer, a, params, names, seen);
      return;
    case "SuperMethodCall":
      for (const a of e.args) collectCaptures(outer, a, params, names, seen);
      return;
    case "AnonFunc": {
      // Nested anonymous: inner params shadow the outer's. Captures
      // from the OUTER scope reached through the inner body are
      // still captures of the OUTER anonymous (the inner anonymous
      // would, when itself lowered, capture them through its own
      // mechanism — but the outer needs them too so the inner has
      // access). Union the param sets and recurse.
      const nested = new Set(params);
      for (const p of e.params) nested.add(p);
      collectCaptures(outer, e.body, nested, names, seen);
      return;
    }
    case "FuncHandle":
      // `@name` inside a `@(...)` body resolves at body-lowering
      // time to a function reference — it doesn't capture an outer
      // variable.
      return;
    case "Tensor":
    case "Cell":
      for (const row of e.rows) {
        for (const cell of row)
          collectCaptures(outer, cell, params, names, seen);
      }
      return;
    case "ClassInstantiation":
      for (const a of e.args) collectCaptures(outer, a, params, names, seen);
      return;
  }
}
