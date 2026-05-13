/**
 * Re-exports of narrow `Extract<Stmt, ...>` aliases over the parser's
 * AST union.
 *
 * Lives as a leaf module (depends only on `../parser`) so any other
 * module — `types.ts`, `workspace.ts`, the per-construct lowerers —
 * can pull `FunctionStmt` in without going through the
 * `workspace → builtins → types` import cycle.
 */

import type { Stmt } from "../parser/index.js";

/** AST shape of a `function … end` declaration. */
export type FunctionStmt = Extract<Stmt, { type: "Function" }>;
