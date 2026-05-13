/**
 * Helpers for working with the parser's raw lexeme strings.
 *
 * The vendored numbl lexer preserves surrounding quotes and doubled-
 * quote escapes on string / char literals; consumers that want the
 * decoded contents use `decodeNumblQuotedLexeme`.
 */

/** Decode a numbl-style quoted literal lexeme (the parser keeps the
 *  surrounding quotes; doubled `""` / `''` collapses to one). Handles
 *  both single- and double-quoted forms; unquoted input passes
 *  through unchanged. Single source of truth — the lowerer, the
 *  struct pre-pass, and the struct constructor all consume this. */
export function decodeNumblQuotedLexeme(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}
