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
  isCharScalar,
  isHandle,
  isMultiElement,
  isScalarComplex,
  isScalarReal,
  isStruct,
  typeToString,
} from "../lowering/types.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";

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
    // Function handles are phantom in v1 — no C representation, no
    // predeclaration, no runtime value. The handle's identity lives
    // on the MType only; every call site resolves statically.
    if (isHandle(ty)) continue;
    // Owned kinds (string, char-array, multi-element double tensor)
    // share one shape: predeclare a known-empty handle whose later
    // re-assignments go through the kind's `assign` helper. The empty
    // handle has `owned=0` (or NULL buffers), so a scope-exit free of
    // an uninitialized var is a safe no-op.
    const owned = ownedOps(ty);
    if (owned !== null) {
      useRuntimeByName(state, owned.structSnippet);
      useRuntimeByName(state, owned.empty);
      pushStmt(state, level, `${owned.cType} ${cName} = ${owned.empty}();`);
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
    useRuntimeByName(state, owned.free);
    pushStmt(state, level, `${owned.free}(&${cName});`);
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
    if (isMultiElement(p.ty) || isStruct(p.ty)) {
      out.set(p.cName, { ty: p.ty, cName: p.cName });
    }
  }
  return out;
}
