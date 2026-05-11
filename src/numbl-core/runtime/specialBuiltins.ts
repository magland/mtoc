/**
 * MTOC-OWNED SHIM (not synced from numbl).
 *
 * Re-export of `SPECIAL_BUILTIN_NAMES` so the vendored
 * `loweringContext.ts` import path `./runtime/specialBuiltins.js`
 * resolves. Numbl's real `specialBuiltins.ts` carries the full
 * implementations bound to the runtime; mtoc only needs the name
 * list to seed `FunctionIndex.builtins`.
 */

export { SPECIAL_BUILTIN_NAMES } from "./specialBuiltinNames.js";
