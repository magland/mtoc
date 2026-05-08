/**
 * Workspace + function dispatch.
 *
 * Today only the seed shape: a single main file plus a tiny set of
 * builtins recognized by codegen (just `disp`). Resolution returns a
 * tagged target so future call sites can dispatch on `kind` once user
 * functions and specialization caches land.
 */

import type { AbstractSyntaxTree, Stmt } from "../parser/index.js";
import { allBuiltinNames, getBuiltin } from "./builtins.js";

/** Narrowed alias for the parser's `Stmt.Function`. */
export type FunctionStmt = Extract<Stmt, { type: "Function" }>;

export interface WorkspaceFile {
  name: string;
  source: string;
  ast?: AbstractSyntaxTree;
}

export type ResolvedTarget =
  | { kind: "builtin"; name: string }
  | { kind: "userFunction"; name: string };

export class Workspace {
  readonly files: Map<string, WorkspaceFile> = new Map();
  /** Local user-defined functions found in the main file (script-level
   *  definitions). Mirrors numbl's local-function precedence: visible
   *  only from within the same file. */
  readonly localFunctions: Map<string, FunctionStmt> = new Map();
  mainFile: string;

  constructor(mainFile: string) {
    this.mainFile = mainFile;
  }

  addFile(file: WorkspaceFile): void {
    this.files.set(file.name, file);
  }

  registerLocalFunction(fn: FunctionStmt): void {
    if (this.localFunctions.has(fn.name)) {
      throw new Error(
        `duplicate local function definition: '${fn.name}'`
      );
    }
    this.localFunctions.set(fn.name, fn);
  }

  resolve(name: string): ResolvedTarget | null {
    // Local user functions shadow builtins (matches MATLAB precedence).
    if (this.localFunctions.has(name)) {
      return { kind: "userFunction", name };
    }
    // Single registry: both `disp` (category="stmt") and every
    // expression-builtin live in `getBuiltin`. Lowering routes
    // ExprStmt(disp(...)) into `IRStmt.Disp` based on the builtin's
    // `category`.
    if (getBuiltin(name)) return { kind: "builtin", name };
    return null;
  }

  hasBuiltin(name: string): boolean {
    return allBuiltinNames().includes(name);
  }
}
