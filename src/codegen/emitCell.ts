/**
 * Cell-literal Assign emission.
 *
 * `CellLit { cellKind: "tuple" }` renders as a C99 compound literal of
 * the tuple-cell typedef:
 *     (typedef){.slot_0 = e1, .slot_1 = e2, ...}
 * (parallel to the StructLit emit path). The result is consumed via
 * the tuple cell's `_assign` helper so the LHS's prior contents are
 * freed cleanly.
 *
 * `CellLit { cellKind: "homogeneous" }` is more involved — the buffer
 * has runtime length so we can't fit it in a C99 compound literal.
 * The emitter generates:
 *     {
 *       <typedef> _tmp;
 *       _tmp.len = N;
 *       _tmp.data = (<elemCType>*)mtoc_alloc(N * sizeof(<elemCType>));
 *       _tmp.data[0] = <e1-or-copy-of-e1>;
 *       ...
 *       <typedef>_assign(&<lhs>, _tmp);
 *     }
 * Owned elements get the elem-kind `_copy` wrapper when the literal
 * cell is a `Var` read (snapshot semantics); literal/owned-producer
 * cells flow in directly (the ANF pass guarantees they're already
 * Var-bound by the time they reach this consume site).
 */

import type { IRExpr } from "../lowering/ir.js";
import {
  cTypeFor,
  homogeneousCellMangledName,
  isHomogeneousCell,
  isOwned,
  isTupleCell,
  tupleCellMangledName,
  tupleCellSlotFieldName,
  typeToString,
} from "../lowering/types.js";
import { emitExpr } from "./emitExpr.js";
import { ownedOps } from "./ownedKinds.js";
import {
  pushStmt,
  useRuntimeByName,
  useSnippet,
  type EmitState,
} from "./emitState.js";

/** Emit an Assign whose RHS is a `CellLit`. Dispatches on
 *  `cellKind`. Both paths run through the cell's `_assign` helper so
 *  the LHS's prior buffer is released. */
export function emitCellLitAssign(
  state: EmitState,
  level: number,
  lhsCName: string,
  rhs: Extract<IRExpr, { kind: "CellLit" }>
): void {
  if (rhs.cellKind === "tuple") {
    emitTupleCellLitAssign(state, level, lhsCName, rhs);
    return;
  }
  emitHomogeneousCellLitAssign(state, level, lhsCName, rhs);
}

function emitTupleCellLitAssign(
  state: EmitState,
  level: number,
  lhsCName: string,
  rhs: Extract<IRExpr, { kind: "CellLit" }>
): void {
  if (!isTupleCell(rhs.ty)) {
    throw new Error(
      `codegen internal: tuple CellLit with non-tuple ty ${typeToString(rhs.ty)}`
    );
  }
  const name = tupleCellMangledName(rhs.ty);
  const inits: string[] = [];
  for (let i = 0; i < rhs.elements.length; i++) {
    const slotTy = rhs.ty.slots[i];
    const el = rhs.elements[i];
    let valStr = emitExpr(state, el, 0);
    // For owned slot types whose value is a `Var` read, deep-copy so
    // the cell gets an independent buffer (value semantics, mirroring
    // StructLit handling).
    const owned = ownedOps(slotTy);
    if (owned !== null && el.kind === "Var") {
      const copyHelper = owned.copy(el.ty);
      useSnippet(state, copyHelper);
      valStr = `${copyHelper.name}(${el.cName})`;
    }
    inits.push(`.${tupleCellSlotFieldName(i)} = ${valStr}`);
  }
  const initBlock =
    inits.length === 0 ? `(${name}){0}` : `(${name}){${inits.join(", ")}}`;
  pushStmt(state, level, `${name}_assign(&${lhsCName}, ${initBlock});`);
}

function emitHomogeneousCellLitAssign(
  state: EmitState,
  level: number,
  lhsCName: string,
  rhs: Extract<IRExpr, { kind: "CellLit" }>
): void {
  if (!isHomogeneousCell(rhs.ty)) {
    throw new Error(
      `codegen internal: homogeneous CellLit with non-homogeneous ty ` +
        `${typeToString(rhs.ty)}`
    );
  }
  const name = homogeneousCellMangledName(rhs.ty);
  const elemCType = cTypeFor(rhs.ty.elem);
  if (elemCType === null) {
    throw new Error(
      `codegen internal: homogeneous cell elem has no C type ` +
        `(${typeToString(rhs.ty.elem)})`
    );
  }
  const n = rhs.elements.length;
  // Build an inline `{block}` so the temp's name is unique to this
  // assignment without colliding across statements.
  pushStmt(state, level, `{`);
  pushStmt(state, level + 1, `${name} _tmp = {0};`);
  pushStmt(state, level + 1, `_tmp.len = ${n};`);
  if (n > 0) {
    useRuntimeByName(state, "mtoc_alloc");
    pushStmt(
      state,
      level + 1,
      `_tmp.data = (${elemCType} *)mtoc_alloc((size_t)${n} * sizeof(${elemCType}));`
    );
    const elemOwned = ownedOps(rhs.ty.elem);
    for (let i = 0; i < n; i++) {
      const el = rhs.elements[i];
      let valStr = emitExpr(state, el, 0);
      // For owned elems whose RHS is a Var read, deep-copy so the
      // cell owns its slot independently.
      if (elemOwned !== null && isOwned(rhs.ty.elem) && el.kind === "Var") {
        const copyHelper = elemOwned.copy(el.ty);
        useSnippet(state, copyHelper);
        valStr = `${copyHelper.name}(${el.cName})`;
      }
      pushStmt(state, level + 1, `_tmp.data[${i}] = ${valStr};`);
    }
  }
  pushStmt(state, level + 1, `${name}_assign(&${lhsCName}, _tmp);`);
  pushStmt(state, level, `}`);
}

/** Emit a `CellIndexStore` statement: `c{k} = rhs;`. For tuple cells,
 *  the slot field is written directly (owned via per-kind `_assign`);
 *  for homogeneous cells, the buffer slot at `data[idx-1]` is updated
 *  in place (owned slots free the prior content before installing). */
export function emitCellIndexStore(
  state: EmitState,
  level: number,
  s: Extract<import("../lowering/ir.js").IRStmt, { kind: "CellIndexStore" }>
): void {
  const baseTy = s.base.ty;
  const owned = ownedOps(s.slotTy);
  if (isTupleCell(baseTy)) {
    if (s.index.kind !== "NumLit") {
      throw new Error(
        "codegen internal: tuple-cell CellIndexStore with non-NumLit index"
      );
    }
    const slotField = tupleCellSlotFieldName(s.index.value - 1);
    const lhsAccess = `${s.base.cName}.${slotField}`;
    let rhsExpr: string;
    if (owned !== null && s.rhs.kind === "Var") {
      const copyHelper = owned.copy(s.rhs.ty);
      useSnippet(state, copyHelper);
      rhsExpr = `${copyHelper.name}(${s.rhs.cName})`;
    } else {
      rhsExpr = emitExpr(state, s.rhs, 0);
    }
    if (owned !== null) {
      useSnippet(state, owned.assign);
      pushStmt(
        state,
        level,
        `${owned.assign.name}(&${lhsAccess}, ${rhsExpr});`
      );
    } else {
      pushStmt(state, level, `${lhsAccess} = ${rhsExpr};`);
    }
    return;
  }
  if (isHomogeneousCell(baseTy)) {
    // For homogeneous cell, the index is 1-based MATLAB. We auto-grow
    // the buffer to fit the requested slot (numbl's literal-index
    // grow rule, generalized to any index expression — variable
    // indices grow too, which is a slight superset of numbl but
    // strictly more permissive; numbl runtime-aborts when the
    // variable index exceeds the current length).
    const idxExpr = emitExpr(state, s.index, 0);
    const typedef = s.base.cName;
    const cellTypedef = homogeneousCellMangledName(baseTy);
    // Stash the 1-based index into a long to avoid double-evaluating
    // the index expression (it may contain side-effecting reads).
    pushStmt(state, level, `{`);
    pushStmt(state, level + 1, `long _idx = (long)(${idxExpr});`);
    pushStmt(state, level + 1, `${cellTypedef}_grow(&${typedef}, _idx);`);
    const slotAccess = `${typedef}.data[_idx - 1]`;
    let rhsExpr: string;
    if (owned !== null && s.rhs.kind === "Var") {
      const copyHelper = owned.copy(s.rhs.ty);
      useSnippet(state, copyHelper);
      rhsExpr = `${copyHelper.name}(${s.rhs.cName})`;
    } else {
      rhsExpr = emitExpr(state, s.rhs, 0);
    }
    if (owned !== null) {
      useSnippet(state, owned.assign);
      pushStmt(
        state,
        level + 1,
        `${owned.assign.name}(&${slotAccess}, ${rhsExpr});`
      );
    } else {
      pushStmt(state, level + 1, `${slotAccess} = ${rhsExpr};`);
    }
    pushStmt(state, level, `}`);
    return;
  }
  throw new Error(
    `codegen internal: CellIndexStore on non-cell base type ${typeToString(baseTy)}`
  );
}
