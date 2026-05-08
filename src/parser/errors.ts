/**
 * Parser error classes.
 */

export class SyntaxError extends Error {
  position: number;
  line: number | null;
  /** Source file name (set when parsing workspace files, or resolved in prepare.ts) */
  file: string | null;
  foundToken: string | null;
  expected: string | null;
  /** 1-based column number (resolved in prepare.ts for non-workspace-file errors) */
  column: number | undefined;

  constructor(
    message: string,
    position: number,
    foundToken: string | null = null,
    expected: string | null = null,
    line: number | null = null
  ) {
    super(message);
    this.name = "SyntaxError";
    this.position = position;
    this.line = line;
    this.file = null;
    this.foundToken = foundToken;
    this.expected = expected;
    this.column = undefined;
  }

  toString(): string {
    let s =
      this.file && this.line !== null
        ? `Syntax error in ${this.file} at line ${this.line}: ${this.message}`
        : this.line !== null
          ? `Syntax error at line ${this.line}: ${this.message}`
          : `Syntax error at position ${this.position}: ${this.message}`;
    if (this.foundToken !== null) {
      s += ` (found: '${this.foundToken}')`;
    }
    if (this.expected !== null) {
      s += ` (expected: ${this.expected})`;
    }
    return s;
  }
}
