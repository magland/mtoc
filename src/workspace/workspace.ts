/**
 * Workspace + function dispatch.
 *
 * Thin adapter over numbl's vendored `LoweringContext` (see
 * `src/numbl-core/lowering/loweringContext.ts`). Numbl's
 * `resolveFunction` is the source of truth for "which function does
 * `foo(...)` refer to from this call site" — it implements MATLAB's
 * precedence rules (local > private > class > workspace > builtin),
 * `+pkg/` namespaces, `@Cls/` directories, `private/` directories,
 * and so on. mtoc translates the result back into its own narrow
 * `ResolvedTarget` shape: `userFunction` (with the source file and
 * AST attached) or `builtin`. Resolved kinds outside mtoc's v1
 * support surface are fenced off here with a clear
 * `UnsupportedConstruct` so the user sees a span.
 *
 * Workspace files (sibling `.m` files referenced by name in a call)
 * are registered up-front via `finalize()`, which builds the
 * vendored `FunctionIndex`. Resolution then runs without re-parsing.
 */

import type { AbstractSyntaxTree, Span, Stmt } from "../parser/index.js";
import { allBuiltinNames } from "./builtins.js";
import {
  LoweringContext,
  type ClassInfo,
} from "../numbl-core/lowering/loweringContext.js";
import { resolveFunction } from "../numbl-core/functionResolve.js";
import type { CallSite } from "../numbl-core/runtime/runtimeHelpers.js";
import type { ItemType } from "../numbl-core/lowering/itemTypes.js";
import type { MType } from "../lowering/types.js";
import { UnsupportedConstruct } from "../lowering/errors.js";

import type { FunctionStmt } from "../lowering/astAliases.js";
export type { FunctionStmt };

/** MATLAB names that are commonly used as operator-overload methods.
 *  Stage 1 rejects classes that define any of these — operator
 *  overloads need a different dispatch surface (the `lowerBinary`
 *  arm), which Stage 1 doesn't wire. Later stages remove this fence. */
const OPERATOR_OVERLOAD_METHOD_NAMES: ReadonlySet<string> = new Set([
  "plus",
  "minus",
  "uminus",
  "uplus",
  "times",
  "mtimes",
  "rdivide",
  "ldivide",
  "mrdivide",
  "mldivide",
  "power",
  "mpower",
  "eq",
  "ne",
  "lt",
  "gt",
  "le",
  "ge",
  "and",
  "or",
  "not",
  "xor",
  "transpose",
  "ctranspose",
  "subsref",
  "subsasgn",
  "subsindex",
  "horzcat",
  "vertcat",
  "cat",
  "end",
  "colon",
  "numel",
  "size",
  "length",
  "isscalar",
  "isempty",
  "display",
]);

/** Gate unsupported class shapes here so the diagnostic surfaces with
 *  a span at the call site, not deep in lowering. Validates every
 *  class in the inheritance chain rooted at `info`, since a child
 *  whose parent is unsupported (e.g. handle base, operator overloads)
 *  shouldn't pass either. */
function validateClassSupported(
  ctx: LoweringContext,
  info: ClassInfo,
  callName: string,
  span: Span
): void {
  // Walk the inheritance chain so an unsupported parent shape (handle
  // base, operator overloads, etc.) rejects the entire descendant.
  // findDefiningClass is a method-level walk; we hand-walk here for
  // the per-class shape checks.
  let cur: ClassInfo | null = info;
  while (cur !== null) {
    validateOneClass(cur, span);
    cur = cur.superClass === null ? null : ctx.getClassInfo(cur.superClass);
  }
  void callName;
}

/** Per-class shape validation — applied to every ancestor in the
 *  inheritance chain. */
function validateOneClass(info: ClassInfo, span: Span): void {
  // Handle classes: rejected wholesale. mtoc has no shared-storage /
  // refcount semantics yet (see docs/limitations.md).
  if (isHandleClass(info)) {
    throw new UnsupportedConstruct(
      `handle classes (\`classdef ${info.qualifiedName} < handle\`) are ` +
        `not yet supported by mtoc; value classes work`,
      span
    );
  }
  // Operator overloads / subsref / subsasgn: any class that defines
  // one of these names is rejected.
  for (const name of info.methodNames) {
    if (OPERATOR_OVERLOAD_METHOD_NAMES.has(name)) {
      throw new UnsupportedConstruct(
        `class '${info.qualifiedName}' defines method '${name}'; ` +
          `operator overloads / subsref / subsasgn / horzcat / vertcat ` +
          `are not yet supported by mtoc`,
        span
      );
    }
  }
  // External method files (`@Cls/method.m`): not yet supported.
  if (info.externalMethodFiles.size > 0) {
    throw new UnsupportedConstruct(
      `class '${info.qualifiedName}' uses external method files ` +
        `(\`@${info.qualifiedName}/\` folder); only classdef-inline methods ` +
        `are supported by mtoc`,
      span
    );
  }
  // Static methods are supported: ClassName.method(args) dispatches
  // via the resolver's targetClassName short-circuit + stripInstance
  // flag. obj.staticMethod(args) (instance-style call to a static
  // method) also flows through the same path with the receiver
  // dropped per stripInstance=true.
}

/** Detect a handle-base class — `classdef X < handle` or any class
 *  whose superclass chain bottoms out at `handle`. Note: in Stage 1
 *  with `superClass !== null` already rejected above, only the direct
 *  `< handle` case can survive — but the check is here for the day
 *  inheritance lands. */
function isHandleClass(info: ClassInfo): boolean {
  return info.superClass === "handle";
}

/** Look up a class method's AST (with constructor's receiver-output
 *  param already prepended when applicable) by walking the
 *  `Methods`-block bodies of the classdef AST. Mirrors the
 *  `getOrCreateClassFileContext`'s constructor-transform so the AST
 *  returned here has the same shape as the one the resolver
 *  effectively dispatches against. */
function lookupClassMethodAST(
  info: ClassInfo,
  methodName: string
): FunctionStmt | null {
  for (const member of info.ast.members) {
    if (member.type !== "Methods") continue;
    for (const stmt of member.body) {
      if (stmt.type !== "Function") continue;
      if (stmt.name !== methodName) continue;
      if (methodName === info.constructorName) {
        // Constructor: prepend the output variable as a hidden first
        // param, matching `getOrCreateClassFileContext`'s transform.
        const outputName = stmt.outputs.length > 0 ? stmt.outputs[0] : "obj";
        return { ...stmt, params: [outputName, ...stmt.params] };
      }
      return stmt;
    }
  }
  return null;
}

/**
 * Adapter from mtoc's `MType` to numbl's `ItemType`. Used to feed the
 * vendored `resolveFunction` enough information to apply its full
 * precedence rules — most importantly the class-instance branch that
 * decides class-method dispatch.
 *
 * The conversion is intentionally lossy: the resolver inspects
 * `kind === "ClassInstance"` and (only there) `className`. Every other
 * MType kind is observationally equivalent to `Unknown` from the
 * resolver's perspective, so we collapse them. If a future resolver
 * patch adds (say) a `Struct`-aware branch, this is the single
 * adapter that needs upgrading.
 */
export function mtypeToItemType(t: MType): ItemType {
  switch (t.kind) {
    case "Class":
      return { kind: "ClassInstance", className: t.className };
    case "Numeric":
    case "String":
    case "Struct":
    case "Handle":
    case "TupleCell":
    case "HomogeneousCell":
    case "Unknown":
    case "Void":
      return { kind: "Unknown" };
  }
}

export interface WorkspaceFile {
  name: string;
  source: string;
  ast?: AbstractSyntaxTree;
}

export type ResolvedTarget =
  | {
      kind: "userFunction";
      /** Original MATLAB name as written at the call site. */
      name: string;
      /** AST of the function definition. */
      ast: FunctionStmt;
      /** Source file the function lives in. Used to salt
       *  specialization mangling and to drive subfunction visibility. */
      file: string;
    }
  | { kind: "builtin"; name: string }
  | {
      /** Class constructor call: `MyClass(args)` resolves here when
       *  `MyClass` is a workspace or local class. The AST is the
       *  constructor function with the receiver-output param already
       *  prepended (the vendored ctx's `getOrCreateClassFileContext`
       *  handles that transform). */
      kind: "classConstructor";
      className: string;
      /** Constructor AST (with `obj` prepended as the first param). */
      ast: FunctionStmt;
      /** The class file the constructor was loaded from. Salts the
       *  specialization key. */
      file: string;
    }
  | {
      /** Class method call: returned for both `obj.method(args)` and
       *  `method(obj, args)` forms. The resolver picks the winning
       *  class (inheritance chain or InferiorClasses precedence); the
       *  defining class (where the method's AST actually lives) is
       *  resolved here via `findDefiningClass`. */
      kind: "classMethod";
      className: string;
      methodName: string;
      /** Method AST (instance methods take the receiver as their
       *  declared first param; static methods don't). */
      ast: FunctionStmt;
      /** The class file the method's AST was loaded from. */
      file: string;
      /** Resolver's `stripInstance` flag: when true, the caller MUST
       *  drop the receiver from the IR-arg list before specializing —
       *  the static method's signature has no receiver param. */
      stripInstance: boolean;
    };

export class Workspace {
  /** Per-file cache: file name → file record (source + AST). The AST
   *  cache is also mirrored into the vendored LoweringContext, but the
   *  side map keeps `source` retrievable for the codegen header
   *  comment (`source.startLine`–`endLine`). */
  readonly files: Map<string, WorkspaceFile> = new Map();
  readonly mainFile: string;
  /** Ordered search paths used by the vendored resolver to compute
   *  relative paths (and hence workspace-function names). For the
   *  CLI, this is `[dirname(absoluteEntry)]`. For the web IDE (where
   *  files are flat names with no directory component), this is `[]`
   *  — the resolver then treats every name as already-relative. */
  readonly searchPaths: ReadonlyArray<string>;

  /** Vendored numbl resolution context. Holds the workspace
   *  registry (workspace files, classes, private files) and the
   *  built FunctionIndex used by `resolveFunction`. */
  readonly ctx: LoweringContext;

  /** Last activeName seeded into the ctx. Used by `lookupAstForUserFunction`
   *  when the resolved target is a local function in the main file. */
  private mainAstStmts: Stmt[] = [];

  /** Set by `finalize()` so a subsequent `resolve()` can finalize-on-demand
   *  if the caller forgot to do it explicitly. Prevents a silent
   *  empty-index failure. */
  private finalized = false;

  constructor(mainFile: string, searchPaths: ReadonlyArray<string> = []) {
    this.mainFile = mainFile;
    this.searchPaths = searchPaths;
    this.ctx = new LoweringContext("", mainFile);
    this.ctx.registry.searchPaths = [...searchPaths];
  }

  /** Register a file by name. Stores it on the side map and seeds the
   *  vendored AST cache so the indexer + resolver can find it. */
  addFile(file: WorkspaceFile): void {
    this.files.set(file.name, file);
    if (file.ast) {
      this.ctx.fileASTCache.set(file.name, file.ast);
      if (file.name === this.mainFile) {
        this.mainAstStmts = file.ast.body;
      }
    }
  }

  /** Build the function index. Call once after every file has been
   *  added and the main file's top-level function definitions have
   *  been registered via `registerLocalFunction`. Idempotent — a
   *  second call is a no-op. `resolve()` calls this lazily so a
   *  caller that forgets the explicit step still gets a populated
   *  index instead of an empty one. */
  finalize(): void {
    if (this.finalized) return;
    // Build the workspace-file list (everything except the main file).
    const wsFiles = [...this.files.values()]
      .filter(f => f.name !== this.mainFile)
      .map(f => ({ name: f.name, source: f.source }));
    this.ctx.registerWorkspaceFiles(wsFiles);
    this.ctx.buildFunctionIndex();
    this.finalized = true;
  }

  /** Register a top-level function definition from the main file. Mirrors
   *  numbl's `registerLocalFunctionAST` on the LoweringContext. */
  registerLocalFunction(fn: FunctionStmt): void {
    this.ctx.registerLocalFunctionAST(fn);
  }

  /** Resolve a function call. The vendored `resolveFunction` returns a
   *  rich tagged target (`workspaceFunction`, `localFunction`,
   *  `privateFunction`, `classMethod`, …); mtoc translates it back into
   *  its own narrow `ResolvedTarget`. Unsupported kinds raise
   *  `UnsupportedConstruct` at the call site.
   *
   *  `argTypes` carries the mtoc-side types of the call's arguments,
   *  in declaration order. They're converted to numbl's ItemType via
   *  `mtypeToItemType` and fed to the resolver so its precedence rules
   *  (class-method-vs-workspace-function-vs-local-function,
   *  InferiorClasses promotion, static-method `stripInstance`) all
   *  apply correctly. Pass `[]` when the args haven't been lowered yet
   *  — the resolver's behavior on empty `argTypes` matches the legacy
   *  call sites' behavior exactly. */
  resolve(
    name: string,
    argTypes: ReadonlyArray<MType>,
    callSite: CallSite,
    span: Span
  ): ResolvedTarget | null {
    this.finalize();
    const itemTypes = argTypes.map(t => mtypeToItemType(t));
    const target = resolveFunction(
      name,
      itemTypes,
      callSite,
      this.ctx.functionIndex
    );
    if (!target) return null;
    switch (target.kind) {
      case "builtin":
        return { kind: "builtin", name: target.name };
      case "localFunction": {
        if (target.source.from === "main") {
          const ast = this.findStmtInBody(this.mainAstStmts, name);
          if (!ast) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a main-file local ` +
                `function but no AST is registered`,
              span
            );
          }
          return { kind: "userFunction", name, ast, file: this.mainFile };
        }
        if (target.source.from === "workspaceFile") {
          const wsName = target.source.wsName;
          const entry = this.ctx.registry.filesByFuncName.get(wsName);
          if (!entry) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a subfunction of ` +
                `workspace file '${wsName}' but no file is registered`,
              span
            );
          }
          const ast = this.lookupSubfunctionInFile(entry.fileName, name);
          if (!ast) {
            throw new UnsupportedConstruct(
              `internal: resolver claimed '${name}' is a subfunction of ` +
                `'${entry.fileName}' but no matching Function stmt was found`,
              span
            );
          }
          return { kind: "userFunction", name, ast, file: entry.fileName };
        }
        // classFile / privateFile subfunctions are not yet supported.
        throw new UnsupportedConstruct(
          `function '${name}' resolves to a subfunction of a ` +
            `${target.source.from === "classFile" ? "class file" : "private file"}` +
            `; this is not yet supported by mtoc`,
          span
        );
      }
      case "workspaceFunction": {
        const entry = this.ctx.registry.filesByFuncName.get(target.name);
        if (!entry) {
          throw new UnsupportedConstruct(
            `internal: resolver claimed '${target.name}' is a workspace ` +
              `function but no file is registered`,
            span
          );
        }
        const ast = this.firstFunctionInFile(entry.fileName);
        if (!ast) {
          throw new UnsupportedConstruct(
            `'${entry.fileName}' has no function definitions; mtoc cannot ` +
              `use it as a workspace function`,
            span
          );
        }
        return { kind: "userFunction", name, ast, file: entry.fileName };
      }
      case "privateFunction":
        throw new UnsupportedConstruct(
          `private functions (under a 'private/' directory) are not yet ` +
            `supported by mtoc`,
          span
        );
      case "classMethod": {
        // Use findDefiningClass to walk the inheritance chain rooted
        // at the verdict's class and locate the AST. The resolver's
        // verdict (className) already encodes the precedence rules
        // (single class, inferior-class promotion, targetClassName
        // short-circuit); findDefiningClass is just an AST lookup.
        const definingClass = this.ctx.findDefiningClass(
          target.className,
          target.methodName
        );
        const info = this.ctx.getClassInfo(definingClass);
        if (info === null) {
          throw new UnsupportedConstruct(
            `internal: resolver returned classMethod for '${target.className}.${target.methodName}' but no ClassInfo was found`,
            span
          );
        }
        // Gate Stage 1 unsupported class shapes here (handle base,
        // external method files, etc.) so the user sees a clear span
        // at the call site.
        validateClassSupported(this.ctx, info, target.methodName, span);
        const ast = lookupClassMethodAST(info, target.methodName);
        if (ast === null) {
          throw new UnsupportedConstruct(
            `internal: class '${definingClass}' has no AST for method '${target.methodName}'`,
            span
          );
        }
        return {
          kind: "classMethod",
          className: definingClass,
          methodName: target.methodName,
          ast,
          file: info.fileName,
          stripInstance: target.stripInstance,
        };
      }
      case "workspaceClassConstructor": {
        const info = this.ctx.getClassInfo(target.className);
        if (info === null) {
          throw new UnsupportedConstruct(
            `internal: resolver returned workspaceClassConstructor for '${target.className}' but no ClassInfo was found`,
            span
          );
        }
        if (info.constructorName === null) {
          throw new UnsupportedConstruct(
            `class '${target.className}' has no constructor; mtoc Stage 1 ` +
              `requires an explicit constructor (the implicit zero-arg form ` +
              `is not yet supported)`,
            span
          );
        }
        validateClassSupported(this.ctx, info, info.constructorName, span);
        const ast = lookupClassMethodAST(info, info.constructorName);
        if (ast === null) {
          throw new UnsupportedConstruct(
            `internal: class '${target.className}' has no AST for constructor '${info.constructorName}'`,
            span
          );
        }
        return {
          kind: "classConstructor",
          className: target.className,
          ast,
          file: info.fileName,
        };
      }
      case "jsUserFunction":
        throw new UnsupportedConstruct(
          `JS user functions (.numbl.js) are not yet supported by mtoc`,
          span
        );
      default: {
        const _exhaustive: never = target;
        void _exhaustive;
        throw new UnsupportedConstruct(
          `internal: unhandled resolved-target kind`,
          span
        );
      }
    }
  }

  /** Resolve a call against a specific class — sets `targetClassName`
   *  on the CallSite before delegating to `resolve`. Use for the
   *  method-call-syntax (`obj.method(args)`) and super-call
   *  (`obj@Parent(args)`) paths: the resolver's `targetClassName`
   *  short-circuit ([functionResolve.ts:174-192]) forces dispatch
   *  into the named class while still honoring the static-method
   *  detection / `stripInstance` flip. */
  resolveForTargetClass(
    name: string,
    argTypes: ReadonlyArray<MType>,
    targetClassName: string,
    callSite: CallSite,
    span: Span
  ): ResolvedTarget | null {
    return this.resolve(name, argTypes, { ...callSite, targetClassName }, span);
  }

  hasBuiltin(name: string): boolean {
    return allBuiltinNames().includes(name);
  }

  /** Helper for codegen: look up the source text of a file by its name.
   *  Returns undefined if the file isn't registered. */
  sourceOf(file: string): string | undefined {
    return this.files.get(file)?.source;
  }

  /** Look up a subfunction (any non-primary Function stmt) inside a
   *  workspace file's AST. */
  private lookupSubfunctionInFile(
    fileName: string,
    name: string
  ): FunctionStmt | null {
    const ast = this.ctx.fileASTCache.get(fileName);
    if (!ast) return null;
    return this.findStmtInBody(ast.body, name);
  }

  /** Return the first Function stmt in a workspace file (the "primary"
   *  function — what `<basename>(...)` calls map to, regardless of the
   *  declared name; matches numbl). */
  private firstFunctionInFile(fileName: string): FunctionStmt | null {
    const ast = this.ctx.fileASTCache.get(fileName);
    if (!ast) return null;
    for (const s of ast.body) {
      if (s.type === "Function") return s;
    }
    return null;
  }

  private findStmtInBody(body: Stmt[], name: string): FunctionStmt | null {
    for (const s of body) {
      if (s.type === "Function" && s.name === name) return s;
    }
    return null;
  }
}
