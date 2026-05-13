/**
 * Per-handle-shape codegen: typedefs + the four owned-kind helpers
 * (`<typedef>_empty`, `_free`, `_copy`, `_assign`).
 *
 * All no-capture handles share a single `_mtoc_handle_empty_t`
 * typedef with one placeholder field (so the struct is standards-
 * conformant C). Handles with captures get one typedef per distinct
 * capture-tuple shape, hashed FNV-1a 32 over `[(name, canonical-ty)]`.
 * The dispatch (which mangled C function to invoke at `h(args)`) is
 * static — handled by `lowerHandle.ts` — so the struct only carries
 * the captures' VALUES, no function pointer.
 *
 * Shares the typedef + owned-kind helper scaffolding with `emitStruct.ts`
 * via `emitNamedTypedef.ts`; this file only supplies the per-handle
 * spec and the "empty typedef first" prologue.
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  handleMangledName,
  isHandle,
  type HandleType,
} from "../lowering/types.js";
import { type EmitState } from "./emitState.js";
import {
  emitNamedTypedefBlocks,
  type NamedTypedefSpec,
} from "./emitNamedTypedef.js";

const EMPTY_TYPEDEF_NAME = "_mtoc_handle_empty_t";

const HANDLE_SPEC: NamedTypedefSpec<HandleType> = {
  isKind: isHandle,
  mangledName: handleMangledName,
  headerLabel: "Handle typedef",
  membersHeaderPrefix: "captures ",
  emptyHeaderSummary: "no captures (shared placeholder)",
  helpersSummary: "<typedef>_empty / _free / _copy / _assign",
  members: t =>
    t.captures.map(c => ({
      logicalName: c.name,
      cFieldName: `cap_${c.name}`,
      ty: c.ty,
    })),
  visitNested: (t, visit) => {
    for (const c of t.captures) visit(c.ty);
  },
  emptyPlaceholderFieldName: "_placeholder",
  emptyPlaceholderComment: "C requires >= 1 member",
  selfParam: "h",
  emptyLocal: "_h",
  emitDisp: false,
  // The shared placeholder typedef + helpers come first when any
  // no-capture handle is present, then per-shape blocks land in
  // registration order. The driver's default order is registration
  // order, so we reach for the prologue hook to splice in the empty
  // form ahead and skip it during the per-shape loop.
  emitPrologue: (state, table, renderBlock) => {
    const empty = table.get(EMPTY_TYPEDEF_NAME);
    if (empty === undefined) return [];
    return [...renderBlock(state, empty), ""];
  },
  orderShapes: table => {
    const out: HandleType[] = [];
    for (const [name, t] of table) {
      if (name === EMPTY_TYPEDEF_NAME) continue;
      out.push(t);
    }
    return out;
  },
};

/** Emit every handle typedef + helper block, appending to the output
 *  ahead of the user-function bodies. */
export function emitHandleBlocks(state: EmitState, prog: IRProgram): string[] {
  return emitNamedTypedefBlocks(state, prog, HANDLE_SPEC);
}
