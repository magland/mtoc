/**
 * Pure C-formatting helpers used by the codegen.
 *
 * Everything in this file is a pure function (or a const lookup table)
 * — no `EmitState`, no side effects. Splitting these out of `emit.ts`
 * keeps the rest of the codegen focused on emission logic; these
 * routines almost never need to change as the IR grows.
 */

import { BinaryOperation, UnaryOperation } from "../parser/index.js";

/** Render a numbl string-literal value as a C string-literal token,
 *  including the surrounding double quotes. UTF-8 bytes pass through;
 *  the C-side escape rules are minimal — the code units that need
 *  escaping in a C string are `"`, `\`, and the non-printable controls
 *  (`\n`, `\r`, `\t`, plus everything `< 0x20`). Anything ≥ 0x80 is
 *  emitted verbatim (assuming UTF-8 source); the C compiler accepts
 *  arbitrary bytes inside string literals. */
export function formatStringLit(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x22) {
      out += '\\"';
    } else if (ch === 0x5c) {
      out += "\\\\";
    } else if (ch === 0x0a) {
      out += "\\n";
    } else if (ch === 0x0d) {
      out += "\\r";
    } else if (ch === 0x09) {
      out += "\\t";
    } else if (ch < 0x20 || ch === 0x7f) {
      // Octal escape so the next character is unambiguous (a hex
      // escape would chain into a following hex digit).
      out += `\\${(ch >>> 6).toString(8)}${((ch >>> 3) & 7).toString(8)}${(
        ch & 7
      ).toString(8)}`;
    } else {
      // Pass-through. JS strings are UTF-16; for code points >= 0x80
      // we emit each UTF-16 code unit's bytes via the source-level
      // encoding the file has on disk. `value` came in as a JS string
      // (UTF-16 code units), so charCodeAt(i) here is the actual code
      // unit. For ASCII-clean strings (the common case) this is fine.
      // Multi-byte UTF-8 inputs from the parser preserve their byte
      // sequence as JS chars when the source was decoded as UTF-8.
      out += value[i];
    }
  }
  out += '"';
  return out;
}

/** Byte length of a numbl string-literal value as it will end up at
 *  runtime. The lowerer's `value` field already holds the decoded
 *  string (quotes stripped, doubled-quote escapes collapsed). The
 *  byte length is the UTF-8 byte count; we approximate by computing
 *  the JS-side encoded byte count, which matches for well-formed
 *  UTF-16. */
export function stringLitByteLen(value: string): number {
  // TextEncoder is available in Node and the browser. Emitter runs
  // in both via the bundled translator, so fall back to a manual
  // computation if it's missing (unlikely).
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    let n = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      if (ch < 0x80) n += 1;
      else if (ch < 0x800) n += 2;
      else n += 3;
    }
    return n;
  }
}

/** Format a single char code unit as a C char literal, e.g. `'a'`,
 *  `'\n'`, `'\''`. `ch` is a one-character string from the decoded
 *  numbl char literal value (quotes stripped, `''` collapsed). */
export function formatCharLit(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0x27) return "'\\''"; // single quote
  if (code === 0x5c) return "'\\\\'"; // backslash
  if (code === 0x0a) return "'\\n'";
  if (code === 0x0d) return "'\\r'";
  if (code === 0x09) return "'\\t'";
  if (code < 0x20 || code === 0x7f) {
    // Octal escape — unambiguous before a following digit.
    return `'\\${(code >>> 6).toString(8)}${((code >>> 3) & 7).toString(8)}${(code & 7).toString(8)}'`;
  }
  return `'${ch}'`;
}

export function formatNumLit(n: number): string {
  if (Number.isNaN(n)) return "NAN";
  if (n === Infinity) return "INFINITY";
  if (n === -Infinity) return "(-INFINITY)";
  const s = String(n);
  // Force a `double` literal: append `.0` only when the JS string lacks
  // both a decimal point and an exponent (e.g. "12" → "12.0", but
  // "1.5" and "1e+308" stay as-is — adding ".0" to those is invalid C).
  if (!/[.eE]/.test(s)) {
    return `${s}.0`;
  }
  return s;
}

export const BIN_OP_C: Partial<Record<BinaryOperation, string>> = {
  Add: "+",
  Sub: "-",
  Mul: "*",
  Div: "/",
  ElemMul: "*",
  ElemDiv: "/",
  Equal: "==",
  NotEqual: "!=",
  Less: "<",
  LessEqual: "<=",
  Greater: ">",
  GreaterEqual: ">=",
  AndAnd: "&&",
  OrOr: "||",
  // numbl's elementwise `&` / `|` are non-short-circuit, but since
  // mtoc's IR Binary operands are pure values (no IR-level side
  // effects), `a && b` / `a || b` in C produces the same 0/1 result
  // and auto-promotes to `double` when assigned. The matching
  // entries in `precedence` / `CMP_OR_LOGICAL` route them through
  // the same scalar / complex / per-slot paths as the boolean
  // operators above.
  BitAnd: "&&",
  BitOr: "||",
};

export const UN_OP_C: Partial<Record<UnaryOperation, string>> = {
  Plus: "+",
  Minus: "-",
  Not: "!",
};

/** Higher number = tighter binding. parentPrec=0 means no parens by default. */
export function precedence(op: BinaryOperation | UnaryOperation): number {
  switch (op) {
    case "OrOr":
    case "BitOr":
      return 1;
    case "AndAnd":
    case "BitAnd":
      return 2;
    case "Equal":
    case "NotEqual":
      return 3;
    case "Less":
    case "LessEqual":
    case "Greater":
    case "GreaterEqual":
      return 4;
    case "Add":
    case "Sub":
      return 5;
    case "Mul":
    case "Div":
    case "ElemMul":
    case "ElemDiv":
      return 6;
    case "Pow":
    case "ElemPow":
      return 7;
    case "Plus":
    case "Minus":
    case "Not":
      return 8;
  }
  return 0;
}

/** Binary ops that take the complex-aware branch in `emitExpr.Binary`
 *  whenever any operand is complex. (Arithmetic ops use C99's native
 *  complex operators, so they don't need this re-routing.) */
export const CMP_OR_LOGICAL: ReadonlySet<BinaryOperation> =
  new Set<BinaryOperation>([
    BinaryOperation.Less,
    BinaryOperation.LessEqual,
    BinaryOperation.Greater,
    BinaryOperation.GreaterEqual,
    BinaryOperation.Equal,
    BinaryOperation.NotEqual,
    BinaryOperation.AndAnd,
    BinaryOperation.OrOr,
    BinaryOperation.BitAnd,
    BinaryOperation.BitOr,
  ]);
