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
import { LoweringContext } from "../numbl-core/lowering/loweringContext.js";
import { resolveFunction } from "../numbl-core/functionResolve.js";
import type { CallSite } from "../numbl-core/runtime/runtimeHelpers.js";
import { UnsupportedConstruct } from "../lowering/errors.js";

/** Narrowed alias for the parser's `Stmt.Function`. */
export type FunctionStmt = Extract<Stmt, { type: "Function" }>;

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
  | { kind: "builtin"; name: string };

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
   *  `UnsupportedConstruct` at the call site. */
  resolve(name: string, callSite: CallSite, span: Span): ResolvedTarget | null {
    this.finalize();
    const target = resolveFunction(name, [], callSite, this.ctx.functionIndex);
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
      case "classMethod":
      case "workspaceClassConstructor":
        throw new UnsupportedConstruct(
          `class methods / constructors are not yet supported by mtoc`,
          span
        );
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
