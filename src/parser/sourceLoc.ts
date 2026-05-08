/**
 * Source location helpers used by the parser. Inlined from numbl's
 * runtime/error.ts so the parser has no cross-module dependencies.
 */

/** Compute 1-based line number from a character offset in source text. */
export function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
