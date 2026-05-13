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
 * Mirrors `emitStruct.ts` in shape; the per-field helpers route
 * through the `ownedKinds` registry so captured tensors / strings /
 * nested structs / nested handles get the right deep-copy / free
 * semantics for free.
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  cTypeFor,
  handleMangledName,
  isHandle,
  typeToString,
  type HandleType,
  type MType,
} from "../lowering/types.js";
import {
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "../lowering/walk.js";
import { ownedOps } from "./ownedKinds.js";
import { useRuntimeByName, type EmitState } from "./emitState.js";

/** A handle shape, indexed by mangled C name. The map preserves
 *  insertion order; we emit empty (the shared placeholder) first
 *  when present, then per-shape typedefs in registration order.
 *  Each shape's helpers depend only on the shape itself and on
 *  per-field-type runtime helpers, so no topological sort is needed
 *  beyond "empty first". */
type HandleTable = Map<string, HandleType>;

/** Walk the entire program and collect every distinct handle shape
 *  reachable from any IR position. Two handles with the same
 *  capture tuple share a typedef even when their target identities
 *  differ — the C type encodes only the captures' shape. */
export function collectHandleShapes(prog: IRProgram): HandleTable {
  const out: HandleTable = new Map();
  const visit = (t: MType): void => {
    if (!isHandle(t)) return;
    const name = handleMangledName(t);
    if (!out.has(name)) {
      out.set(name, t);
      // Recurse into each capture's type so a nested handle / nested
      // struct field is also registered.
      for (const c of t.captures) visit(c.ty);
    }
  };
  const visitExpr = (e: { ty: MType }): void => visit(e.ty);
  const visitStmtTypes = (s: import("../lowering/ir.js").IRStmt): void => {
    forEachTopLevelExpr(s, sub => forEachSubExpr(sub, visitExpr));
    if (s.kind === "Assign") visit(s.ty);
    if (s.kind === "MemberStore") {
      visit(s.base.ty);
      visit(s.leafTy);
      visit(s.rhs.ty);
    }
  };
  for (const fn of prog.functions) {
    for (const p of fn.params) visit(p.ty);
    for (const o of fn.outputs) visit(o.ty);
    for (const v of fn.assignedVars.values()) visit(v.ty);
    forEachStmtInTree(fn.body, visitStmtTypes);
  }
  for (const v of prog.assignedVars.values()) visit(v.ty);
  forEachStmtInTree(prog.stmts, visitStmtTypes);
  return out;
}

/** Header comment for a handle shape. Lists the capture names + their
 *  inferred types so a reader can map the mangled typedef back to
 *  the @-site's captures. */
function handleHeaderComment(t: HandleType): string[] {
  const name = handleMangledName(t);
  const labelWidth = Math.max(
    "mangled".length,
    ...t.captures.map(c => c.name.length)
  );
  const pad = (s: string) => s.padEnd(labelWidth);
  const lines: string[] = [];
  if (t.captures.length === 0) {
    lines.push(`/* Handle typedef: no captures (shared placeholder)`);
  } else {
    const capList = t.captures.map(c => c.name).join(", ");
    lines.push(`/* Handle typedef: captures {${capList}}`);
  }
  lines.push(` *   ${pad("mangled")} : ${name}`);
  for (const c of t.captures) {
    lines.push(` *   ${pad(c.name)} : ${typeToString(c.ty)}`);
  }
  lines.push(` *`);
  lines.push(` * Helpers: <typedef>_empty / _free / _copy / _assign`);
  lines.push(` */`);
  return lines;
}

/** Render the C source block for one handle shape: typedef + the
 *  four owned-kind helpers. */
function renderHandleBlock(state: EmitState, t: HandleType): string[] {
  const name = handleMangledName(t);
  const lines: string[] = [];
  for (const l of handleHeaderComment(t)) lines.push(l);

  // typedef. No-capture: single `char _placeholder;` so the struct
  // has at least one field (standards-conformant C). With captures:
  // one field per capture, named `cap_<captureName>`.
  lines.push(`typedef struct ${name} {`);
  if (t.captures.length === 0) {
    lines.push(`  char _placeholder; /* C requires >= 1 member */`);
  } else {
    for (const c of t.captures) {
      const cTy = cTypeFor(c.ty);
      if (cTy === null) {
        throw new Error(
          `codegen internal: handle capture '${c.name}' has unsupported C type (${typeToString(c.ty)})`
        );
      }
      lines.push(`  ${cTy} cap_${c.name}; /* ${typeToString(c.ty)} */`);
    }
  }
  lines.push(`} ${name};`);
  lines.push("");

  // empty() — zero-initialized handle. Used to predeclare a handle
  // local before any user write and to seed owned-discard slots at
  // multi-output call sites. Safe to feed back into _free.
  lines.push(`/* Zero-initialized handle (predeclaration default). */`);
  lines.push(`static ${name} ${name}_empty(void) {`);
  lines.push(`  ${name} _h = {0};`);
  lines.push(`  return _h;`);
  lines.push(`}`);
  lines.push("");

  // free(&h) — recursively releases any owned capture. Idempotent
  // on a zeroed handle.
  lines.push(
    `/* Recursively releases any owned capture. Idempotent on a zeroed handle. */`
  );
  lines.push(`static void ${name}_free(${name} *h) {`);
  for (const c of t.captures) {
    const fieldFree = freeForCapture(state, c.name, c.ty);
    if (fieldFree !== null) {
      for (const l of fieldFree) lines.push(`  ${l}`);
    }
  }
  if (t.captures.length === 0) {
    // C: unused parameter — explicitly mark it to suppress warnings.
    lines.push(`  (void)h;`);
  }
  lines.push(`}`);
  lines.push("");

  // copy(h) — deep-copy each capture. Returns a new handle value.
  // Drives copy-on-arg-pass for handle function parameters.
  lines.push(`/* Deep copy: each owned capture gets its own buffer.`);
  lines.push(
    ` * Drives the copy-on-arg-pass semantics for handle function parameters. */`
  );
  lines.push(`static ${name} ${name}_copy(${name} h) {`);
  lines.push(`  ${name} _out = {0};`);
  for (const c of t.captures) {
    const fieldCopy = copyForCapture(state, c.name, c.ty);
    if (fieldCopy !== null) {
      for (const l of fieldCopy) lines.push(`  ${l}`);
    }
  }
  if (t.captures.length === 0) {
    lines.push(`  (void)h;`);
  }
  lines.push(`  return _out;`);
  lines.push(`}`);
  lines.push("");

  // assign(&lhs, rhs) — consume-replace: free lhs's current contents,
  // then move rhs in.
  lines.push(
    `/* Consume-replace: frees lhs's prior contents, installs rhs. */`
  );
  lines.push(`static void ${name}_assign(${name} *lhs, ${name} rhs) {`);
  lines.push(`  ${name}_free(lhs);`);
  lines.push(`  *lhs = rhs;`);
  lines.push(`}`);
  return lines;
}

/** C lines releasing capture `name` of type `ty` from `*h`. Returns
 *  null if the capture is a non-owned scalar (no free needed). */
function freeForCapture(
  state: EmitState,
  name: string,
  ty: MType
): string[] | null {
  const owned = ownedOps(ty);
  if (owned === null) return null;
  // For struct / handle fields the owned-kind dispatch returns the
  // generated `<typedef>_free` we emit in the same pass; the
  // dependency is implicit and the snippet does not need runtime-
  // registry activation. Other owned kinds ride the runtime registry.
  const helperName = owned.free;
  if (
    !helperName.startsWith("_mtoc_struct__") &&
    !helperName.startsWith("_mtoc_handle")
  ) {
    useRuntimeByName(state, helperName);
  }
  return [
    `${helperName}(&h->cap_${name});`,
    `h->cap_${name} = (${cTypeFor(ty)}){0};`,
  ];
}

/** C lines deep-copying capture `name` from `h` into `_out`. */
function copyForCapture(
  state: EmitState,
  name: string,
  ty: MType
): string[] | null {
  const owned = ownedOps(ty);
  if (owned === null) {
    return [`_out.cap_${name} = h.cap_${name};`];
  }
  const helper = owned.copy(ty);
  if (
    !helper.startsWith("_mtoc_struct__") &&
    !helper.startsWith("_mtoc_handle")
  ) {
    useRuntimeByName(state, helper);
  }
  return [`_out.cap_${name} = ${helper}(h.cap_${name});`];
}

/** Emit every handle typedef + helper block, appending to the output
 *  ahead of the user-function bodies. */
export function emitHandleBlocks(state: EmitState, prog: IRProgram): string[] {
  const table = collectHandleShapes(prog);
  if (table.size === 0) return [];
  const out: string[] = [];
  // Emit the shared empty typedef first if any no-capture handle is
  // in the program; then per-shape typedefs in registration order.
  // Per-shape typedefs may transitively reference other handle / struct
  // shapes via capture types — those nested shapes register through
  // `collectHandleShapes` and `emitStruct.ts`'s collection, and their
  // own typedef blocks land in the appropriate ordering pass before
  // the per-function bodies.
  const empty = table.get("_mtoc_handle_empty_t");
  if (empty) {
    out.push(...renderHandleBlock(state, empty));
    out.push("");
  }
  for (const [name, t] of table) {
    if (name === "_mtoc_handle_empty_t") continue;
    out.push(...renderHandleBlock(state, t));
    out.push("");
  }
  return out;
}
