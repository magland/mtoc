/**
 * `for k = start:step:end` lowering. Range form only. Step must be a
 * literal so codegen can emit the iteration-count formula at compile
 * time. The loop variable's sign is refined when start + step have a
 * consistent direction (`for k = 1:n` ⇒ `k` positive, etc.).
 */

import type { Stmt } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import type { IRExpr, IRStmt } from "./ir.js";
import {
  isNumeric,
  scalarDouble,
  signIsNonneg,
  signIsPositive,
  SCALAR_DOUBLE,
} from "./types.js";
import { cNameFor } from "./lower.js";
import type { Lowerer } from "./lower.js";

export function lowerFor(
  this: Lowerer,
  s: Extract<Stmt, { type: "For" }>
): IRStmt {
  if (s.expr.type !== "Range") {
    throw new UnsupportedConstruct(
      `for-loop iterables other than ranges are not yet supported`,
      s.span
    );
  }
  const start = this.lowerExpr(s.expr.start);
  const end = this.lowerExpr(s.expr.end);
  this.requireScalarReal(start.ty, "for-loop start", s.expr.start.span);
  this.requireScalarReal(end.ty, "for-loop end", s.expr.end.span);
  let step: IRExpr;
  if (s.expr.step) {
    step = this.lowerExpr(s.expr.step);
    this.requireScalarReal(step.ty, "for-loop step", s.expr.step.span);
    if (step.kind !== "NumLit") {
      throw new UnsupportedConstruct(
        `for-loop step must be a numeric literal (got expression)`,
        s.expr.step.span
      );
    }
    if (step.value === 0) {
      throw new UnsupportedConstruct(
        `for-loop step must be non-zero`,
        s.expr.step.span
      );
    }
  } else {
    step = {
      kind: "NumLit",
      value: 1,
      ty: SCALAR_DOUBLE,
      span: s.expr.span,
    };
  }
  // Refine the loop variable's sign when start + step have the same
  // direction. `for k = 1:n` ⇒ k positive; `for k = 0:n` ⇒ k nonneg;
  // symmetric for negative-stride loops. Anything that could cross
  // zero falls back to unknown.
  const startSign = isNumeric(start.ty) ? start.ty.sign : "unknown";
  let loopVarSign:
    | "positive"
    | "nonnegative"
    | "negative"
    | "nonpositive"
    | "unknown" = "unknown";
  if (step.value > 0) {
    if (signIsPositive(startSign)) loopVarSign = "positive";
    else if (signIsNonneg(startSign)) loopVarSign = "nonnegative";
  } else if (step.value < 0) {
    if (startSign === "negative") loopVarSign = "negative";
    else if (startSign === "nonpositive" || startSign === "zero") {
      loopVarSign = "nonpositive";
    }
  }
  // Snapshot before introducing the loop variable; after the loop, the
  // merge widens the loop var's type with `zero` so the post-loop sign
  // reflects "loop may not have run".
  const envBefore = new Map(this.env);
  this.recordAssignment(s.varName, scalarDouble(loopVarSign), s.span);
  const body = this.lowerStmts(s.body);
  this.env = this.mergeBranchEnvs(
    [envBefore, new Map(this.env)],
    s.span,
    "for"
  );
  return {
    kind: "For",
    var: s.varName,
    cVar: cNameFor(s.varName),
    start,
    step,
    end,
    body,
    span: s.span,
  };
}
