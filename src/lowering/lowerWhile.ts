/**
 * `while` lowering. After the loop, the env is the merge of "body
 * never ran" (envBefore) and "body ran one+ times" (current env). The
 * single-pass merge isn't iterated to fixpoint — see `mergeBranchEnvs`
 * for the soundness note on oscillating loops.
 */

import type { Stmt } from "../parser/index.js";
import type { IRStmt } from "./ir.js";
import { collectAssignedNames } from "./loopExactStrip.js";
import { stripExactFromEnv } from "./types.js";
import type { Lowerer } from "./lower.js";

export function lowerWhile(
  this: Lowerer,
  s: Extract<Stmt, { type: "While" }>
): IRStmt {
  return this.withControlDepth(() => {
    const envBefore = new Map(this.env);
    const cond = this.lowerExpr(s.cond);
    // Complex conds follow the same toBool rule as `if` — see lowerIf.
    this.requireScalarCond(cond.ty, "while condition", s.span);
    // Any variable reassigned inside the body has its `exact` cleared
    // in env before the body lowers; otherwise the single-pass body
    // lowering would fold each subsequent use against the entry-state
    // exact, baking iteration-1 values into the emitted body. (See
    // `loopExactStrip.ts`.)
    stripExactFromEnv(this.env, collectAssignedNames(s.body));
    const body = this.lowerStmts(s.body);
    this.env = this.mergeBranchEnvs(
      [envBefore, new Map(this.env)],
      s.span,
      "while"
    );
    return { kind: "While", cond, body, span: s.span };
  });
}
