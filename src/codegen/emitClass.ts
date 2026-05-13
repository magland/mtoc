/**
 * Per-class-type codegen: typedefs + the four generated helpers
 * (`<typedef>_empty`, `_free`, `_copy`, `_assign`). The class typedef
 * mirrors the struct layout — one C field per declared property — and
 * the helpers compose recursively over owned-typed properties.
 *
 * Class identity (`(file, className)`) is part of the typedef hash so
 * two same-named classes in different packages stay distinct, and two
 * different classes with coincidentally identical property shapes
 * never share a typedef. The driver scaffolding (typedef + helpers +
 * cross-kind topo sort) is shared with struct/handle/cell via
 * `emitNamedTypedef.ts` — this file only supplies the per-kind spec.
 *
 * `disp(obj)` is deferred for Stage 1 — emitDisp is false. Class
 * instances rejected at `Disp` lowering until Stage 3.
 */

import {
  classMangledName,
  isClass,
  type ClassType,
} from "../lowering/types.js";
import {
  renderNamedTypedefBlock,
  type NamedTypedefSpec,
} from "./emitNamedTypedef.js";
import type { EmitState } from "./emitState.js";

const CLASS_SPEC: NamedTypedefSpec<ClassType> = {
  isKind: isClass,
  mangledName: classMangledName,
  headerLabel: "Class typedef",
  emptyHeaderSummary: "classdef with no properties",
  helpersSummary: "<typedef>_empty / _free / _copy / _assign",
  members: t =>
    t.properties.map(p => ({
      logicalName: p.name,
      cFieldName: p.name,
      ty: p.type,
    })),
  visitNested: (t, visit) => {
    for (const p of t.properties) visit(p.type);
  },
  emptyPlaceholderFieldName: "_mtoc_empty_pad",
  emptyPlaceholderComment: "C requires >= 1 member",
  selfParam: "obj",
  emptyLocal: "_obj",
  emitDisp: false,
};

/** Render a single class shape's typedef + helpers. Exposed so the
 *  cross-kind unified emitter splices class blocks in topo order
 *  alongside struct / handle / cell blocks. */
export function renderClassBlock(state: EmitState, t: ClassType): string[] {
  return renderNamedTypedefBlock(state, CLASS_SPEC, t);
}
