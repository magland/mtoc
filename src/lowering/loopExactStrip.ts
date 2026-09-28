/**
 * Helper for loop body lowering: strip `exact` from any env entry
 * whose variable is reassigned inside the loop body.
 *
 * Why: mtoc lowers a loop body ONCE with the entry-state env. With
 * Stage-D propagation, a variable that carried `exact` at loop entry
 * would have that value baked into every fold inside the body — so
 * `k = 0; while ...; k = k + 1; end` lowers to a body that always sets
 * `k = 1.0;` (folding `k + 1` with k.exact=0). The post-loop merge
 * widens k's type correctly, but the EMITTED body is already wrong.
 *
 * Fix: pre-scan the body for any LHS name. For every matching env
 * entry, drop `exact` BEFORE the body lowers. The variable's other
 * type fields (sign, dims) stay so static dispatch still works.
 *
 * For `if`/`elseif`/`else` we do NOT strip — the body runs zero or
 * one times, and the post-merge unify already handles exact-disagree-
 * ment between arms. The issue is unique to loops, where the body's
 * effect persists across iterations.
 */

import type { Stmt, LValue } from "../parser/index.js";

/** Collect every variable name assigned (anywhere in `stmts`'
 *  reachable AST). Recurses through control-flow constructs so a
 *  variable mutated inside a nested `if` / `for` still appears. */
export function collectAssignedNames(stmts: ReadonlyArray<Stmt>): Set<string> {
  const out = new Set<string>();
  for (const s of stmts) walkStmt(s, out);
  return out;
}

function walkStmt(s: Stmt, out: Set<string>): void {
  switch (s.type) {
    case "Assign":
      out.add(s.name);
      return;
    case "MultiAssign":
      for (const lv of s.lvalues) addLValueRoot(lv, out);
      return;
    case "AssignLValue":
      addLValueRoot(s.lvalue, out);
      return;
    case "If":
      for (const t of s.thenBody) walkStmt(t, out);
      for (const eif of s.elseifBlocks) {
        for (const t of eif.body) walkStmt(t, out);
      }
      if (s.elseBody !== null) {
        for (const t of s.elseBody) walkStmt(t, out);
      }
      return;
    case "While":
      for (const t of s.body) walkStmt(t, out);
      return;
    case "For":
      // The for-loop's own iteration variable is also reassigned every
      // iteration; include it so an outer loop strips exact off it too.
      out.add(s.varName);
      for (const t of s.body) walkStmt(t, out);
      return;
    case "Switch":
      for (const c of s.cases) for (const t of c.body) walkStmt(t, out);
      if (s.otherwise !== null) {
        for (const t of s.otherwise) walkStmt(t, out);
      }
      return;
    case "TryCatch":
      for (const t of s.tryBody) walkStmt(t, out);
      if (s.catchVar !== null) out.add(s.catchVar);
      for (const t of s.catchBody) walkStmt(t, out);
      return;
    default:
      // ExprStmt / Function / Break / Continue / Return / Global /
      // Persistent / Import / ClassDef / Directive / Synth — no LHS.
      return;
  }
}

function addLValueRoot(lv: LValue, out: Set<string>): void {
  switch (lv.type) {
    case "Var":
      out.add(lv.name);
      return;
    case "Ignore":
      return;
    case "Index":
    case "IndexCell":
    case "Member":
    case "MemberDynamic": {
      // The root of the chain is what's mutated (e.g. `s.f = ...` writes
      // through `s`). Walk down to the underlying Ident.
      let base: typeof lv.base = lv.base;
      while (true) {
        if (base.type === "Ident") {
          out.add(base.name);
          return;
        }
        if (
          base.type === "Member" ||
          base.type === "MemberDynamic" ||
          base.type === "Index" ||
          base.type === "IndexCell"
        ) {
          base = base.base;
          continue;
        }
        // Non-Ident base (function-call lvalue, etc.) — nothing to add.
        return;
      }
    }
  }
}
