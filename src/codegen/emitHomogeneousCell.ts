/**
 * Per-homogeneous-cell-shape codegen: typedefs + the five generated
 * helpers (`<typedef>_empty`, `_free`, `_copy`, `_assign`, `_disp`).
 *
 * A `HomogeneousCellType { elem: T, len }` produces a C struct
 *   typedef struct { <cElemType> *data; long len; } _mtoc_hcell__<hex>;
 *
 * Helpers:
 *   - `_empty()`  → zero-init `{data=NULL, len=0}`
 *   - `_free(&c)` → free each owned element via the elem-kind helper,
 *                   then free the buffer; idempotent on a zeroed handle
 *   - `_copy(c)`  → deep copy: alloc a fresh buffer of `c.len` elements
 *                   and copy each via the elem-kind `_copy` (owned) or
 *                   bare assignment (scalar)
 *   - `_assign(&l, r)` → consume-replace (free lhs, install rhs)
 *   - `_disp(c)`   → numbl-style `{e1, e2, …}\n` matching `formatCell`
 *
 * Unlike tuple cells (which use the shared `emitNamedTypedef` driver),
 * homogeneous cells need custom helper bodies — the per-element loops
 * and buffer allocation don't fit the field-iteration shape of struct/
 * handle helpers. This emitter generates them directly.
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  cTypeFor,
  homogeneousCellMangledName,
  isHomogeneousCell,
  typeToString,
  type HomogeneousCellType,
} from "../lowering/types.js";
import { collectMTypeShapes } from "../lowering/walk.js";
import { ownedOps } from "./ownedKinds.js";
import { useRuntimeByName, useSnippet, type EmitState } from "./emitState.js";
import { emitInlineSlotDisp } from "./emitTupleCell.js";

export function renderHomogeneousCellBlock(
  state: EmitState,
  t: HomogeneousCellType
): string[] {
  const name = homogeneousCellMangledName(t);
  const elemCType = cTypeFor(t.elem);
  if (elemCType === null) {
    throw new Error(
      `codegen internal: homogeneous cell elem type has no C representation ` +
        `(${typeToString(t.elem)})`
    );
  }
  const lines: string[] = [];
  // Header comment.
  lines.push(`/* Homogeneous-cell typedef: elem ${typeToString(t.elem)}`);
  lines.push(` *   mangled : ${name}`);
  lines.push(` *   elem    : ${typeToString(t.elem)}`);
  lines.push(` *`);
  lines.push(` * Helpers: <typedef>_empty / _free / _copy / _assign / _disp`);
  lines.push(` */`);

  lines.push(`typedef struct ${name} {`);
  lines.push(
    `  ${elemCType} *data;     /* ${typeToString(t.elem)} elements */`
  );
  lines.push(`  long len;`);
  lines.push(`} ${name};`);
  lines.push("");

  // _empty()
  lines.push(`/* Zero-initialized handle (predeclaration default). */`);
  lines.push(`static ${name} ${name}_empty(void) {`);
  lines.push(`  ${name} _c = {0};`);
  lines.push(`  return _c;`);
  lines.push(`}`);
  lines.push("");

  // _free(&self): per-element free for owned elems, then free buffer.
  const elemOwned = ownedOps(t.elem);
  lines.push(`/* Recursively releases each owned element, then the buffer. */`);
  lines.push(`static void ${name}_free(${name} *c) {`);
  lines.push(`  if (c->data == NULL) { c->len = 0; return; }`);
  if (elemOwned !== null) {
    useSnippet(state, elemOwned.free);
    lines.push(`  for (long i = 0; i < c->len; i++) {`);
    lines.push(`    ${elemOwned.free.name}(&c->data[i]);`);
    lines.push(`  }`);
  }
  lines.push(`  free(c->data);`);
  lines.push(`  c->data = NULL;`);
  lines.push(`  c->len = 0;`);
  lines.push(`}`);
  lines.push("");

  // _copy(c): deep copy. Allocate `len` elements; copy each via the
  // elem-kind's `_copy` if owned, else bare value assignment.
  useRuntimeByName(state, "mtoc_alloc");
  lines.push(`/* Deep copy: each element gets its own buffer. */`);
  lines.push(`static ${name} ${name}_copy(${name} c) {`);
  lines.push(`  ${name} _out = {0};`);
  lines.push(`  if (c.len <= 0 || c.data == NULL) return _out;`);
  lines.push(
    `  _out.data = (${elemCType} *)mtoc_alloc((size_t)c.len * sizeof(${elemCType}));`
  );
  lines.push(`  _out.len = c.len;`);
  if (elemOwned !== null) {
    const copyHelper = elemOwned.copy(t.elem);
    useSnippet(state, copyHelper);
    lines.push(`  for (long i = 0; i < c.len; i++) {`);
    lines.push(`    _out.data[i] = ${copyHelper.name}(c.data[i]);`);
    lines.push(`  }`);
  } else {
    lines.push(`  for (long i = 0; i < c.len; i++) {`);
    lines.push(`    _out.data[i] = c.data[i];`);
    lines.push(`  }`);
  }
  lines.push(`  return _out;`);
  lines.push(`}`);
  lines.push("");

  // _assign(&lhs, rhs): consume-replace.
  lines.push(
    `/* Consume-replace: frees lhs's prior contents, installs rhs. */`
  );
  lines.push(`static void ${name}_assign(${name} *lhs, ${name} rhs) {`);
  lines.push(`  ${name}_free(lhs);`);
  lines.push(`  *lhs = rhs;`);
  lines.push(`}`);
  lines.push("");

  // _grow(&c, new_len): extend the buffer to at least new_len slots,
  // zero-initializing newly-added slots. Used by curly-brace stores
  // (`c{k} = v`) where the write would otherwise be out-of-bounds —
  // matches numbl's literal-index auto-grow rule (`c = {}; c{1} = 1;`
  // makes c length 1). A zero-filled new slot is a safe empty handle
  // for every owned elem kind (mtoc_string_empty()-equivalent shape).
  lines.push(`/* Grow the buffer to >= new_len; zero-init new slots. */`);
  lines.push(`static void ${name}_grow(${name} *c, long new_len) {`);
  lines.push(`  if (new_len <= c->len) return;`);
  lines.push(
    `  ${elemCType} *new_data = (${elemCType} *)mtoc_alloc((size_t)new_len * sizeof(${elemCType}));`
  );
  lines.push(`  for (long i = 0; i < c->len; i++) new_data[i] = c->data[i];`);
  lines.push(`  for (long i = c->len; i < new_len; i++) {`);
  if (elemOwned !== null) {
    useSnippet(state, elemOwned.empty);
    lines.push(`    new_data[i] = ${elemOwned.empty.name}();`);
  } else {
    lines.push(`    new_data[i] = (${elemCType}){0};`);
  }
  lines.push(`  }`);
  lines.push(`  free(c->data);`);
  lines.push(`  c->data = new_data;`);
  lines.push(`  c->len = new_len;`);
  lines.push(`}`);
  lines.push("");

  // _disp(c): print `{e1, e2, ..., eN}\n` byte-for-byte against numbl.
  lines.push(`static void ${name}_disp(${name} c) {`);
  lines.push(`  putchar('{');`);
  lines.push(`  for (long i = 0; i < c.len; i++) {`);
  lines.push(`    if (i > 0) fputs(", ", stdout);`);
  const slotLines: string[] = [];
  emitInlineSlotDisp(state, slotLines, t.elem, "c.data[i]", 0, "homogeneous");
  // Indent slot lines two more spaces to fit inside the for loop.
  for (const l of slotLines) lines.push(`  ${l}`);
  lines.push(`  }`);
  lines.push(`  fputs("}\\n", stdout);`);
  lines.push(`}`);
  return lines;
}

/** Topological sort: a homogeneous cell whose elem is another cell /
 *  struct typedef must follow that typedef. v1 cell-of-cell needs
 *  this ordering. */
function topoSort(
  table: ReadonlyMap<string, HomogeneousCellType>
): HomogeneousCellType[] {
  const visited = new Set<string>();
  const order: HomogeneousCellType[] = [];
  const visit = (t: HomogeneousCellType): void => {
    const name = homogeneousCellMangledName(t);
    if (visited.has(name)) return;
    visited.add(name);
    if (isHomogeneousCell(t.elem)) visit(t.elem);
    order.push(t);
  };
  for (const t of table.values()) visit(t);
  return order;
}

/** Emit every homogeneous-cell typedef + helper block, in dependency
 *  order, appending to the caller's output. */
export function emitHomogeneousCellBlocks(
  state: EmitState,
  prog: IRProgram
): string[] {
  const table = collectMTypeShapes(
    prog,
    isHomogeneousCell,
    homogeneousCellMangledName,
    (t, visit) => visit(t.elem)
  );
  if (table.size === 0) return [];
  const out: string[] = [];
  for (const t of topoSort(table)) {
    out.push(...renderHomogeneousCellBlock(state, t));
    out.push("");
  }
  return out;
}
