/**
 * `if`/`elseif`/`else` lowering. Each arm runs in a fresh env-snapshot
 * so they can introduce shape/sign refinements independently; after
 * all arms run, the per-arm env's are merged back via `mergeBranchEnvs`.
 *
 * Stage-C constant-folding extension: when an arm's condition lowers
 * to a literal IR node with a known truth value, only the chosen arm
 * is lowered and emitted (the dead arms are dropped entirely). The
 * function then returns `IRStmt[]` so the parent stmt-list can splice
 * the live arm's statements inline. The non-folded path still returns
 * a single `IRStmt.If` with every arm lowered and the per-arm envs
 * merged via the normal `mergeBranchEnvs`.
 */

import type { Stmt } from "../parser/index.js";
import type { IRExpr, IRStmt } from "./ir.js";
import type { MType } from "./types.js";
import { tryFoldCondToBool } from "./constFold.js";
import type { Lowerer } from "./lower.js";

export function lowerIf(
  this: Lowerer,
  s: Extract<Stmt, { type: "If" }>
): IRStmt | IRStmt[] {
  return this.withControlDepth(() => {
    const cond = this.lowerExpr(s.cond);
    // Numbl treats a scalar complex `z` as `creal(z) != 0 || cimag(z) != 0`
    // in a boolean position (same toBool rule as `~z` and `&&`/`||`).
    // The codegen's `If` emitter renders this expansion via the same
    // path that handles complex `~z` and complex comparisons.
    this.requireScalarCond(cond.ty, "if condition", s.span);

    const envBefore = new Map(this.env);

    // Statically-known top-level condition: pick the chosen arm at
    // lowering time and drop the dead arms. Falsy top → walk the
    // elseif chain, taking the first whose cond folds truthy.
    const topBool = tryFoldCondToBool(cond);
    if (topBool === true) {
      this.env = new Map(envBefore);
      return this.lowerStmts(s.thenBody);
    }
    if (topBool === false) {
      // The then-arm is dead. Try each elseif in order.
      for (let i = 0; i < s.elseifBlocks.length; i++) {
        const b = s.elseifBlocks[i];
        this.env = new Map(envBefore);
        const ec = this.lowerExpr(b.cond);
        this.requireScalarCond(ec.ty, "elseif condition", b.cond.span);
        const eb = tryFoldCondToBool(ec);
        if (eb === true) {
          // Live elseif arm: lower it and emit only its body.
          this.env = new Map(envBefore);
          return this.lowerStmts(b.body);
        }
        if (eb === false) {
          // Dead — continue searching. Note we already lowered the
          // cond for env-side-effect parity, but since the arm
          // doesn't run we discard its body lowering.
          continue;
        }
        // Unknown elseif cond: we can't statically pick an arm. Fall
        // back to the full all-arms lowering below, but we've already
        // started reading the elseifs — bail to the slow path by
        // resetting env and re-running every arm.
        return lowerIfAllArms.call(this, s, cond, envBefore);
      }
      // Every elseif was statically false. Fall through to else.
      if (s.elseBody !== null) {
        this.env = new Map(envBefore);
        return this.lowerStmts(s.elseBody);
      }
      // No arm matched — the if is a no-op. Env stays at envBefore.
      this.env = envBefore;
      return [];
    }

    // Cond didn't fold; run the regular all-arms path.
    return lowerIfAllArms.call(this, s, cond, envBefore);
  });
}

/** Full-arm lowering: every arm runs, every per-arm env merges via
 *  `mergeBranchEnvs`. Used when the if-stmt's top-level cond can't
 *  be statically resolved (or when a downstream elseif cond turns
 *  out to be unknown after the then-arm was statically eliminated). */
function lowerIfAllArms(
  this: Lowerer,
  s: Extract<Stmt, { type: "If" }>,
  cond: IRExpr,
  envBefore: Map<string, MType>
): IRStmt {
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
    this.requireScalarCond(ec.ty, "elseif condition", b.cond.span);
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
