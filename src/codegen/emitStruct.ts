/**
 * Per-struct-type codegen: typedefs + the four generated helpers
 * (`<typedef>_empty`, `_free`, `_copy`, `_assign`) that the
 * `ownedKinds` registry expects. Plus the `_disp` helper invoked from
 * the `dispKinds` registry.
 *
 * Every distinct struct shape in the program gets exactly one typedef
 * and one set of helpers; codegen walks the IR to collect every
 * `StructType` (by mangled name), topologically sorts so nested
 * struct fields' typedefs precede their parents', and emits the
 * declarations + bodies above the per-function blocks.
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  cTypeFor,
  isNumeric,
  isMultiElement,
  isString,
  isStruct,
  isText,
  structMangledName,
  type StructType,
  type MType,
} from "../lowering/types.js";
import {
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "../lowering/walk.js";
import { ownedOps } from "./ownedKinds.js";
import { useRuntimeByName, type EmitState } from "./emitState.js";
import { formatStringLit } from "./emitFormat.js";

/** A struct shape, indexed by mangled C name. The map preserves
 *  insertion order; we re-sort topologically before emission so a
 *  nested struct field's typedef precedes its enclosing parent. */
type StructTable = Map<string, StructType>;

/** Walk the entire program and collect every distinct struct shape
 *  (including recursively-nested struct field types). */
export function collectStructShapes(prog: IRProgram): StructTable {
  const out: StructTable = new Map();
  const visit = (t: MType): void => {
    if (!isStruct(t)) return;
    const name = structMangledName(t);
    if (!out.has(name)) {
      out.set(name, t);
      // Recurse into field types so nested structs are also registered.
      for (const f of t.fields) visit(f.type);
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

/** Topological sort: a struct type whose field references another
 *  struct must follow that other struct's definition. The dependency
 *  edges are field-type containments; cycles are impossible here
 *  (a struct can't transitively contain itself in v1 — no recursive
 *  types). */
function topoSort(table: StructTable): StructType[] {
  const visited = new Set<string>();
  const order: StructType[] = [];
  const visit = (t: StructType): void => {
    const name = structMangledName(t);
    if (visited.has(name)) return;
    visited.add(name);
    for (const f of t.fields) {
      if (isStruct(f.type)) visit(f.type);
    }
    order.push(t);
  };
  for (const t of table.values()) visit(t);
  return order;
}

/** Render the C source block for one struct shape: typedef + the
 *  four owned-kind helpers + the disp helper. The `disp` helper is
 *  emitted unconditionally (cheap and always wanted when any
 *  `disp(s)` for that shape appears). */
function renderStructBlock(state: EmitState, t: StructType): string[] {
  const name = structMangledName(t);
  const lines: string[] = [];
  const fieldDeclLines: string[] = [];
  for (const f of t.fields) {
    const cTy = cTypeFor(f.type);
    if (cTy === null) {
      throw new Error(
        `codegen internal: struct field '${f.name}' has unsupported C type`
      );
    }
    fieldDeclLines.push(`  ${cTy} ${f.name};`);
  }
  lines.push(`typedef struct ${name} {`);
  if (fieldDeclLines.length === 0) {
    // C forbids zero-member struct types; pad with a single byte so
    // the empty `struct()` literal (`{0}`) is well-formed. The pad is
    // never read by user code.
    lines.push(`  char _mtoc_empty_pad;`);
  } else {
    for (const l of fieldDeclLines) lines.push(l);
  }
  lines.push(`} ${name};`);
  lines.push("");

  // empty()
  lines.push(`static ${name} ${name}_empty(void) {`);
  lines.push(`  ${name} _s = {0};`);
  lines.push(`  return _s;`);
  lines.push(`}`);
  lines.push("");

  // free(&s) — recursively releases any owned field, then zeros the
  // local pointers. Idempotent on a zeroed handle (each child kind's
  // free is, so by induction the struct's is too).
  lines.push(`static void ${name}_free(${name} *s) {`);
  for (const f of t.fields) {
    const fieldFree = freeForField(state, f.name, f.type);
    if (fieldFree !== null) {
      for (const l of fieldFree) lines.push(`  ${l}`);
    }
  }
  lines.push(`}`);
  lines.push("");

  // copy(s) — deep-copy each field. Returns a new struct value.
  lines.push(`static ${name} ${name}_copy(${name} s) {`);
  lines.push(`  ${name} _out = {0};`);
  for (const f of t.fields) {
    const fieldCopy = copyForField(state, f.name, f.type);
    if (fieldCopy !== null) {
      for (const l of fieldCopy) lines.push(`  ${l}`);
    }
  }
  lines.push(`  return _out;`);
  lines.push(`}`);
  lines.push("");

  // assign(&lhs, rhs) — consume-replace: free lhs's current contents,
  // then move rhs in. Caller passes either a fresh value (from a copy
  // or a constructor) or a temporary returned from a function.
  lines.push(`static void ${name}_assign(${name} *lhs, ${name} rhs) {`);
  lines.push(`  ${name}_free(lhs);`);
  lines.push(`  *lhs = rhs;`);
  lines.push(`}`);
  lines.push("");

  // disp(s) — match numbl's `formatStruct` byte-for-byte: each field
  // prints as `    <name>: <displayValue>\n`. Nested structs / tensors
  // / strings contribute their own multi-line disp output (numbl
  // doesn't add extra indentation for nested levels — the first line
  // appears inline after `<name>: `, and subsequent lines start at
  // column 0 of the output).
  lines.push(`static void ${name}_disp(${name} s) {`);
  for (const f of t.fields) {
    const namelit = formatStringLit(f.name);
    // We use `printf("    %s: ", name)` to print the label, then
    // delegate to the field-kind's disp helper for the value. The
    // value's disp already ends with a newline.
    if (isStruct(f.type)) {
      const innerName = structMangledName(f.type);
      useRuntimeByName(state, "mtoc_format_double"); // for the included header chain; harmless
      lines.push(`  printf("    %s: ", ${namelit});`);
      // For a nested struct: numbl prints the inner struct's first
      // field inline. We use a helper print that drops the first 4
      // spaces of the first line. The cleanest path is to just call
      // <innerName>_disp(s.<field>) which itself starts with "    "
      // — that gives us "    name:     ..." with a double-indent that
      // numbl actually produces (see numbl runtime/display.ts:255).
      lines.push(`  ${innerName}_disp(s.${f.name});`);
    } else if (isText(f.type)) {
      // String or char-array: use mtoc_disp_text via a text view.
      const view = isString(f.type)
        ? `mtoc_text_from_string(s.${f.name})`
        : `mtoc_text_from_char_tensor(s.${f.name})`;
      useRuntimeByName(state, "mtoc_disp_text");
      useRuntimeByName(state, "mtoc_text_view_t");
      lines.push(`  printf("    %s: ", ${namelit});`);
      lines.push(`  mtoc_disp_text(${view});`);
    } else if (isNumeric(f.type) && isMultiElement(f.type)) {
      const owned = ownedOps(f.type);
      const dispHelper = owned?.disp?.(f.type);
      if (dispHelper) {
        useRuntimeByName(state, dispHelper);
        // Tensor disp prints lines starting with `   ` (3 spaces). The
        // first field-disp line ends up right after `    name:` — for
        // a multi-line tensor field, subsequent lines start at column
        // 0 of the output, matching numbl's behavior.
        lines.push(`  printf("    %s:", ${namelit});`);
        lines.push(`  ${dispHelper}(s.${f.name});`);
      } else {
        lines.push(`  printf("    %s: <unsupported>\\n", ${namelit});`);
      }
    } else if (isNumeric(f.type) && f.type.elem === "char") {
      // Scalar char.
      useRuntimeByName(state, "mtoc_disp_char");
      lines.push(`  printf("    %s: ", ${namelit});`);
      lines.push(`  mtoc_disp_char(s.${f.name});`);
    } else if (isNumeric(f.type)) {
      // Scalar real or complex.
      if (f.type.isComplex) {
        useRuntimeByName(state, "mtoc_disp_complex");
        lines.push(`  printf("    %s: ", ${namelit});`);
        lines.push(`  mtoc_disp_complex(s.${f.name});`);
      } else {
        useRuntimeByName(state, "mtoc_disp_double");
        lines.push(`  printf("    %s: ", ${namelit});`);
        lines.push(`  mtoc_disp_double(s.${f.name});`);
      }
    } else {
      lines.push(`  printf("    %s: <unsupported>\\n", ${namelit});`);
    }
  }
  // Empty struct: numbl emits a single blank line. mtoc emits nothing
  // here — the surrounding `disp(s);` semantics will produce the blank
  // line via the `\n` that the disp helper itself doesn't add when no
  // fields are present.
  if (t.fields.length === 0) {
    lines.push(`  putchar('\\n');`);
  }
  lines.push(`}`);
  return lines;
}

/** C code releasing field `name` of type `ty` from `*s`. Returns
 *  null if the field is a non-owned scalar (no free needed). */
function freeForField(
  state: EmitState,
  name: string,
  ty: MType
): string[] | null {
  const owned = ownedOps(ty);
  if (owned === null) return null;
  // For struct-typed fields the owned-kinds dispatch returns the
  // generated `<typedef>_free` we just emitted; the dependency on
  // that snippet is implicit (the helper is in the same emit pass).
  // Other owned kinds (tensors / strings / char arrays) ride the
  // runtime registry.
  if (!isStruct(ty)) useRuntimeByName(state, owned.free);
  return [`${owned.free}(&s->${name});`, `s->${name} = (${cTypeFor(ty)}){0};`];
}

/** C code deep-copying field `name` from `s` into `_out` (the caller's
 *  return value). Returns null if no work (e.g. scalar fields can be
 *  bit-copied via the `_out = {0}; ` followed by field-wise scalar
 *  copy below). For scalars we still emit a plain `_out.name = s.name;`. */
function copyForField(
  state: EmitState,
  name: string,
  ty: MType
): string[] | null {
  const owned = ownedOps(ty);
  if (owned === null) {
    return [`_out.${name} = s.${name};`];
  }
  if (isStruct(ty)) {
    // The struct's own `<typedef>_copy` returns a new value.
    return [`_out.${name} = ${owned.copy(ty)}(s.${name});`];
  }
  const helper = owned.copy(ty);
  useRuntimeByName(state, helper);
  return [`_out.${name} = ${helper}(s.${name});`];
}

/** Emit every struct typedef + helper block, in dependency order,
 *  appending them to `out`. Returns the combined lines so the
 *  caller can splice them into the final C source ahead of the
 *  user-function bodies. */
export function emitStructBlocks(state: EmitState, prog: IRProgram): string[] {
  const table = collectStructShapes(prog);
  if (table.size === 0) return [];
  const order = topoSort(table);
  const out: string[] = [];
  for (const t of order) {
    out.push(...renderStructBlock(state, t));
    out.push("");
  }
  return out;
}
