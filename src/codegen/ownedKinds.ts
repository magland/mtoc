/**
 * Owned-kind registry — one source of truth for the C-side runtime
 * helpers each owned MType maps to.
 *
 * "Owned" means a value backed by a heap allocation that the generated
 * code is responsible for releasing — strings, multi-element double
 * tensors, multi-element char arrays. The `isOwned` predicate in
 * `lowering/types.ts` is the seed; this registry picks up where it
 * leaves off and answers, for a given owned type, which C helper to
 * call for each role (typedef, empty placeholder, free, assign, copy,
 * disp).
 *
 * Adding a new owned kind (logical-tensor, cell, struct, …) is a
 * single entry plus the matching .h files; every call site that
 * currently switches on `(isString | isCharArray | isMultiElement)` to
 * pick a helper collapses to `ownedOps(ty).<role>`.
 */

import {
  isCharArray,
  isMultiElement,
  isNumeric,
  isString,
  type MType,
} from "../lowering/types.js";

/** Names of the runtime-helper snippets a single owned kind needs.
 *  Every field is a name registered in `RUNTIME_HELPERS` (see
 *  `runtime.ts`); call sites activate via `useRuntimeByName` and emit
 *  the call directly. The `copy` and `disp` slots accept the value's
 *  MType so the registry can pick a complex sibling when it exists
 *  (e.g. `mtoc_tensor_copy_complex`, `mtoc_disp_tensor_complex`).
 *
 *  Text kinds (string / char array) leave `disp` undefined — `Disp`
 *  codegen routes them through `mtoc_disp_text` via a text view, a
 *  different argument shape from the by-struct disp helpers tensors
 *  use. Callers must check `isText` first or accept that ownedOps
 *  may surface `disp === undefined`. */
export interface OwnedKindOps {
  /** C type used to declare and pass the value. */
  cType: string;
  /** Snippet name for the typedef. Activated whenever the C type is
   *  emitted (declarations, function params, function returns). */
  structSnippet: string;
  /** Helper that produces a known-empty handle (predeclaration default). */
  empty: string;
  /** Helper that releases the backing buffer in place. Idempotent on
   *  an already-empty / -freed handle. */
  free: string;
  /** Helper that consume-replaces the LHS, freeing its prior buffer
   *  and installing the RHS in one call. */
  assign: string;
  /** Helper name for a deep copy of a value of this kind. May depend
   *  on the value's MType (real vs complex tensor, etc.). */
  copy: (ty: MType) => string;
  /** Helper name for `disp` of a value of this kind. Absent for text
   *  kinds — those route through `mtoc_disp_text` (see header). */
  disp?: (ty: MType) => string;
}

const STRING_OPS: OwnedKindOps = {
  cType: "mtoc_string_t",
  structSnippet: "mtoc_string_t",
  empty: "mtoc_string_empty",
  free: "mtoc_string_free",
  assign: "mtoc_string_assign",
  copy: () => "mtoc_string_copy",
};

const CHAR_TENSOR_OPS: OwnedKindOps = {
  cType: "mtoc_char_tensor_t",
  structSnippet: "mtoc_char_tensor_t",
  empty: "mtoc_char_tensor_empty",
  free: "mtoc_char_tensor_free",
  assign: "mtoc_char_tensor_assign",
  copy: () => "mtoc_char_tensor_copy",
};

const DOUBLE_TENSOR_OPS: OwnedKindOps = {
  cType: "mtoc_tensor_t",
  structSnippet: "mtoc_tensor_t",
  empty: "mtoc_tensor_empty",
  free: "mtoc_tensor_free",
  assign: "mtoc_tensor_assign",
  copy: ty =>
    isNumeric(ty) && ty.isComplex
      ? "mtoc_tensor_copy_complex"
      : "mtoc_tensor_copy",
  disp: ty =>
    isNumeric(ty) && ty.isComplex
      ? "mtoc_disp_tensor_complex"
      : "mtoc_disp_tensor",
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
  return null;
}
