import type { Span } from "../parser/index.js";

/**
 * Raised when the input MATLAB program uses a construct mtoc does not
 * yet support. Carries a Span so the CLI can print a useful pointer.
 */
export class UnsupportedConstruct extends Error {
  readonly span: Span | null;

  constructor(message: string, span: Span | null = null) {
    super(message);
    this.name = "UnsupportedConstruct";
    this.span = span;
  }
}

/** Raised when the program is well-formed MATLAB but inconsistent for static codegen. */
export class TypeError extends Error {
  readonly span: Span | null;

  constructor(message: string, span: Span | null = null) {
    super(message);
    this.name = "TypeError";
    this.span = span;
  }
}
