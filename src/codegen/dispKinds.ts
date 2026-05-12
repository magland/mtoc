/**
 * `disp` codegen registry — picks the C helper that prints a value of
 * a given MType. One entry per ValueShape:
 *
 *   - text  (string / char array) → `mtoc_disp_text` via a `mtoc_text_view_t`
 *   - tensor (multi-element double, real or complex) → `mtoc_disp_tensor`
 *     / `mtoc_disp_tensor_complex`
 *   - scalar char   → `mtoc_disp_char`
 *   - scalar real   → `mtoc_disp_double`
 *   - scalar complex → `mtoc_disp_complex`
 *
 * Centralizing the dispatch keeps the `Disp` codegen arm a single line
 * and gives upcoming value kinds (cell arrays, structs, classes) one
 * place to register their `disp` lowering. The shape order in
 * `dispEmitterFor` mirrors the prior hand-rolled chain: text first
 * (so char arrays don't fall into the owned-tensor arm), then owned
 * tensors, then scalars.
 */

import {
  isCharScalar,
  isMultiElement,
  isNumeric,
  isScalarComplex,
  isScalarReal,
  isText,
  type MType,
} from "../lowering/types.js";
import { wrapTextView } from "./emitExpr.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";

/** Render one `disp(<value>)` call at indentation `level` from the
 *  already-emitted C expression `c`. Implementations activate any
 *  runtime helper they need via `state.useRuntime` and emit exactly
 *  one statement line via `pushStmt`. */
export type DispEmitter = (state: EmitState, level: number, c: string) => void;

/** Resolve the `disp` emitter for `ty`, or `null` when codegen has no
 *  handler for this value shape (caller raises an internal-error). */
export function dispEmitterFor(ty: MType): DispEmitter | null {
  // Text first — char arrays would otherwise be claimed by the owned-
  // tensor arm via `ownedOps`, whose `disp` is intentionally absent on
  // text kinds (their arg shape is `mtoc_text_view_t`, not the struct).
  if (isText(ty)) {
    return (state, level, c) => {
      useRuntimeByName(state, "mtoc_disp_text");
      const view = wrapTextView(state, ty, c);
      pushStmt(state, level, `mtoc_disp_text(${view});`);
    };
  }
  const owned = ownedOps(ty);
  if (owned !== null && owned.disp !== undefined) {
    const helper = owned.disp(ty);
    return (state, level, c) => {
      useRuntimeByName(state, owned.structSnippet);
      useRuntimeByName(state, helper);
      pushStmt(state, level, `${helper}(${c});`);
    };
  }
  if (isCharScalar(ty)) {
    return (state, level, c) => {
      useRuntimeByName(state, "mtoc_disp_char");
      pushStmt(state, level, `mtoc_disp_char(${c});`);
    };
  }
  if (isScalarReal(ty)) {
    return (state, level, c) => {
      useRuntimeByName(state, "mtoc_disp_double");
      // Non-variadic call — `int` operands auto-promote to `double`,
      // so no manual cast is needed (unlike `printf("%g", ...)`).
      pushStmt(state, level, `mtoc_disp_double(${c});`);
    };
  }
  if (isScalarComplex(ty)) {
    return (state, level, c) => {
      useRuntimeByName(state, "mtoc_disp_complex");
      pushStmt(state, level, `mtoc_disp_complex(${c});`);
    };
  }
  // Defensive: a multi-element non-text non-owned type would land here
  // (e.g. a future logical tensor). `isNumeric && isMultiElement`
  // catches that and forces the caller down the no-handler path so the
  // throw site can give a useful message.
  void isNumeric;
  void isMultiElement;
  return null;
}
