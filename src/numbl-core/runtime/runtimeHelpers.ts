/**
 * MTOC-OWNED SHIM (not synced from numbl).
 *
 * The vendored function resolver (`../functionResolve.ts`) imports
 * `CallSite` from this path. Numbl's real `runtime/runtimeHelpers.ts`
 * is ~1500 lines of runtime-value plumbing that mtoc has no use for,
 * so we surface only the `CallSite` type here.
 *
 * KEEP IN SYNC with numbl's `numbl-core/runtime/runtimeHelpers.ts`
 * `CallSite` declaration (around the `export type CallSite = { ... }`
 * line). If numbl changes the shape, TypeScript will fail at the
 * vendored resolver's call sites in mtoc — that's the signal to
 * update this shim.
 */

export type CallSite = {
  file: string;
  className?: string;
  methodName?: string;
  targetClassName?: string;
};
