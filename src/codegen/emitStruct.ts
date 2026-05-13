/**
 * Per-struct-type codegen: typedefs + the four generated helpers
 * (`<typedef>_empty`, `_free`, `_copy`, `_assign`) plus the
 * struct-specific `_disp` helper. Most of the scaffolding (header
 * comment, typedef + the four owned-kind helpers) is shared with
 * handle codegen and lives in `emitNamedTypedef.ts`; this file
 * supplies the per-struct spec and the bespoke `_disp` body that
 * matches numbl's `formatStruct` byte-for-byte.
 *
 * Every distinct struct shape in the program gets exactly one typedef
 * and one set of helpers; the driver walks the IR to collect every
 * `StructType` (by mangled name), topologically sorts so nested
 * struct fields' typedefs precede their parents', and emits the
 * declarations + bodies above the per-function blocks.
 */

import type { IRProgram } from "../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  isString,
  isStruct,
  isText,
  structMangledName,
  type StructType,
} from "../lowering/types.js";
import { ownedOps } from "./ownedKinds.js";
import { useRuntimeByName, useSnippet, type EmitState } from "./emitState.js";
import { formatStringLit } from "./emitFormat.js";
import {
  emitNamedTypedefBlocks,
  renderNamedTypedefBlock,
  type NamedTypedefSpec,
} from "./emitNamedTypedef.js";

/** Topological sort: a struct type whose field references another
 *  struct must follow that other struct's definition. The dependency
 *  edges are field-type containments; cycles are impossible in v1
 *  (a struct can't transitively contain itself — no recursive types). */
function topoSort(table: ReadonlyMap<string, StructType>): StructType[] {
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

/** Render the `_disp` body for a struct shape — matches numbl's
 *  `formatStruct` byte-for-byte. One line per field as
 *  `    <name>: <displayValue>\n`; nested structs/tensors/strings
 *  contribute their own multi-line disp output. */
function renderStructDispBody(state: EmitState, t: StructType): string[] {
  const lines: string[] = [];
  for (const f of t.fields) {
    const namelit = formatStringLit(f.name);
    if (isStruct(f.type)) {
      const innerName = structMangledName(f.type);
      useRuntimeByName(state, "mtoc_format_double"); // for the included header chain; harmless
      lines.push(`  printf("    %s: ", ${namelit});`);
      lines.push(`  ${innerName}_disp(s.${f.name});`);
    } else if (isText(f.type)) {
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
        useSnippet(state, dispHelper);
        lines.push(`  printf("    %s:", ${namelit});`);
        lines.push(`  ${dispHelper.name}(s.${f.name});`);
      } else {
        lines.push(`  printf("    %s: <unsupported>\\n", ${namelit});`);
      }
    } else if (isNumeric(f.type) && f.type.elem === "char") {
      useRuntimeByName(state, "mtoc_disp_char");
      lines.push(`  printf("    %s: ", ${namelit});`);
      lines.push(`  mtoc_disp_char(s.${f.name});`);
    } else if (isNumeric(f.type)) {
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
  // Empty struct: numbl emits a single blank line.
  if (t.fields.length === 0) {
    lines.push(`  putchar('\\n');`);
  }
  return lines;
}

const STRUCT_SPEC: NamedTypedefSpec<StructType> = {
  isKind: isStruct,
  mangledName: structMangledName,
  headerLabel: "Struct typedef",
  emptyHeaderSummary: "struct() (empty)",
  helpersSummary: "<typedef>_empty / _free / _copy / _assign / _disp",
  members: t =>
    t.fields.map(f => ({
      logicalName: f.name,
      cFieldName: f.name,
      ty: f.type,
    })),
  visitNested: (t, visit) => {
    for (const f of t.fields) visit(f.type);
  },
  emptyPlaceholderFieldName: "_mtoc_empty_pad",
  emptyPlaceholderComment: "C requires >= 1 member",
  selfParam: "s",
  emptyLocal: "_s",
  emitDisp: true,
  renderDispBody: renderStructDispBody,
  orderShapes: topoSort,
};

/** Emit every struct typedef + helper block, in dependency order. */
export function emitStructBlocks(state: EmitState, prog: IRProgram): string[] {
  return emitNamedTypedefBlocks(state, prog, STRUCT_SPEC);
}

/** Render a single struct shape's typedef + helpers. Exposed so the
 *  cross-kind unified emitter can splice struct blocks in topo order
 *  alongside handle / cell blocks. */
export function renderStructBlock(state: EmitState, t: StructType): string[] {
  return renderNamedTypedefBlock(state, STRUCT_SPEC, t);
}
