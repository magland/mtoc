/**
 * Index-read lowering: `v(i)` / `M(i, j)` / `v(end)` / `M(end, end)`.
 *
 * The lowerer reaches this helper from `lowerFuncCall` whenever the
 * `name` of a `FuncCall` resolves to a variable in scope (MATLAB's
 * "workspace shadows functions" rule). Today only scalar reads are
 * supported — every index expression must lower to a real scalar; a
 * range or colon index belongs on a future `IndexSlice` IR node.
 *
 * For each index slot the helper pushes an `end` context onto the
 * Lowerer's `endStack` so an `end` token inside the slot resolves
 * to the right axis size of the base. Linear (one-index) addressing
 * resolves `end` to `numel(base)`; 2D (two-index) addressing
 * resolves slot 0 to `rows(base)` and slot 1 to `cols(base)`,
 * matching MATLAB semantics.
 */

import type { Expr, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr } from "./ir.js";
import {
  isMultiElement,
  isNumeric,
  isScalar,
  isScalarReal,
  scalarChar,
  scalarComplex,
  scalarDouble,
  typeToString,
  type MType,
} from "./types.js";
import type { Lowerer } from "./lower.js";

/** Lower an index-read of an in-scope variable.
 *
 *  - 1 index  → linear addressing into a multi-element tensor.
 *  - 2 indices → 2D row/col addressing; valid for any multi-element shape.
 *  - 0 or >2 indices → rejected with a span.
 *  - Indexing a scalar (MATLAB's `x(1)` returning `x`) is deferred. */
export function lowerIndexLoad(
  this: Lowerer,
  name: string,
  argExprs: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  const baseTy = this.envLookup(name);
  if (baseTy === undefined) {
    throw new UnsupportedConstruct(
      `internal: lowerIndexLoad called for '${name}' which is not in scope`,
      span
    );
  }
  if (!isNumeric(baseTy)) {
    throw new UnsupportedConstruct(
      `indexing into ${typeToString(baseTy)} is not yet supported`,
      span
    );
  }
  if (isScalar(baseTy)) {
    // MATLAB allows `x(1)` for a scalar (returning x), but the static
    // codegen path for scalars doesn't carry an addressable buffer.
    // Defer until there's a concrete need.
    throw new UnsupportedConstruct(
      `indexing into a scalar variable '${name}' is not yet supported`,
      span
    );
  }
  if (!isMultiElement(baseTy)) {
    throw new UnsupportedConstruct(
      `cannot index variable '${name}' with type ${typeToString(baseTy)}`,
      span
    );
  }
  if (argExprs.length === 0) {
    throw new UnsupportedConstruct(
      `indexing '${name}' requires at least one index`,
      span
    );
  }
  const ndim = baseTy.dims.length;
  if (argExprs.length !== 1 && argExprs.length !== ndim) {
    throw new UnsupportedConstruct(
      `${argExprs.length}-index access into a ${ndim}-D tensor is not yet ` +
        `supported (use 1 linear index or ${ndim} per-axis indices)`,
      span
    );
  }
  // Char tensors stay 2-D-only; the codegen for `<char>.data[offset]`
  // only emits the 2-D fast path. Reject higher-dim char up front
  // (today the type system can't produce one anyway, but the guard
  // documents the assumption).
  if (baseTy.elem === "char" && ndim > 2) {
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
    ty: baseTy,
    span,
  };

  const indices: IRExpr[] = [];
  const numSlots = argExprs.length;
  for (let slot = 0; slot < numSlots; slot++) {
    const axis: number | "linear" = numSlots === 1 ? "linear" : slot;
    this.endStack.push({ baseCName, baseTy, axis });
    let lowered: IRExpr;
    try {
      lowered = this.lowerExpr(argExprs[slot]);
    } finally {
      this.endStack.pop();
    }
    if (!isScalarReal(lowered.ty)) {
      throw new TypeError(
        `index ${slot + 1} of '${name}' must be a real scalar ` +
          `(got ${typeToString(lowered.ty)}); range and colon indices are ` +
          `not yet supported`,
        argExprs[slot].span
      );
    }
    indices.push(lowered);
  }

  // Result type tracks the base's element kind / complexity. Sign is
  // unknown — the indexed element is one specific value out of a
  // tensor whose per-element sign we don't track.
  const resultTy: MType =
    baseTy.elem === "char"
      ? scalarChar()
      : baseTy.isComplex
        ? scalarComplex()
        : scalarDouble("unknown");

  return {
    kind: "IndexLoad",
    base,
    indices,
    ty: resultTy,
    span,
  };
}
