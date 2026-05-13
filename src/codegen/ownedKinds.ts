/**
 * Owned-kind registry — one source of truth for the C-side runtime
 * helpers each owned MType maps to.
 *
 * "Owned" means a value backed by a heap allocation that the generated
 * code is responsible for releasing — strings, multi-element double
 * tensors, multi-element char arrays, structs, function handles. The
 * `isOwned` predicate in `lowering/types.ts` is the seed; this
 * registry picks up where it leaves off and answers, for a given
 * owned type, which C helper to call for each role (typedef, empty
 * placeholder, free, assign, copy, disp).
 *
 * Each helper is a `SnippetActivation` — a discriminated union over
 * "registered runtime snippet" (looked up in `RUNTIME_HELPERS`) and
 * "program-emitted" (defined inline by `emitStruct.ts` / `emitHandle.ts`
 * during the same emit pass). Call sites activate via `useSnippet`,
 * which is a no-op for program-emitted entries.
 *
 * Adding a new owned kind (logical-tensor, cell, class, …) is a single
 * entry plus the matching .h files or per-shape emitter; every call
 * site that currently switches on `(isString | isCharArray |
 * isMultiElement)` to pick a helper collapses to `ownedOps(ty).<role>`.
 */

import {
  handleMangledName,
  homogeneousCellMangledName,
  isCharArray,
  isHandle,
  isHomogeneousCell,
  isMultiElement,
  isNumeric,
  isString,
  isStruct,
  isTupleCell,
  structMangledName,
  tupleCellMangledName,
  type MType,
} from "../lowering/types.js";

/** A snippet activation. `registered` names a key in the runtime
 *  helper registry (`RUNTIME_HELPERS`); `programEmitted` names a
 *  helper that emitStruct.ts / emitHandle.ts defines directly in the
 *  output. Both forms carry the C-side identifier the codegen calls. */
export type SnippetActivation =
  | { kind: "registered"; name: string }
  | { kind: "programEmitted"; name: string };

const r = (name: string): SnippetActivation => ({ kind: "registered", name });
const p = (name: string): SnippetActivation => ({
  kind: "programEmitted",
  name,
});

/** Names of the runtime-helper snippets a single owned kind needs.
 *  Every field is a `SnippetActivation`; call sites activate it via
 *  `useSnippet` and read `helper.name` to emit the C call.
 *
 *  Text kinds (string / char array) leave `disp` undefined — `Disp`
 *  codegen routes them through `mtoc_disp_text` via a text view, a
 *  different argument shape from the by-struct disp helpers tensors
 *  use. Callers must check `isText` first or accept that ownedOps
 *  may surface `disp === undefined`. */
export interface OwnedKindOps {
  /** C type used to declare and pass the value. */
  cType: string;
  /** Snippet activation for the typedef. */
  structSnippet: SnippetActivation;
  /** Helper that produces a known-empty handle (predeclaration default). */
  empty: SnippetActivation;
  /** Helper that releases the backing buffer in place. Idempotent on
   *  an already-empty / -freed handle. */
  free: SnippetActivation;
  /** Helper that consume-replaces the LHS, freeing its prior buffer
   *  and installing the RHS in one call. */
  assign: SnippetActivation;
  /** Helper for a deep copy of a value of this kind. May depend
   *  on the value's MType (real vs complex tensor, etc.). */
  copy: (ty: MType) => SnippetActivation;
  /** Helper for `disp` of a value of this kind. Absent for text
   *  kinds — those route through `mtoc_disp_text` (see header). */
  disp?: (ty: MType) => SnippetActivation;
}

const STRING_OPS: OwnedKindOps = {
  cType: "mtoc_string_t",
  structSnippet: r("mtoc_string_t"),
  empty: r("mtoc_string_empty"),
  free: r("mtoc_string_free"),
  assign: r("mtoc_string_assign"),
  copy: () => r("mtoc_string_copy"),
};

const CHAR_TENSOR_OPS: OwnedKindOps = {
  cType: "mtoc_char_tensor_t",
  structSnippet: r("mtoc_char_tensor_t"),
  empty: r("mtoc_char_tensor_empty"),
  free: r("mtoc_char_tensor_free"),
  assign: r("mtoc_char_tensor_assign"),
  copy: () => r("mtoc_char_tensor_copy"),
};

const DOUBLE_TENSOR_OPS: OwnedKindOps = {
  cType: "mtoc_tensor_t",
  structSnippet: r("mtoc_tensor_t"),
  empty: r("mtoc_tensor_empty"),
  free: r("mtoc_tensor_free"),
  assign: r("mtoc_tensor_assign"),
  copy: ty =>
    r(
      isNumeric(ty) && ty.isComplex
        ? "mtoc_tensor_copy_complex"
        : "mtoc_tensor_copy"
    ),
  disp: ty =>
    r(
      isNumeric(ty) && ty.isComplex
        ? "mtoc_disp_tensor_complex"
        : "mtoc_disp_tensor"
    ),
};

/** Resolve the owned-kind ops for a given MType. Returns null for
 *  non-owned types — scalars, Void, Unknown — so callers can early-out
 *  without a redundant `isOwned` check. The dispatch order mirrors the
 *  predicate order used in the prior hand-rolled chains: string first,
 *  then char-array, then any multi-element double tensor. */
export function ownedOps(ty: MType): OwnedKindOps | null {
  if (isString(ty)) return STRING_OPS;
  if (isCharArray(ty)) return CHAR_TENSOR_OPS;
  if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
    return DOUBLE_TENSOR_OPS;
  }
  if (isStruct(ty)) {
    const name = structMangledName(ty);
    // Helpers are emitted by `emitStruct.ts` directly into the output
    // (one set per distinct struct shape). They are flagged as
    // `programEmitted` so `useSnippet` is a no-op — the typedef +
    // helper definitions are guaranteed in scope by the same emit pass.
    return {
      cType: name,
      structSnippet: p(name),
      empty: p(`${name}_empty`),
      free: p(`${name}_free`),
      assign: p(`${name}_assign`),
      copy: () => p(`${name}_copy`),
      disp: () => p(`${name}_disp`),
    };
  }
  if (isHandle(ty)) {
    const name = handleMangledName(ty);
    // Same shape as struct: helpers are emitted by `emitHandle.ts`
    // directly into the output (one set per distinct capture-tuple
    // shape; one shared set for the no-capture case). No `disp`
    // helper — `disp(h)` is rejected at lowering (no byte-for-byte
    // numbl format to match).
    return {
      cType: name,
      structSnippet: p(name),
      empty: p(`${name}_empty`),
      free: p(`${name}_free`),
      assign: p(`${name}_assign`),
      copy: () => p(`${name}_copy`),
    };
  }
  if (isTupleCell(ty)) {
    const name = tupleCellMangledName(ty);
    // Tuple cells follow the struct pattern: helpers emitted by
    // `emitTupleCell.ts` directly into the output (one set per
    // distinct slot-type tuple shape). `disp` matches numbl's
    // `formatCell` byte-for-byte (single line `{e1, e2, ...}`).
    return {
      cType: name,
      structSnippet: p(name),
      empty: p(`${name}_empty`),
      free: p(`${name}_free`),
      assign: p(`${name}_assign`),
      copy: () => p(`${name}_copy`),
      disp: () => p(`${name}_disp`),
    };
  }
  if (isHomogeneousCell(ty)) {
    const name = homogeneousCellMangledName(ty);
    // Homogeneous cells follow the per-elem-shape pattern: helpers
    // emitted by `emitHomogeneousCell.ts` directly into the output
    // (one set per distinct element MType). The struct holds
    // `{data, len}`; helpers free the buffer, deep-copy the
    // elements, etc. `disp` also matches numbl's `formatCell`.
    return {
      cType: name,
      structSnippet: p(name),
      empty: p(`${name}_empty`),
      free: p(`${name}_free`),
      assign: p(`${name}_assign`),
      copy: () => p(`${name}_copy`),
      disp: () => p(`${name}_disp`),
    };
  }
  return null;
}
