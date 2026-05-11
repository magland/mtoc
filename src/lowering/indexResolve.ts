/**
 * Shared validation helper and predicate for the four index-operation
 * lowering helpers (lowerIndexLoad, lowerIndexStore, lowerIndexSlice,
 * lowerIndexSliceStore).
 *
 * `isSliceArg` lets the dispatchers in lower.ts and lowerFuncCall.ts
 * decide which index path to take without duplicating the predicate.
 *
 * `resolveIndexBase` performs the common preamble shared by all four
 * helpers:
 *  - env lookup (internal UnsupportedConstruct or user-facing TypeError
 *    depending on whether the caller pre-checked envLookup)
 *  - numeric-base check
 *  - optional scalar-base check (read path only)
 *  - multi-element check
 *  - char-array rejection (all but "read", which allows char arrays)
 *  - argument-arity check
 *  - N-D char guard (read path, since char bases are allowed there)
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isMultiElement,
  isNumeric,
  isScalar,
  typeToString,
  type NumericType,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Operation label that selects the operation-specific message text. */
export type IndexOperation = "read" | "write" | "sliceRead" | "sliceWrite";

/** True when an AST expression node is a range or bare colon — the
 *  dispatcher uses this predicate to decide between the IndexLoad /
 *  IndexSlice paths (and between IndexStore / IndexSliceStore on the
 *  write side). Exported so both lower.ts and lowerFuncCall.ts share
 *  a single definition. */
export function isSliceArg(a: Expr): boolean {
  return a.type === "Range" || a.type === "Colon";
}

/**
 * Validate and resolve the base variable for an index operation,
 * returning the resolved type, C name, and pre-built Var IR node.
 *
 * @param name     - numbl variable name being indexed.
 * @param argCount - number of index slots the caller is about to lower.
 * @param span     - overall span of the index expression (used for most
 *   errors and as the default Var-node span).
 * @param opts.baseSpan - span of the base identifier node; used for the
 *   Var IR node and the user-facing "not in scope" TypeError. Defaults
 *   to `span` when omitted (read / sliceRead paths where both are the
 *   same source range).
 * @param opts.allowCharArray - when true (read path), char-array bases
 *   are accepted; N-D (>2-axis) char arrays are still rejected with a
 *   dedicated message.
 * @param opts.notInScope - "internal" when the caller pre-checked
 *   envLookup before dispatching (so a missing binding is a lowerer bug);
 *   "user-facing" when the caller is the statement dispatcher and the
 *   variable could genuinely be undefined at that point.
 * @param opts.operation - selects the operation-specific message text.
 */
export function resolveIndexBase(
  this: Lowerer,
  name: string,
  argCount: number,
  span: Span,
  opts: {
    baseSpan?: Span;
    allowCharArray?: boolean;
    notInScope: "internal" | "user-facing";
    operation: IndexOperation;
  }
): {
  baseTy: NumericType;
  baseCName: string;
  base: Extract<IRExpr, { kind: "Var" }>;
} {
  const {
    baseSpan = span,
    allowCharArray = false,
    notInScope,
    operation,
  } = opts;

  const looked = this.envLookup(name);
  if (looked === undefined) {
    if (notInScope === "internal") {
      const fn = operation === "read" ? "lowerIndexLoad" : "lowerIndexSlice";
      throw new UnsupportedConstruct(
        `internal: ${fn} called for '${name}' which is not in scope`,
        span
      );
    }
    throw new TypeError(`use of undefined variable '${name}'`, baseSpan);
  }

  if (!isNumeric(looked)) {
    throw new UnsupportedConstruct(
      `${opPrefix(operation)} into ${typeToString(looked)} is not yet supported`,
      span
    );
  }

  // The "read" path emits a dedicated "scalar variable" message before
  // the generic multi-element check so the diagnostic names the variable.
  if (operation === "read" && isScalar(looked)) {
    throw new UnsupportedConstruct(
      `indexing into a scalar variable '${name}' is not yet supported`,
      span
    );
  }

  if (!isMultiElement(looked)) {
    throw new UnsupportedConstruct(
      notMultiElementMsg(operation, name, looked),
      span
    );
  }

  if (!allowCharArray && looked.elem === "char") {
    throw new UnsupportedConstruct(
      `${opPrefix(operation)} into a char tensor is not yet supported`,
      span
    );
  }

  const ndim = looked.dims.length;

  // The "read" and "write" paths have an explicit zero-arg message; the
  // "sliceRead" / "sliceWrite" paths fall through to the general arity
  // check whose message already covers the zero case.
  if (argCount === 0 && (operation === "read" || operation === "write")) {
    const msg =
      operation === "read"
        ? `indexing '${name}' requires at least one index`
        : `indexed write requires at least one index`;
    throw new UnsupportedConstruct(msg, span);
  }

  if (argCount !== 1 && argCount !== ndim) {
    throw new UnsupportedConstruct(arityMsg(operation, argCount, ndim), span);
  }

  // N-D char guard — only reachable on the "read" path (allowCharArray=true).
  // The codegen for `<char>.data[offset]` only handles the 2-D fast path;
  // the guard documents that assumption.
  if (allowCharArray && looked.elem === "char" && ndim > 2) {
    throw new UnsupportedConstruct(
      `indexing into an N-D char tensor (ndim > 2) is not yet supported`,
      span
    );
  }

  const baseCName = this.currentCNameFor(name);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: looked,
    span: baseSpan,
  };
  return { baseTy: looked, baseCName, base };
}

// ── Private message helpers ───────────────────────────────────────────

/** The verb prefix that leads each operation's error messages. */
function opPrefix(op: IndexOperation): string {
  switch (op) {
    case "read":
      return "indexing";
    case "write":
      return "indexed write";
    case "sliceRead":
      return "range/colon indexing";
    case "sliceWrite":
      return "range/colon indexed write";
  }
}

function notMultiElementMsg(
  op: IndexOperation,
  name: string,
  baseTy: NumericType
): string {
  switch (op) {
    case "read":
      return `cannot index variable '${name}' with type ${typeToString(baseTy)}`;
    case "write":
      return `indexed write requires a multi-element tensor (got ${typeToString(baseTy)})`;
    case "sliceRead":
      return `range/colon indexing requires a multi-element tensor (got ${typeToString(baseTy)})`;
    case "sliceWrite":
      return `range/colon indexed write requires a multi-element tensor (got ${typeToString(baseTy)})`;
  }
}

function arityMsg(op: IndexOperation, argCount: number, ndim: number): string {
  switch (op) {
    case "read":
      return (
        `${argCount}-index access into a ${ndim}-D tensor is not yet ` +
        `supported (use 1 linear index or ${ndim} per-axis indices)`
      );
    case "write":
      return (
        `${argCount}-index write into a ${ndim}-D tensor is ` +
        `not yet supported (use 1 linear index or ${ndim} per-axis indices)`
      );
    case "sliceRead":
      return (
        `range/colon indexing of a ${ndim}-D tensor requires either 1 slot ` +
        `(linear) or ${ndim} slots (one per axis); got ${argCount}`
      );
    case "sliceWrite":
      return (
        `range/colon indexed write into a ${ndim}-D tensor requires either 1 ` +
        `slot (linear) or ${ndim} slots (one per axis); got ${argCount}`
      );
  }
}
