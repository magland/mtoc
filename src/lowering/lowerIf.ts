/**
 * `if`/`elseif`/`else` lowering. Each arm runs in a fresh env-snapshot
 * so they can introduce shape/sign refinements independently; after
 * all arms run, the per-arm env's are merged back via `mergeBranchEnvs`.
 */

import type { Stmt } from "../parser/index.js";
import type { IRExpr, IRStmt } from "./ir.js";
import type { MType } from "./types.js";
import type { Lowerer } from "./lower.js";

export function lowerIf(
  this: Lowerer,
  s: Extract<Stmt, { type: "If" }>
): IRStmt {
  const cond = this.lowerExpr(s.cond);
  this.requireScalarReal(cond.ty, "if condition", s.span);

  const envBefore = new Map(this.env);

  // Then-arm: starts fresh from envBefore.
  this.env = new Map(envBefore);
  const thenBody = this.lowerStmts(s.thenBody);
  const envThen = new Map(this.env);

  // Each elseif arm: starts fresh from envBefore. The condition is
  // lowered inside the arm so any (future) refinement gets the
  // correct visibility scope.
  const elseifs: Array<{ cond: IRExpr; body: IRStmt[] }> = [];
  const envElseifs: Map<string, MType>[] = [];
  for (const b of s.elseifBlocks) {
    this.env = new Map(envBefore);
    const ec = this.lowerExpr(b.cond);
    this.requireScalarReal(ec.ty, "elseif condition", b.cond.span);
    const body = this.lowerStmts(b.body);
    elseifs.push({ cond: ec, body });
    envElseifs.push(new Map(this.env));
  }

  // Else-arm: starts from envBefore. Without an explicit `else`, the
  // "no arm ran" path's env is just envBefore.
  let elseBody: IRStmt[] | null = null;
  let envElse: Map<string, MType>;
  if (s.elseBody) {
    this.env = new Map(envBefore);
    elseBody = this.lowerStmts(s.elseBody);
    envElse = new Map(this.env);
  } else {
    envElse = envBefore;
  }

  this.env = this.mergeBranchEnvs(
    [envThen, ...envElseifs, envElse],
    s.span,
    "if"
  );

  return {
    kind: "If",
    cond,
    thenBody,
    elseifs,
    elseBody,
    span: s.span,
  };
}
