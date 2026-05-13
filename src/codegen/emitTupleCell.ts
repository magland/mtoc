/**
 * Per-tuple-cell-shape codegen: typedefs + the five generated helpers
 * (`<typedef>_empty`, `_free`, `_copy`, `_assign`, `_disp`).
 *
 * A `TupleCellType { slots: [t1, …, tN] }` produces a C struct with
 * one field per slot, named `slot_0 … slot_(N-1)`. The layout mirrors
 * `emitStruct.ts` — including the shared four-helper scaffolding
 * delivered by `emitNamedTypedef.ts` — and only the `_disp` body and
 * the positional field naming differ.
 *
 * Disp output matches numbl's `formatCell` byte-for-byte: a single
 * line `{e1, e2, …, eN}` followed by a trailing newline (added by
 * `disp` after the inline formatter returns). Char slots render as
 * `'<c>'` / `'<chars>'`, string slots as `"<chars>"`, and every
 * other slot type goes through its own per-kind formatter.
 *
 * Nested cells inside cells, struct slots, and tensor slots in disp
 * are currently rejected at this emitter — they need a multi-line
 * coordination story numbl handles via `displayValue` recursion that
 * mtoc doesn't yet model. Cell variables holding those shapes still
 * work end-to-end; only `disp(c)` is the gated case (use
 * `disp(c{i})` for those slots).
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  isCharArray,
  isCharScalar,
  isHomogeneousCell,
  isScalarComplex,
  isScalarReal,
  isString,
  isTupleCell,
  tupleCellMangledName,
  tupleCellSlotFieldName,
  type MType,
  type TupleCellType,
} from "../lowering/types.js";
import { useRuntimeByName, type EmitState } from "./emitState.js";
import {
  emitNamedTypedefBlocks,
  renderNamedTypedefBlock,
  type NamedTypedefSpec,
} from "./emitNamedTypedef.js";

/** Topological sort: a cell whose slot references another cell /
 *  struct typedef must follow that typedef. v1 has no recursive
 *  cell types, so a simple DFS suffices. */
function topoSort(table: ReadonlyMap<string, TupleCellType>): TupleCellType[] {
  const visited = new Set<string>();
  const order: TupleCellType[] = [];
  const visit = (t: TupleCellType): void => {
    const name = tupleCellMangledName(t);
    if (visited.has(name)) return;
    visited.add(name);
    for (const s of t.slots) {
      if (isTupleCell(s)) visit(s);
    }
    order.push(t);
  };
  for (const t of table.values()) visit(t);
  return order;
}

/** Render the `_disp` body for one tuple-cell shape. Matches numbl's
 *  `formatCell` byte-for-byte: prints `{e1, e2, ..., eN}\n`. */
function renderTupleCellDispBody(state: EmitState, t: TupleCellType): string[] {
  const lines: string[] = [];
  lines.push(`  putchar('{');`);
  for (let i = 0; i < t.slots.length; i++) {
    if (i > 0) lines.push(`  fputs(", ", stdout);`);
    const slot = t.slots[i];
    const field = `s.${tupleCellSlotFieldName(i)}`;
    emitInlineSlotDisp(state, lines, slot, field, i, "tuple");
  }
  lines.push(`  fputs("}\\n", stdout);`);
  return lines;
}

/** Emit per-slot inline disp lines (no trailing newline) into `out`.
 *  Shared between tuple and homogeneous cell disp body renderers. */
export function emitInlineSlotDisp(
  state: EmitState,
  out: string[],
  slotTy: MType,
  cExpr: string,
  slotIndex: number,
  category: "tuple" | "homogeneous"
): void {
  if (isScalarReal(slotTy)) {
    useRuntimeByName(state, "mtoc_format_double");
    out.push(`  {`);
    out.push(`    char _buf[64];`);
    out.push(`    mtoc_format_double(_buf, sizeof(_buf), ${cExpr});`);
    out.push(`    fputs(_buf, stdout);`);
    out.push(`  }`);
    return;
  }
  if (isScalarComplex(slotTy)) {
    useRuntimeByName(state, "mtoc_format_complex");
    out.push(`  {`);
    out.push(`    char _buf[160];`);
    out.push(`    mtoc_format_complex(_buf, sizeof(_buf), ${cExpr});`);
    out.push(`    fputs(_buf, stdout);`);
    out.push(`  }`);
    return;
  }
  if (isCharScalar(slotTy)) {
    out.push(`  printf("'%c'", ${cExpr});`);
    return;
  }
  if (isCharArray(slotTy)) {
    // mtoc_char_tensor_t carries `data` and rows/cols; for a 1×N char
    // array (the only shape that lands here), cols is the length.
    out.push(`  putchar('\\'');`);
    out.push(`  fwrite(${cExpr}.data, 1, (size_t)${cExpr}.cols, stdout);`);
    out.push(`  putchar('\\'');`);
    return;
  }
  if (isString(slotTy)) {
    out.push(`  putchar('"');`);
    out.push(`  fwrite(${cExpr}.data, 1, (size_t)${cExpr}.len, stdout);`);
    out.push(`  putchar('"');`);
    return;
  }
  // Nested cells, structs, tensors, handles, etc. — produce a
  // placeholder `<unsupported>` token. Lowering rejects `disp(c)` on
  // such cells via `cellDispSupported`, so this body is unreachable
  // at runtime; it exists so codegen produces a well-formed (if
  // never-called) `_disp` helper for every cell typedef.
  void slotIndex;
  void category;
  void cExpr;
  out.push(`  fputs("<unsupported>", stdout);`);
}

/** True iff every slot of `ty` is a kind `emitInlineSlotDisp` knows
 *  how to format. Lowering consults this to reject `disp(c)` on
 *  cells whose slots / elem are tensors, structs, handles, or other
 *  cells — formats numbl renders multi-line that mtoc's inline path
 *  doesn't yet model. */
export function cellDispSupported(ty: MType): boolean {
  if (isTupleCell(ty)) {
    return ty.slots.every(isDispableSlot);
  }
  if (isHomogeneousCell(ty)) {
    return isDispableSlot(ty.elem);
  }
  return false;
}

function isDispableSlot(t: MType): boolean {
  if (isScalarReal(t)) return true;
  if (isScalarComplex(t)) return true;
  if (isCharScalar(t)) return true;
  if (isCharArray(t)) return true;
  if (isString(t)) return true;
  return false;
}

const TUPLE_CELL_SPEC: NamedTypedefSpec<TupleCellType> = {
  isKind: isTupleCell,
  mangledName: tupleCellMangledName,
  headerLabel: "Tuple-cell typedef",
  emptyHeaderSummary: "tuple cell of arity 0 (empty)",
  helpersSummary: "<typedef>_empty / _free / _copy / _assign / _disp",
  members: t =>
    t.slots.map((s, i) => ({
      logicalName: `slot_${i + 1}`,
      cFieldName: tupleCellSlotFieldName(i),
      ty: s,
    })),
  visitNested: (t, visit) => {
    for (const s of t.slots) visit(s);
  },
  emptyPlaceholderFieldName: "_mtoc_empty_pad",
  emptyPlaceholderComment: "C requires >= 1 member",
  selfParam: "s",
  emptyLocal: "_s",
  emitDisp: true,
  renderDispBody: renderTupleCellDispBody,
  orderShapes: topoSort,
};

/** Emit every tuple-cell typedef + helper block, in dependency order. */
export function emitTupleCellBlocks(
  state: EmitState,
  prog: IRProgram
): string[] {
  return emitNamedTypedefBlocks(state, prog, TUPLE_CELL_SPEC);
}

/** Render a single tuple-cell shape's typedef + helpers. Exposed for
 *  the cross-kind unified emitter. */
export function renderTupleCellBlock(
  state: EmitState,
  t: TupleCellType
): string[] {
  return renderNamedTypedefBlock(state, TUPLE_CELL_SPEC, t);
}
