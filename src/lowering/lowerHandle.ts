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

import type { Expr, Span, Stmt } from "../parser/index.js";
import { getBuiltin } from "../workspace/builtins.js";
import { getConstant } from "../workspace/constants.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr } from "./ir.js";
import { Lowerer } from "./lower.js";
import { lowerBuiltinCall, specializeUserCall } from "./lowerFuncCall.js";
import {
  anonymousHandle,
  builtinHandle,
  isHandle,
  typeToString,
  userFuncHandle,
  type HandleType,
  type MType,
} from "./types.js";

/** AST shape of a `function … end` declaration. Mirrors the type
 *  exported by `workspace.ts`; redeclared locally to avoid the circular
 *  import lowering/types ↔ workspace through this file. */
type FunctionStmt = Extract<Stmt, { type: "Function" }>;

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
  return { kind: "HandleLit", ty, span: e.span };
}

/** Lower a `@(p1, ..., pN) <body>` anonymous function. v1: rejects any
 *  body that references an outer-scope local (a "capture"). Accepted
 *  bodies are synthesized into a FunctionStmt-shaped AST with a single
 *  output, registered in the spec cache under a synthetic
 *  `_mtoc_anon_<N>` name. The handle's MType carries that name as its
 *  target identity (so a higher-order user function specializes per-
 *  anonymous-body). */
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
  // Capture detection: a free identifier in the body that's bound in
  // the enclosing scope (env) and not in the param list is a capture.
  // The walker only looks at Idents — Ident-shaped Method/FuncCall
  // names are handled separately (function/builtin lookups, not
  // variable reads).
  const paramSet = new Set(e.params);
  const captured = findFirstCapture(this, e.body, paramSet);
  if (captured !== null) {
    throw new UnsupportedConstruct(
      `anonymous function captures '${captured}' from the enclosing scope; ` +
        `captures are not yet supported. Workarounds: move the captured ` +
        `value into a parameter and pass it at the call site, or replace ` +
        `'@(...)' with a named function.`,
      e.span
    );
  }

  // Synthesize a FunctionStmt:
  //
  //   function <outName> = <synthName>(p1, ..., pN)
  //     <outName> = <body>;
  //   end
  //
  // <synthName> and <outName> use a counter from the shared state so
  // each `@(...)` site gets a unique identity. The names do NOT use
  // the reserved `_mtoc_` prefix (which `assertNotMtocReserved` would
  // reject) — they're regular MATLAB identifiers in form, just
  // unlikely to collide with user code.
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
    params: e.params,
    outputs: [outName],
    body: [assignStmt],
    argumentsBlocks: [],
    span: e.span,
  };
  const ty = anonymousHandle(synthName, synthAst, this.currentFile);
  return { kind: "HandleLit", ty, span: e.span };
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
    // Defer to the regular builtin-call path. The builtin's `lowerExpr`
    // hook (if any) runs as it would for `<name>(args)`; sign-domain
    // and shape checks fire with the args' spans.
    return lowerBuiltinCall.call(this, t.name, argExprs, span);
  }
  // userFunc / anonymous: same machinery. Both have an AST + a source
  // file; `specializeUserCall` does the lowering + caching.
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
  const spec = specializeUserCall.call(
    this,
    matlabName,
    fnAst,
    fnFile,
    argExprs,
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
function findFirstCapture(
  outer: Lowerer,
  e: Expr,
  params: ReadonlySet<string>
): string | null {
  switch (e.type) {
    case "Ident": {
      if (params.has(e.name)) return null;
      // Constants and builtins are name-based, not variable-based —
      // they don't capture.
      if (getConstant(e.name)) return null;
      if (getBuiltin(e.name)) return null;
      // Workspace functions (resolved by name in the enclosing
      // workspace) aren't captures either — but a strict resolve()
      // call here would surface a stray "unresolved" error at the
      // anonymous-function site instead of the body's eventual
      // lowering. Just check the env; if a name happens to alias a
      // workspace function AND a variable, the variable wins under
      // numbl semantics (which is what we'd reject anyway).
      if (outer.envLookup(e.name) !== undefined) return e.name;
      return null;
    }
    case "Number":
    case "Char":
    case "String":
    case "EndKeyword":
    case "ImagUnit":
    case "Colon":
    case "MetaClass":
      return null;
    case "Binary":
      return (
        findFirstCapture(outer, e.left, params) ??
        findFirstCapture(outer, e.right, params)
      );
    case "Unary":
      return findFirstCapture(outer, e.operand, params);
    case "Range":
      return (
        findFirstCapture(outer, e.start, params) ??
        (e.step ? findFirstCapture(outer, e.step, params) : null) ??
        findFirstCapture(outer, e.end, params)
      );
    case "FuncCall": {
      // The call's `name` is a function lookup, not a variable read —
      // skip it (a workspace function named the same as an enclosing
      // variable still routes to the function in numbl's resolver,
      // except when the variable shadows it inside this body; that
      // shadowing only matters for body lowering, not for capture
      // detection at the @-site). Recurse into args.
      for (const a of e.args) {
        const r = findFirstCapture(outer, a, params);
        if (r !== null) return r;
      }
      // But if the name itself is bound in the outer scope as a
      // variable (e.g. `f` is a captured handle, and the body calls
      // `f(x)`), we DO want to reject — the body is trying to call
      // through a captured handle. This is the exact "capture" case
      // we're refusing in v1.
      if (
        !params.has(e.name) &&
        !getConstant(e.name) &&
        !getBuiltin(e.name) &&
        outer.envLookup(e.name) !== undefined
      ) {
        return e.name;
      }
      return null;
    }
    case "Index":
    case "IndexCell":
      return (
        findFirstCapture(outer, e.base, params) ??
        firstCaptureInArr(outer, e.indices, params)
      );
    case "Member":
      return findFirstCapture(outer, e.base, params);
    case "MemberDynamic":
      return (
        findFirstCapture(outer, e.base, params) ??
        findFirstCapture(outer, e.nameExpr, params)
      );
    case "MethodCall":
      return (
        findFirstCapture(outer, e.base, params) ??
        firstCaptureInArr(outer, e.args, params)
      );
    case "SuperMethodCall":
      return firstCaptureInArr(outer, e.args, params);
    case "AnonFunc": {
      // Nested anonymous: descend with an extended param set (inner
      // params shadow the outer's). Captures from the OUTER scope
      // through the inner are still captures of the outer anonymous
      // — which v1 rejects. So we just union the param sets and
      // recurse.
      const nested = new Set(params);
      for (const p of e.params) nested.add(p);
      return findFirstCapture(outer, e.body, nested);
    }
    case "FuncHandle":
      // `@name` inside a `@(...)` body resolves at body-lowering
      // time, not at the outer @-site. No free vars introduced.
      return null;
    case "Tensor":
    case "Cell":
      for (const row of e.rows) {
        for (const cell of row) {
          const r = findFirstCapture(outer, cell, params);
          if (r !== null) return r;
        }
      }
      return null;
    case "ClassInstantiation":
      return firstCaptureInArr(outer, e.args, params);
  }
}

function firstCaptureInArr(
  outer: Lowerer,
  arr: ReadonlyArray<Expr>,
  params: ReadonlySet<string>
): string | null {
  for (const e of arr) {
    const r = findFirstCapture(outer, e, params);
    if (r !== null) return r;
  }
  return null;
}
