/**
 * `while` lowering. After the loop, the env is the merge of "body
 * never ran" (envBefore) and "body ran one+ times" (current env). The
 * single-pass merge isn't iterated to fixpoint — see `mergeBranchEnvs`
 * for the soundness note on oscillating loops.
 */

import type { Stmt } from "../parser/index.js";
import type { IRStmt } from "./ir.js";
import type { Lowerer } from "./lower.js";

export function lowerWhile(
  this: Lowerer,
  s: Extract<Stmt, { type: "While" }>
): IRStmt {
  const envBefore = new Map(this.env);
  const cond = this.lowerExpr(s.cond);
  this.requireScalarReal(cond.ty, "while condition", s.span);
  const body = this.lowerStmts(s.body);
  this.env = this.mergeBranchEnvs(
    [envBefore, new Map(this.env)],
    s.span,
    "while"
  );
  return { kind: "While", cond, body, span: s.span };
}
