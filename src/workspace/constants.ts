/**
 * Built-in scalar constants. Mirrors numbl's `BUILTIN_CONSTANTS`
 * (numbl/src/numbl-core/lowering/constants.ts) but resolves each name
 * to a concrete numeric value plus a static sign so the rest of the
 * type system can reason about them.
 *
 * Standalone `i`/`j` are not included — MATLAB treats them as the
 * imaginary unit, and mtoc has no complex support yet, so they would
 * produce an error if encountered.
 */

import type { Sign } from "../lowering/types.js";

export interface ConstantEntry {
  /** JS numeric value the constant resolves to. Plugged in as a NumLit. */
  value: number;
  /** Sign known statically. Drives downstream domain checks. */
  sign: Sign;
}

export const BUILTIN_CONSTANTS: ReadonlyMap<string, ConstantEntry> = new Map<
  string,
  ConstantEntry
>([
  ["pi", { value: Math.PI, sign: "positive" }],
  ["eps", { value: Number.EPSILON, sign: "positive" }],
  ["Inf", { value: Infinity, sign: "positive" }],
  ["inf", { value: Infinity, sign: "positive" }],
  ["NaN", { value: NaN, sign: "unknown" }],
  ["nan", { value: NaN, sign: "unknown" }],
  // MATLAB's `realmax`/`realmin` (default double precision).
  ["realmax", { value: Number.MAX_VALUE, sign: "positive" }],
  ["realmin", { value: 2 ** -1022, sign: "positive" }],
  // Logical literals are still scalar doubles (MATLAB convention: 1/0).
  ["true", { value: 1, sign: "positive" }],
  ["false", { value: 0, sign: "zero" }],
]);

export function getConstant(name: string): ConstantEntry | undefined {
  return BUILTIN_CONSTANTS.get(name);
}
