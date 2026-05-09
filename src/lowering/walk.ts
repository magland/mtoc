/**
 * Generic walkers over the typed IR.
 *
 * Every analysis or validation pass that needs "for each subexpression"
 * or "for each top-level expression in this stmt" used to roll its own
 * exhaustive switch over IRExpr.kind / IRStmt.kind. With ~5 such walks
 * scattered across lowering and codegen, adding a new IR variant
 * (`IndexLoad`, `Range`, `Slice`, …) meant editing every walker.
 *
 * The helpers here centralize the recursion. Callers express their
 * pass as a per-node visitor; adding a new IR variant means updating
 * one switch (this file) plus any visitors that genuinely need to
 * inspect the new kind.
 */

import type { IRExpr, IRStmt } from "./ir.js";

/**
 * Visit every sub-expression of `e` in pre-order, including `e`
 * itself. Returning `false` from the visitor short-circuits the
 * descent into that node's children — useful when the visitor has
 * already accounted for them, or when an early-exit is enough.
 *
 * For literals (`NumLit`, `ImagLit`, `StringLit`, `CharLit`) and
 * `Var`, there are no children to descend into. For `Binary`, the
 * left operand is visited before the right; for `Call`, args are
 * visited in declaration order; for `TensorLit`, cells are visited
 * in row-then-column order matching the source layout. The order is
 * stable across calls — passes that depend on visit order (e.g.
 * "first multi-element Var") can rely on it.
 */
export function forEachSubExpr(
  e: IRExpr,
  visit: (e: IRExpr) => boolean | void
): void {
  if (visit(e) === false) return;
  switch (e.kind) {
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "Var":
      return;
    case "Binary":
      forEachSubExpr(e.left, visit);
      forEachSubExpr(e.right, visit);
      return;
    case "Unary":
      forEachSubExpr(e.operand, visit);
      return;
    case "Call":
      for (const a of e.args) forEachSubExpr(a, visit);
      return;
    case "TensorLit":
      for (const row of e.elements)
        for (const cell of row) forEachSubExpr(cell, visit);
      return;
  }
}

/**
 * Pre-order DFS for the first sub-expression matching `pred`. Returns
 * `null` if nothing matches. Visit order matches `forEachSubExpr` so
 * passes that need a deterministic "first match" (e.g. shape-source
 * picks the leftmost multi-element Var) get a stable result.
 */
export function findInExpr<T extends IRExpr>(
  e: IRExpr,
  pred: (e: IRExpr) => e is T
): T | null;
export function findInExpr(
  e: IRExpr,
  pred: (e: IRExpr) => boolean
): IRExpr | null;
export function findInExpr(
  e: IRExpr,
  pred: (e: IRExpr) => boolean
): IRExpr | null {
  let found: IRExpr | null = null;
  forEachSubExpr(e, sub => {
    if (found !== null) return false;
    if (pred(sub)) {
      found = sub;
      return false;
    }
  });
  return found;
}

/**
 * Apply `fn` to every IRExpr held DIRECTLY by `s` — the cond of an
 * `If` / `While`, the start/step/end of a `For`, the rhs of `Assign`,
 * the args of a `Call`-bearing stmt, etc. Does NOT descend into child
 * stmts (if/while/for bodies); use `forEachStmtInTree` for that.
 *
 * The "top-level expressions" view matches the granularity the
 * dataflow / liveness passes care about: a statement's own expression
 * inputs, before any control transfer.
 */
export function forEachTopLevelExpr(s: IRStmt, fn: (e: IRExpr) => void): void {
  switch (s.kind) {
    case "Assign":
      fn(s.rhs);
      return;
    case "ExprStmt":
      fn(s.expr);
      return;
    case "Disp":
    case "Error":
      fn(s.arg);
      return;
    case "If":
      fn(s.cond);
      for (const eif of s.elseifs) fn(eif.cond);
      return;
    case "While":
      fn(s.cond);
      return;
    case "For":
      fn(s.start);
      fn(s.step);
      fn(s.end);
      return;
    case "MultiAssignCall":
      for (const a of s.args) fn(a);
      return;
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return;
  }
}

/**
 * Apply `fn` to every IRStmt in the tree rooted at `stmts`, including
 * the leaves and the control-flow heads. Pre-order: a parent stmt
 * (`If` / `While` / `For`) is visited before its body. Useful for
 * analyses that want to see every stmt regardless of nesting.
 */
export function forEachStmtInTree(
  stmts: ReadonlyArray<IRStmt>,
  fn: (s: IRStmt) => void
): void {
  for (const s of stmts) {
    fn(s);
    switch (s.kind) {
      case "If":
        forEachStmtInTree(s.thenBody, fn);
        for (const eif of s.elseifs) forEachStmtInTree(eif.body, fn);
        if (s.elseBody) forEachStmtInTree(s.elseBody, fn);
        break;
      case "While":
      case "For":
        forEachStmtInTree(s.body, fn);
        break;
      case "Assign":
      case "ExprStmt":
      case "Disp":
      case "Error":
      case "MultiAssignCall":
      case "Break":
      case "Continue":
      case "ReturnFromFunction":
        break;
    }
  }
}
