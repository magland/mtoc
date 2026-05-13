/**
 * Cross-kind owned-typedef block emitter.
 *
 * Replaces the per-kind sequential calls (`emitStructBlocks` →
 * `emitHandleBlocks` → `emitTupleCellBlocks` → `emitHomogeneousCell-
 * Blocks`) when shapes from different kinds mutually reference each
 * other. A struct field of a homogeneous-cell type requires the cell
 * typedef to precede the struct's body, while a cell-of-struct
 * requires the struct first — only a unified topological sort over
 * all owned kinds handles both directions.
 *
 * For each owned-typedef shape, we ask the per-kind emitter to render
 * its block (typedef + the standard owned-kind helpers + any
 * kind-specific helpers), then splice the blocks in topological
 * order: a shape T's block follows every other shape T transitively
 * holds by value (struct field type, tuple-cell slot type,
 * homogeneous-cell elem type, handle capture type).
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  handleMangledName,
  homogeneousCellMangledName,
  isHandle,
  isHomogeneousCell,
  isStruct,
  isTupleCell,
  structMangledName,
  tupleCellMangledName,
  type HandleType,
  type HomogeneousCellType,
  type MType,
  type StructType,
  type TupleCellType,
} from "../lowering/types.js";
import { collectMTypeShapes } from "../lowering/walk.js";
import { renderStructBlock } from "./emitStruct.js";
import { renderHandleBlock } from "./emitHandle.js";
import { renderTupleCellBlock } from "./emitTupleCell.js";
import { renderHomogeneousCellBlock } from "./emitHomogeneousCell.js";
import { type EmitState } from "./emitState.js";

type AnyOwnedKindShape =
  | { kind: "struct"; ty: StructType }
  | { kind: "handle"; ty: HandleType }
  | { kind: "tupleCell"; ty: TupleCellType }
  | { kind: "homogeneousCell"; ty: HomogeneousCellType };

/** Single source of truth: walk the program and collect every owned-
 *  typedef shape across all four kinds, keyed by its mangled C name. */
function collectAllShapes(prog: IRProgram): Map<string, AnyOwnedKindShape> {
  const out = new Map<string, AnyOwnedKindShape>();
  const structs = collectMTypeShapes(
    prog,
    isStruct,
    structMangledName,
    (t, v) => {
      for (const f of t.fields) v(f.type);
    }
  );
  const handles = collectMTypeShapes(
    prog,
    isHandle,
    handleMangledName,
    (t, v) => {
      for (const c of t.captures) v(c.ty);
    }
  );
  const tcells = collectMTypeShapes(
    prog,
    isTupleCell,
    tupleCellMangledName,
    (t, v) => {
      for (const s of t.slots) v(s);
    }
  );
  const hcells = collectMTypeShapes(
    prog,
    isHomogeneousCell,
    homogeneousCellMangledName,
    (t, v) => v(t.elem)
  );
  for (const [n, t] of structs) out.set(n, { kind: "struct", ty: t });
  for (const [n, t] of handles) out.set(n, { kind: "handle", ty: t });
  for (const [n, t] of tcells) out.set(n, { kind: "tupleCell", ty: t });
  for (const [n, t] of hcells) out.set(n, { kind: "homogeneousCell", ty: t });
  return out;
}

/** Mangled name(s) of every owned typedef this shape holds BY VALUE.
 *  Drives the topological sort: each name must precede the shape's
 *  block in the emitted output. */
function shapeDeps(s: AnyOwnedKindShape): string[] {
  const out: string[] = [];
  const visit = (t: MType): void => {
    if (isStruct(t)) out.push(structMangledName(t));
    else if (isHandle(t)) out.push(handleMangledName(t));
    else if (isTupleCell(t)) out.push(tupleCellMangledName(t));
    else if (isHomogeneousCell(t)) out.push(homogeneousCellMangledName(t));
  };
  switch (s.kind) {
    case "struct":
      for (const f of s.ty.fields) visit(f.type);
      break;
    case "handle":
      for (const c of s.ty.captures) visit(c.ty);
      break;
    case "tupleCell":
      for (const sl of s.ty.slots) visit(sl);
      break;
    case "homogeneousCell":
      visit(s.ty.elem);
      break;
  }
  return out;
}

/** Topological sort of every owned-typedef shape. Each shape's block
 *  appears after every shape it holds by value. Cycle detection
 *  defensively throws — v1 has no recursive owned types. */
function topoSort(
  shapes: ReadonlyMap<string, AnyOwnedKindShape>
): AnyOwnedKindShape[] {
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const order: AnyOwnedKindShape[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (inProgress.has(name)) {
      throw new Error(
        `codegen internal: owned-typedef cycle through '${name}' — mtoc ` +
          `does not yet support recursive owned types`
      );
    }
    const shape = shapes.get(name);
    if (shape === undefined) return;
    inProgress.add(name);
    for (const d of shapeDeps(shape)) visit(d);
    inProgress.delete(name);
    visited.add(name);
    order.push(shape);
  };
  for (const name of shapes.keys()) visit(name);
  return order;
}

/** Render one shape's block via the appropriate per-kind helper. */
function renderShape(state: EmitState, s: AnyOwnedKindShape): string[] {
  switch (s.kind) {
    case "struct":
      return renderStructBlock(state, s.ty);
    case "handle":
      return renderHandleBlock(state, s.ty);
    case "tupleCell":
      return renderTupleCellBlock(state, s.ty);
    case "homogeneousCell":
      return renderHomogeneousCellBlock(state, s.ty);
  }
}

/** Emit every owned-typedef block (struct + handle + tuple-cell +
 *  homogeneous-cell), in cross-kind topological order. The handle
 *  emitter still drives its own `_mtoc_handle_empty_t` placeholder
 *  prologue; we splice that in first when any no-capture handle is
 *  present. */
export function emitOwnedTypedefBlocks(
  state: EmitState,
  prog: IRProgram
): string[] {
  const shapes = collectAllShapes(prog);
  if (shapes.size === 0) return [];
  const out: string[] = [];

  // Shared no-capture handle placeholder typedef + helpers. Same
  // single-shared-typedef rule as before: every no-capture handle
  // collapses to `_mtoc_handle_empty_t`, and it has no cross-kind
  // dependencies, so it's safe to emit ahead of everything else.
  const EMPTY_HANDLE = "_mtoc_handle_empty_t";
  const empty = shapes.get(EMPTY_HANDLE);
  if (empty !== undefined && empty.kind === "handle") {
    out.push(...renderShape(state, empty), "");
    shapes.delete(EMPTY_HANDLE);
  }

  for (const shape of topoSort(shapes)) {
    out.push(...renderShape(state, shape), "");
  }
  return out;
}
