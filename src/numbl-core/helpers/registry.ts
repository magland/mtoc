/**
 * MTOC-OWNED SHIM (not synced from numbl).
 *
 * Bridges the vendored `loweringContext.ts` to mtoc's builtin
 * registry. Numbl's real `helpers/registry.ts` is a large catalog of
 * runtime-bound helpers; the vendored lowering context only consumes
 * `getAllBuiltinNames()` to seed `FunctionIndex.builtins`, so we
 * delegate to mtoc's own builtin-name list.
 */

import { allBuiltinNames } from "../../workspace/builtins.js";

export function getAllBuiltinNames(): string[] {
  return [...allBuiltinNames()];
}
