/**
 * MTOC-OWNED SHIM (not synced from numbl).
 *
 * Stand-in for numbl's interpreter builtin registry. The vendored
 * `loweringContext.ts` imports `IBuiltin` (type only — used for the
 * registry value type) and `getAllIBuiltinNames()` (used to seed the
 * `FunctionIndex.builtins` set with interpreter-only builtin names).
 *
 * mtoc has no interpreter, so the registry is empty. Concrete numbl
 * IBuiltin entries that aren't also mtoc-generated builtins simply
 * won't appear in mtoc's resolver, and a user call into one will
 * fall through to the standard "unresolved function" path.
 */

export type IBuiltin = unknown;

export function getAllIBuiltinNames(): string[] {
  return [];
}
