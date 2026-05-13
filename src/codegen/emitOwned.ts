/**
 * Owned-value bookkeeping at the codegen layer.
 *
 * Three companion routines that all walk a {cName → VarBinding}
 * table:
 *   - `emitDeclarations` — top-of-scope predeclarations.
 *   - `emitScopeExitFrees` — per-scope-exit free walk (end of main,
 *     end of each function body, every IRStmt.ReturnFromFunction).
 *   - `functionFreeOnExitSet` — assembled per-function "free on exit"
 *     map (assignedVars plus owned tensor parameters under
 *     copy-on-arg-pass).
 *
 * The owned-kind dispatch is registry-driven via
 * `ownedKinds.ownedOps`, so adding a new owned MType is one entry in
 * that table; these routines pick it up automatically.
 */

import type { IRFunction, VarBinding } from "../lowering/ir.js";
import {
  isCell,
  isCharScalar,
  isHandle,
  isMultiElement,
  isScalarComplex,
  isScalarReal,
  isStruct,
  type MType,
  typeToString,
} from "../lowering/types.js";
// `isHandle` is used by `functionFreeOnExitSet`.
import { ownedOps, type OwnedKindOps } from "./ownedKinds.js";
import { pushStmt, useSnippet, type EmitState } from "./emitState.js";

/** Emit `<typedef>_assign(&<lhs>, <rhsExpr>);` for an owned target.
 *  Activates the kind's typedef + `_assign` helper as a side effect.
 *  Used by every owned-LHS write site: scalar Assign to an owned name,
 *  MemberStore to an owned field, ReturnFromFunction's sret writes,
 *  multi-output-call owned-output writes.
 *
 *  Callers can pass either `&<cName>` (local stack handle) or the
 *  bare sret pointer expression (`_mtoc_o<i>`) as `lhsRef`. The helper
 *  is symmetric on the LHS shape — it just splices the string in. */
export function emitOwnedAssign(
  state: EmitState,
  level: number,
  owned: OwnedKindOps,
  lhsRef: string,
  rhsExpr: string
): void {
  useSnippet(state, owned.structSnippet);
  useSnippet(state, owned.assign);
  pushStmt(state, level, `${owned.assign.name}(${lhsRef}, ${rhsExpr});`);
}

/** Emit `<cType> <cName> = <typedef>_empty();` for an owned-discard
 *  temporary. Activates the kind's typedef + `_empty` helper. Used at
 *  multi-output-call sites where an ignored output slot needs a freeable
 *  starting value the callee's `_assign` can consume. */
export function emitOwnedEmptyDecl(
  state: EmitState,
  level: number,
  owned: OwnedKindOps,
  cName: string
): void {
  useSnippet(state, owned.structSnippet);
  useSnippet(state, owned.empty);
  pushStmt(state, level, `${owned.cType} ${cName} = ${owned.empty.name}();`);
}

/** Convenience: write each multi-output sret slot from the corresponding
 *  output's post-body live cName. Owned slots route through
 *  `emitOwnedAssign(... &_mtoc_oN, cName)` so the caller's prior buffer
 *  at the lvalue is freed before the new handle lands; scalar slots
 *  use a plain pointer store. */
export function emitOwnedAwareSretWrites(
  state: EmitState,
  level: number,
  outputs: ReadonlyArray<{ ty: MType; cName: string }>
): void {
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    const owned = ownedOps(o.ty);
    if (owned !== null) {
      emitOwnedAssign(state, level, owned, `_mtoc_o${i}`, o.cName);
    } else {
      pushStmt(state, level, `*_mtoc_o${i} = ${o.cName};`);
    }
  }
}

/** Emit predeclarations for a {cName → VarBinding} table. Scalars
 *  become `double <cName> = 0.0;` (real) or `double _Complex <cName> = 0.0;`
 *  (complex). Multi-element tensors are predeclared empty
 *  (`mtoc_tensor_t <cName> = mtoc_tensor_empty();`); the assignment
 *  site overwrites them via `mtoc_tensor_assign`, which frees the
 *  empty buffers (a no-op on NULL) and installs the new ones.
 *  Activates the `mtoc_tensor_t` typedef + `mtoc_tensor_empty` helper
 *  whenever any tensor is declared. Cleanup is paired in
 *  `emitScopeExitFrees`, invoked at every `return` site. */
export function emitDeclarations(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>
): void {
  // Iteration order: by C identifier so the generated declaration order
  // is stable across runs.
  const cNames = [...vars.keys()].sort();
  for (const key of cNames) {
    const binding = vars.get(key)!;
    const { ty, cName } = binding;
    // Owned kinds (string, char-array, multi-element double tensor,
    // struct, function handle with or without captures)
    // share one shape: predeclare a known-empty handle whose later
    // re-assignments go through the kind's `assign` helper. The empty
    // handle has `owned=0` (or NULL buffers), so a scope-exit free of
    // an uninitialized var is a safe no-op.
    const owned = ownedOps(ty);
    if (owned !== null) {
      emitOwnedEmptyDecl(state, level, owned, cName);
      continue;
    }
    if (isCharScalar(ty)) {
      // Scalar char: bare C `char`, zero-initialized to NUL.
      pushStmt(state, level, `char ${cName} = '\\0';`);
      continue;
    }
    if (isScalarReal(ty)) {
      pushStmt(state, level, `double ${cName} = 0.0;`);
      continue;
    }
    if (isScalarComplex(ty)) {
      pushStmt(state, level, `double _Complex ${cName} = 0.0;`);
      continue;
    }
    throw new Error(
      `codegen internal: unsupported declaration for '${cName}': ` +
        `${typeToString(ty)}; should have been caught at lowering`
    );
  }
}

/** Emit `<owned>_free(&<v>);` for every owned binding in `vars` that
 *  has NOT already been freed earlier on the current linear path
 *  (`alreadyFreed`). Iteration order matches `emitDeclarations`
 *  (sorted by C identifier) so generated C stays deterministic.
 *  Called at every scope-exit site — end of `main`, end of each
 *  function body, and every `IRStmt.ReturnFromFunction`. The owned-
 *  kind registry picks the right helper (`mtoc_tensor_free` /
 *  `mtoc_string_free` / `mtoc_char_tensor_free`); each is shape-
 *  agnostic and idempotent on a zeroed handle. Vars added here are
 *  also recorded in `alreadyFreed` so callers chaining further
 *  emissions (e.g. multiple `ReturnFromFunction` paths) don't
 *  re-emit. */
export function emitScopeExitFrees(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>,
  alreadyFreed: Set<string>
): void {
  const cNames = [...vars.keys()].sort();
  for (const key of cNames) {
    const binding = vars.get(key)!;
    const { ty, cName } = binding;
    const owned = ownedOps(ty);
    if (owned === null) continue;
    if (alreadyFreed.has(cName)) continue;
    useSnippet(state, owned.free);
    pushStmt(state, level, `${owned.free.name}(&${cName});`);
    alreadyFreed.add(cName);
  }
}

/** Build the per-function "free at scope exit" set: every entry in
 *  `assignedVars` plus every multi-element tensor parameter. Tensor
 *  params are owned by the callee under copy-on-arg-pass — the caller
 *  wraps each argument in `mtoc_tensor_copy(...)`, so the param's
 *  buffer is the callee's responsibility to release. Scalar params
 *  stay out of the set: they have no heap buffer. */
export function functionFreeOnExitSet(
  fn: IRFunction
): ReadonlyMap<string, VarBinding> {
  const out = new Map<string, VarBinding>(fn.assignedVars);
  for (const p of fn.params) {
    if (
      isMultiElement(p.ty) ||
      isStruct(p.ty) ||
      isHandle(p.ty) ||
      isCell(p.ty)
    ) {
      out.set(p.cName, { ty: p.ty, cName: p.cName });
    }
  }
  return out;
}
