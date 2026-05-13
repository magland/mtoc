/**
 * Shared driver for "named-typedef" owned kinds — currently structs and
 * handles, with classes the next likely user.
 *
 * Each kind contributes one C typedef plus the standard owned-kind
 * helper set (`_empty`, `_free`, `_copy`, `_assign`) emitted into the
 * output ahead of the user-function bodies. Per-kind variations
 * (field-name prefix, header-comment label, optional `_disp` body,
 * empty-form placeholder pad) are described declaratively via a
 * `NamedTypedefSpec` so the per-shape rendering and the IR-walking
 * collector stay in one place.
 *
 * Before this driver, `emitStruct.ts` and `emitHandle.ts` were two
 * near-identical templates instantiated with different field-name
 * prefixes. The duplication scaled badly: a new owned kind (class,
 * cell, …) meant a third file with the same shape.
 */

import type { IRProgram, IRStmt } from "../lowering/ir.js";
import { cTypeFor, typeToString, type MType } from "../lowering/types.js";
import {
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "../lowering/walk.js";
import { ownedOps } from "./ownedKinds.js";
import { useSnippet, type EmitState } from "./emitState.js";

/** One logical "member" (struct field, handle capture, class property)
 *  of a named-typedef kind. `logicalName` is the source-language name
 *  (e.g. `"x"`); `cFieldName` is the C struct field identifier
 *  (`"x"` for struct fields, `"cap_x"` for handle captures); `ty` is
 *  the inferred MType. */
export interface NamedTypedefMember {
  logicalName: string;
  cFieldName: string;
  ty: MType;
}

/** Per-kind description. The driver iterates a program's IR via
 *  `isKind` + `mangledName`, then renders each shape via the
 *  remaining fields. */
export interface NamedTypedefSpec<T extends MType> {
  /** Type predicate used to detect this kind. */
  isKind: (t: MType) => t is T;
  /** Per-shape mangled C typedef name. */
  mangledName: (t: T) => string;
  /** Header-comment label for shapes with at least one member
   *  (e.g. "Struct typedef" / "Handle typedef"). */
  headerLabel: string;
  /** Optional phrase between `<headerLabel>:` and the `{names}` list
   *  (e.g. `""` for struct, `"captures "` for handle). */
  membersHeaderPrefix?: string;
  /** Header-comment summary for the no-member shape (e.g.
   *  `"struct() (empty)"` / `"no captures (shared placeholder)"`). */
  emptyHeaderSummary: string;
  /** Header-comment phrase listing the available helpers, e.g.
   *  `"<typedef>_empty / _free / _copy / _assign / _disp"`. */
  helpersSummary: string;
  /** Members for a single shape, in declaration order. */
  members: (t: T) => ReadonlyArray<NamedTypedefMember>;
  /** Recurse into nested type references (members' types) so the
   *  driver's collector picks up transitively-reachable shapes. */
  visitNested: (t: T, visit: (sub: MType) => void) => void;
  /** Name of the placeholder field emitted into the no-member typedef
   *  body so the C struct has ≥1 member. */
  emptyPlaceholderFieldName: string;
  /** Comment shown next to the empty placeholder. */
  emptyPlaceholderComment: string;
  /** Per-kind C identifier for the by-value parameter of the
   *  generated `_free` / `_copy` / `_disp` helpers (e.g. `"s"` for
   *  struct, `"h"` for handle). Tests + readers expect these names;
   *  keeping them per-spec preserves byte-for-byte generated C. */
  selfParam: string;
  /** Per-kind C identifier for the local variable inside `_empty()`
   *  (e.g. `"_s"` / `"_h"`). Cosmetic — not asserted on by tests but
   *  worth keeping consistent with `selfParam` for readability. */
  emptyLocal: string;
  /** True if every shape gets a generated `_disp` helper. Today only
   *  structs do; handles intentionally have none. */
  emitDisp: boolean;
  /** Optional renderer for the `_disp` body — invoked only when
   *  `emitDisp === true`. Returns the lines to splice in between the
   *  function header and `}`; the driver wraps the signature. */
  renderDispBody?: (state: EmitState, t: T) => string[];
  /** Order shapes for emission. The default registration order is
   *  fine when nothing transitively references another shape of the
   *  same kind; for structs (whose field types may be other structs)
   *  the spec supplies a topological sort. */
  orderShapes?: (table: ReadonlyMap<string, T>) => ReadonlyArray<T>;
  /** Optional fixed prefix block emitted before the rest of the
   *  shapes (e.g. the shared `_mtoc_handle_empty_t` typedef when any
   *  no-capture handle is in the program). The driver appends this
   *  block once before the per-shape blocks. */
  emitPrologue?: (
    state: EmitState,
    table: ReadonlyMap<string, T>,
    renderBlock: (state: EmitState, t: T) => string[]
  ) => string[];
}

/** Walk the whole program and collect every distinct shape of the
 *  named-typedef kind described by `spec`, indexed by mangled name. */
function collectShapes<T extends MType>(
  prog: IRProgram,
  spec: NamedTypedefSpec<T>
): Map<string, T> {
  const out: Map<string, T> = new Map();
  const visit = (t: MType): void => {
    if (!spec.isKind(t)) return;
    const name = spec.mangledName(t);
    if (!out.has(name)) {
      out.set(name, t);
      // Recurse into nested fields/captures so a struct-of-struct or
      // handle-with-handle-capture also registers.
      spec.visitNested(t, visit);
    }
  };
  const visitExpr = (e: { ty: MType }): void => visit(e.ty);
  const visitStmtTypes = (s: IRStmt): void => {
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

/** Render one header-comment block: shape label, mangled name, and
 *  one line per member. Mirrors the previous bespoke `structHeaderComment`
 *  / `handleHeaderComment` outputs byte-for-byte. */
function renderHeaderComment<T extends MType>(
  spec: NamedTypedefSpec<T>,
  t: T,
  mangled: string
): string[] {
  const members = spec.members(t);
  const labelWidth = Math.max(
    "mangled".length,
    ...members.map(m => m.logicalName.length)
  );
  const pad = (s: string): string => s.padEnd(labelWidth);
  const lines: string[] = [];
  if (members.length === 0) {
    lines.push(`/* ${spec.headerLabel}: ${spec.emptyHeaderSummary}`);
  } else {
    const names = members.map(m => m.logicalName).join(", ");
    const prefix = spec.membersHeaderPrefix ?? "";
    lines.push(`/* ${spec.headerLabel}: ${prefix}{${names}}`);
  }
  lines.push(` *   ${pad("mangled")} : ${mangled}`);
  for (const m of members) {
    lines.push(` *   ${pad(m.logicalName)} : ${typeToString(m.ty)}`);
  }
  lines.push(` *`);
  lines.push(` * Helpers: ${spec.helpersSummary}`);
  lines.push(` */`);
  return lines;
}

/** Render the typedef + the four owned-kind helpers (+ disp when the
 *  spec opts in) for one shape. */
function renderBlock<T extends MType>(
  state: EmitState,
  spec: NamedTypedefSpec<T>,
  t: T
): string[] {
  const name = spec.mangledName(t);
  const members = spec.members(t);
  const lines: string[] = [];
  for (const l of renderHeaderComment(spec, t, name)) lines.push(l);

  // typedef. Empty shape: emit a single `<placeholder> _placeholder;`
  // line so the struct is standards-conformant C; otherwise one line
  // per member at its `cFieldName` slot.
  lines.push(`typedef struct ${name} {`);
  if (members.length === 0) {
    lines.push(
      `  char ${spec.emptyPlaceholderFieldName}; /* ${spec.emptyPlaceholderComment} */`
    );
  } else {
    for (const m of members) {
      const cTy = cTypeFor(m.ty);
      if (cTy === null) {
        throw new Error(
          `codegen internal: ${spec.headerLabel} member '${m.logicalName}' ` +
            `has unsupported C type (${typeToString(m.ty)})`
        );
      }
      lines.push(`  ${cTy} ${m.cFieldName}; /* ${typeToString(m.ty)} */`);
    }
  }
  lines.push(`} ${name};`);
  lines.push("");

  const self = spec.selfParam;

  // empty()
  lines.push(`/* Zero-initialized handle (predeclaration default). */`);
  lines.push(`static ${name} ${name}_empty(void) {`);
  lines.push(`  ${name} ${spec.emptyLocal} = {0};`);
  lines.push(`  return ${spec.emptyLocal};`);
  lines.push(`}`);
  lines.push("");

  // free(&self): per-member free for owned members.
  lines.push(
    `/* Recursively releases any owned member. Idempotent on a zeroed handle. */`
  );
  lines.push(`static void ${name}_free(${name} *${self}) {`);
  let anyMemberFreed = false;
  for (const m of members) {
    const owned = ownedOps(m.ty);
    if (owned === null) continue;
    anyMemberFreed = true;
    useSnippet(state, owned.free);
    lines.push(`  ${owned.free.name}(&${self}->${m.cFieldName});`);
    lines.push(`  ${self}->${m.cFieldName} = (${cTypeFor(m.ty)}){0};`);
  }
  if (!anyMemberFreed) {
    // C: unused parameter — explicitly mark it so callers warn-clean.
    lines.push(`  (void)${self};`);
  }
  lines.push(`}`);
  lines.push("");

  // copy(self): deep-copy each member.
  lines.push(`/* Deep copy: each owned member gets its own buffer.`);
  lines.push(
    ` * Drives the copy-on-arg-pass semantics for ${spec.headerLabel.toLowerCase()} parameters. */`
  );
  lines.push(`static ${name} ${name}_copy(${name} ${self}) {`);
  lines.push(`  ${name} _out = {0};`);
  if (members.length === 0) {
    lines.push(`  (void)${self};`);
  } else {
    for (const m of members) {
      const owned = ownedOps(m.ty);
      if (owned === null) {
        lines.push(`  _out.${m.cFieldName} = ${self}.${m.cFieldName};`);
        continue;
      }
      const helper = owned.copy(m.ty);
      useSnippet(state, helper);
      lines.push(
        `  _out.${m.cFieldName} = ${helper.name}(${self}.${m.cFieldName});`
      );
    }
  }
  lines.push(`  return _out;`);
  lines.push(`}`);
  lines.push("");

  // assign(&lhs, rhs): consume-replace.
  lines.push(
    `/* Consume-replace: frees lhs's prior contents, installs rhs. */`
  );
  lines.push(`static void ${name}_assign(${name} *lhs, ${name} rhs) {`);
  lines.push(`  ${name}_free(lhs);`);
  lines.push(`  *lhs = rhs;`);
  lines.push(`}`);

  // disp(self): optional, struct-only today.
  if (spec.emitDisp && spec.renderDispBody !== undefined) {
    lines.push("");
    lines.push(`static void ${name}_disp(${name} ${self}) {`);
    for (const l of spec.renderDispBody(state, t)) lines.push(l);
    lines.push(`}`);
  }
  return lines;
}

/** Emit every shape's typedef + helper block, in dependency order,
 *  appending them to the caller's output. */
export function emitNamedTypedefBlocks<T extends MType>(
  state: EmitState,
  prog: IRProgram,
  spec: NamedTypedefSpec<T>
): string[] {
  const table = collectShapes(prog, spec);
  if (table.size === 0) return [];
  const renderOne = (s: EmitState, t: T): string[] => renderBlock(s, spec, t);
  const out: string[] = [];
  if (spec.emitPrologue !== undefined) {
    for (const l of spec.emitPrologue(state, table, renderOne)) out.push(l);
  }
  const order = spec.orderShapes
    ? spec.orderShapes(table)
    : [...table.values()];
  for (const t of order) {
    out.push(...renderBlock(state, spec, t));
    out.push("");
  }
  return out;
}
