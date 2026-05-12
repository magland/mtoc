/**
 * Slice read/write codegen helpers.
 *
 * - `emitIndexSliceAssign`: emit a range/colon/scalar-mix indexed read
 *   (`target = base(a:b)`).
 * - `emitIndexSliceStore`: emit a range/colon/scalar-mix indexed write
 *   (`base(slice) = rhs`).
 * - `emitSliceSlotSetup` / `emitSingleSlotSliceRead` /
 *   `emitMultiSlotSliceRead` / `emitMultiSlotSliceStore` /
 *   `formatNdOffset`: internal helpers.
 *
 * Scalar IndexStore / IndexLoad offsets live in `emitExpr.emitNdScalarOffset`
 * — that one path serves IndexLoad, IndexStore (via emitStmt), and any
 * future scalar-index consumer.
 */

import type { IRExpr, IRStmt, IndexSliceArg } from "../lowering/ir.js";
import {
  isColVec,
  isNumeric,
  isRowVec,
  isScalar,
  typeToString,
  type NumericType,
} from "../lowering/types.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import { emitExpr, tensorColsField, tensorRowsField } from "./emitExpr.js";
import { formatNumLit } from "./emitFormat.js";

/** Emit a range/colon/scalar-mix indexed read: `target = base(a:b)`,
 *  `target = base(:)`, `target = base(:, j)`, … . The slice
 *  allocates a fresh result tensor sized by the slice's per-axis
 *  counts, fills it via nested counted loops, and consume-replaces
 *  the target.
 *
 *  Two emission paths:
 *    - `index.length === 1`: single-slot linear indexing; preserves
 *      the legacy 2-D byte-for-byte emission shape (used by every
 *      `v(:)` / `v(a:b)` form).
 *    - `index.length > 1`  : multi-slot per-axis indexing. The slice
 *      shape is one axis per slot; loops nest with slot 0 innermost
 *      (column-major source + destination linearization).
 *
 *  For complex bases the result is a complex tensor; the codegen
 *  copies both `.real` and `.imag` per slot. Char slices are
 *  rejected at lowering, so this function only handles double. */
export function emitIndexSliceAssign(
  state: EmitState,
  level: number,
  target: string,
  rhs: Extract<IRExpr, { kind: "IndexSlice" }>
): void {
  const base = rhs.base;
  const baseTy = base.ty;
  if (!isNumeric(baseTy) || baseTy.elem !== "double") {
    throw new Error(
      `codegen internal: emitIndexSliceAssign called with non-double base ` +
        `(${typeToString(baseTy)}); should have been rejected at lowering`
    );
  }
  const isComplex = baseTy.isComplex;
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");

  if (rhs.index.length === 1) {
    emitSingleSlotSliceRead(state, level, target, rhs, base, baseTy, isComplex);
    return;
  }
  emitMultiSlotSliceRead(state, level, target, rhs, base, baseTy, isComplex);
}

/** Single-slot slice read (`v(:)`, `v(a:b)`, `v(a:s:b)`). Preserves
 *  the legacy 2-D-only emission shape: 2-D `mtoc_tensor_alloc(rows,
 *  cols)`, one flat `for (k …)` loop, byte-for-byte stable so vitest
 *  expectations keep matching. */
function emitSingleSlotSliceRead(
  state: EmitState,
  level: number,
  target: string,
  rhs: Extract<IRExpr, { kind: "IndexSlice" }>,
  base: Extract<IRExpr, { kind: "Var" }>,
  baseTy: NumericType,
  isComplex: boolean
): void {
  const allocHelper = isComplex
    ? "mtoc_tensor_alloc_complex"
    : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);
  const slot = rhs.index[0];

  pushStmt(state, level, `{`);

  let count: string;
  let srcIndexFor: (kVar: string) => string;
  let resultRows: string;
  let resultCols: string;

  if (slot.kind === "Colon") {
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = ${base.cName}.${tensorRowsField(baseTy)} * ` +
        `${base.cName}.${tensorColsField(baseTy)};`
    );
    count = "_mtoc_n";
    srcIndexFor = k => k;
    resultRows = "_mtoc_n";
    resultCols = "1";
  } else if (slot.kind === "Range") {
    if (slot.step.kind !== "NumLit") {
      throw new Error(
        "codegen internal: IndexSlice range step must be a NumLit; " +
          "should have been caught at lowering"
      );
    }
    useRuntimeByName(state, "mtoc_loop_count");
    const startStr = emitExpr(state, slot.start, 0);
    const endStr = emitExpr(state, slot.end, 0);
    const stepStr = formatNumLit(slot.step.value);
    pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
    pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = mtoc_loop_count(_mtoc_start, _mtoc_end, ${stepStr});`
    );
    count = "_mtoc_n";
    srcIndexFor = k => `(long)(_mtoc_start + ${stepStr} * (double)${k}) - 1L`;
    if (isRowVec(baseTy)) {
      resultRows = "1";
      resultCols = "_mtoc_n";
    } else if (isColVec(baseTy)) {
      resultRows = "_mtoc_n";
      resultCols = "1";
    } else {
      resultRows = "1";
      resultCols = "_mtoc_n";
    }
    state.needMath.value = true;
  } else {
    // Single-slot Scalar should have routed through IndexLoad.
    throw new Error(
      "codegen internal: single-slot IndexSlice with Scalar slot; " +
        "should have been routed to IndexLoad at lowering"
    );
  }

  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t _mtoc_t = ${allocHelper}(${resultRows}, ${resultCols});`
  );
  pushStmt(
    state,
    level + 1,
    `for (long _mtoc_k = 0; _mtoc_k < ${count}; _mtoc_k++) {`
  );
  const srcIdx = srcIndexFor("_mtoc_k");
  pushStmt(
    state,
    level + 2,
    `_mtoc_t.real[_mtoc_k] = ${base.cName}.real[${srcIdx}];`
  );
  if (isComplex) {
    pushStmt(
      state,
      level + 2,
      `_mtoc_t.imag[_mtoc_k] = ${base.cName}.imag[${srcIdx}];`
    );
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(state, level + 1, `mtoc_tensor_assign(&${target}, _mtoc_t);`);
  pushStmt(state, level, `}`);
}

/** Multi-slot slice read: one result axis per slot, loops nest with
 *  slot 0 innermost (column-major both source and destination). The
 *  result is allocated via `mtoc_tensor_alloc_nd` uniformly. */
function emitMultiSlotSliceRead(
  state: EmitState,
  level: number,
  target: string,
  rhs: Extract<IRExpr, { kind: "IndexSlice" }>,
  base: Extract<IRExpr, { kind: "Var" }>,
  _baseTy: NumericType,
  isComplex: boolean
): void {
  const allocHelper = isComplex
    ? "mtoc_tensor_alloc_nd_complex"
    : "mtoc_tensor_alloc_nd";
  useRuntimeByName(state, allocHelper);
  const baseCName = base.cName;
  const ndim = rhs.index.length;

  pushStmt(state, level, `{`);

  const slotSrc = emitSliceSlotSetup(state, level + 1, rhs.index, baseCName);

  // The result type's `dims.length` is the post-normalization rank
  // (trailing singletons stripped, but with a 2-axis minimum). The
  // allocator takes that rank and the corresponding first prefix of
  // the per-slot counts. Trailing scalar slots collapse out cleanly:
  // their `_mtoc_n_i = 1` is dropped from the dims list, and the
  // destination-offset formula's `_mtoc_k_i = 0` term zeroes out.
  if (!isNumeric(rhs.ty)) {
    throw new Error(
      `codegen internal: IndexSlice result has non-numeric type ` +
        `${typeToString(rhs.ty)}`
    );
  }
  const resultRank = Math.max(2, rhs.ty.dims.length);
  const dimsList: string[] = [];
  for (let i = 0; i < resultRank; i++) {
    dimsList.push(i < ndim ? `_mtoc_n_${i}` : `1L`);
  }
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t _mtoc_t = ${allocHelper}(${resultRank}, (long[]){${dimsList.join(", ")}});`
  );

  // Nested loops, slot 0 innermost.
  for (let i = ndim - 1; i >= 0; i--) {
    pushStmt(
      state,
      level + 1 + (ndim - 1 - i),
      `for (long _mtoc_k_${i} = 0; _mtoc_k_${i} < _mtoc_n_${i}; _mtoc_k_${i}++) {`
    );
  }
  const inner = level + 1 + ndim;
  pushStmt(
    state,
    inner,
    `long _mtoc_src_off = ${formatNdOffset(slotSrc, i => `${baseCName}.dims[${i}]`)};`
  );
  pushStmt(
    state,
    inner,
    `long _mtoc_dst_off = ${formatNdOffset(
      Array.from({ length: ndim }, (_, i) => `_mtoc_k_${i}`),
      i => `_mtoc_n_${i}`
    )};`
  );
  pushStmt(
    state,
    inner,
    `_mtoc_t.real[_mtoc_dst_off] = ${baseCName}.real[_mtoc_src_off];`
  );
  if (isComplex) {
    pushStmt(
      state,
      inner,
      `_mtoc_t.imag[_mtoc_dst_off] = ${baseCName}.imag[_mtoc_src_off];`
    );
  }
  for (let i = ndim - 1; i >= 0; i--) {
    pushStmt(state, level + 1 + (ndim - 1 - i), `}`);
  }
  pushStmt(state, level + 1, `mtoc_tensor_assign(&${target}, _mtoc_t);`);
  pushStmt(state, level, `}`);
}

/** Compute the column-major linear offset `sum_i a_i * prod(s_0..s_{i-1})`
 *  given per-slot terms `a_i` and a stride-source `stride(j)` that
 *  renders `s_j`. Zero-cost when ndim === 1 (just returns `a_0`).
 *  Helper used by both the source-side and destination-side offset
 *  computations in the multi-slot slice emission. */
function formatNdOffset(
  terms: ReadonlyArray<string>,
  stride: (axisIndex: number) => string
): string {
  const out: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    if (i === 0) {
      out.push(terms[i]);
    } else {
      const strideParts: string[] = [];
      for (let j = 0; j < i; j++) strideParts.push(stride(j));
      out.push(`${terms[i]} * ${strideParts.join(" * ")}`);
    }
  }
  return out.join(" + ");
}

/** Emit per-slot setup for a multi-slot slice (read or write): for
 *  every slot, push `_mtoc_n_<i>` (the iteration count) and any
 *  Range-specific locals (`_mtoc_start_<i>`, `_mtoc_end_<i>`) or
 *  Scalar-specific source/dest offset locals. Returns the per-slot
 *  source-index expression (a string in terms of `_mtoc_k_<i>` for
 *  Colon/Range slots, or a precomputed `_mtoc_src_<i>` local for
 *  Scalar slots). The caller drives the loop nesting and assembles
 *  the offset formula via `formatNdOffset`. */
function emitSliceSlotSetup(
  state: EmitState,
  level: number,
  slots: ReadonlyArray<IndexSliceArg>,
  baseCName: string
): string[] {
  const slotSrc: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const kVar = `_mtoc_k_${i}`;
    if (slot.kind === "Colon") {
      pushStmt(state, level, `long _mtoc_n_${i} = ${baseCName}.dims[${i}];`);
      slotSrc.push(kVar);
    } else if (slot.kind === "Scalar") {
      const scalarStr = emitExpr(state, slot.expr, 0);
      pushStmt(state, level, `long _mtoc_n_${i} = 1;`);
      pushStmt(
        state,
        level,
        `long _mtoc_src_${i} = (long)(${scalarStr}) - 1L;`
      );
      slotSrc.push(`_mtoc_src_${i}`);
    } else {
      if (slot.step.kind !== "NumLit") {
        throw new Error(
          "codegen internal: IndexSlice range step must be a NumLit; " +
            "should have been caught at lowering"
        );
      }
      useRuntimeByName(state, "mtoc_loop_count");
      const startStr = emitExpr(state, slot.start, 0);
      const endStr = emitExpr(state, slot.end, 0);
      const stepStr = formatNumLit(slot.step.value);
      pushStmt(state, level, `double _mtoc_start_${i} = ${startStr};`);
      pushStmt(state, level, `double _mtoc_end_${i} = ${endStr};`);
      pushStmt(
        state,
        level,
        `long _mtoc_n_${i} = mtoc_loop_count(_mtoc_start_${i}, _mtoc_end_${i}, ${stepStr});`
      );
      slotSrc.push(
        `((long)(_mtoc_start_${i} + ${stepStr} * (double)${kVar}) - 1L)`
      );
    }
  }
  return slotSrc;
}

/** Emit a range/colon/scalar-mix indexed write: `<base>(slice) = rhs;`.
 *  The base buffer is mutated in place; one slot per loop iteration is
 *  overwritten. For a tensor RHS we emit a runtime count check so a
 *  size mismatch fails loudly instead of silently scribbling past
 *  the end of either buffer.
 *
 *  Single-slot layout (real base, tensor RHS):
 *    {
 *      long _mtoc_n   = <count(slice)>;
 *      long _mtoc_rhs_n = rhs.rows * rhs.cols;
 *      if (_mtoc_n != _mtoc_rhs_n) abort(...);
 *      for (long _mtoc_k = 0; _mtoc_k < _mtoc_n; _mtoc_k++) {
 *        long _mtoc_dst = <dst-offset for k>;
 *        base.real[_mtoc_dst] = rhs.real[_mtoc_k];
 *      }
 *    }
 *
 *  Multi-slot layout: one nested loop per slot (slot 0 innermost,
 *  column-major), the dst offset is computed from each slot's source
 *  index (Colon → k_i, Range → start + step*k_i − 1, Scalar → const
 *  precomputed once before the loop nest), and the tensor-RHS linear
 *  index is `_mtoc_k_0 + _mtoc_k_1 * _mtoc_n_0 + …`.
 *
 *  Complex bases write both .real and .imag; a real RHS into a
 *  complex base zeros .imag per slot. A scalar RHS broadcasts.
 *  See the lowering pass for type-rule pre-checks. */
export function emitIndexSliceStore(
  state: EmitState,
  level: number,
  s: Extract<IRStmt, { kind: "IndexSliceStore" }>
): void {
  if (s.index.length > 1) {
    emitMultiSlotSliceStore(state, level, s);
    return;
  }
  const baseCName = s.base.cName;
  const baseTy = s.base.ty as NumericType;
  const baseIsComplex = baseTy.isComplex;
  const rhsIsScalar = isNumeric(s.rhs.ty) && isScalar(s.rhs.ty);
  const rhsIsComplex = isNumeric(s.rhs.ty) && s.rhs.ty.isComplex;

  pushStmt(state, level, `{`);

  const slot = s.index[0];
  let dstOffsetFor: (kVar: string) => string;
  if (slot.kind === "Colon") {
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = ${baseCName}.${tensorRowsField(baseTy)} * ` +
        `${baseCName}.${tensorColsField(baseTy)};`
    );
    dstOffsetFor = k => k;
  } else if (slot.kind === "Range") {
    if (slot.step.kind !== "NumLit") {
      throw new Error(
        "codegen internal: IndexSliceStore range step must be a NumLit; " +
          "should have been caught at lowering"
      );
    }
    useRuntimeByName(state, "mtoc_loop_count");
    const startStr = emitExpr(state, slot.start, 0);
    const endStr = emitExpr(state, slot.end, 0);
    const stepStr = formatNumLit(slot.step.value);
    pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
    pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = mtoc_loop_count(_mtoc_start, _mtoc_end, ${stepStr});`
    );
    dstOffsetFor = k => `(long)(_mtoc_start + ${stepStr} * (double)${k}) - 1L`;
  } else {
    // Single-slot Scalar should have routed through IndexStore.
    throw new Error(
      "codegen internal: single-slot IndexSliceStore with Scalar slot; " +
        "should have been routed to IndexStore at lowering"
    );
  }

  // Tensor RHS: runtime count check + per-slot read from rhs's buffer.
  // Scalar RHS: emit the rhs expression once and broadcast (the
  // expression is constant across iterations; `(double _Complex)`
  // stashing handles complex without double-evaluating).
  if (rhsIsScalar) {
    const rhsExpr = emitExpr(state, s.rhs, 0);
    if (baseIsComplex && rhsIsComplex) {
      // Complex scalar RHS into complex base: stash to avoid
      // re-evaluating creal/cimag every slot.
      pushStmt(state, level + 1, `double _Complex _mtoc_rhs = ${rhsExpr};`);
      pushStmt(state, level + 1, `double _mtoc_rhs_re = creal(_mtoc_rhs);`);
      pushStmt(state, level + 1, `double _mtoc_rhs_im = cimag(_mtoc_rhs);`);
      pushStmt(
        state,
        level + 1,
        `for (long _mtoc_k = 0; _mtoc_k < _mtoc_n; _mtoc_k++) {`
      );
      pushStmt(
        state,
        level + 2,
        `long _mtoc_dst = ${dstOffsetFor("_mtoc_k")};`
      );
      pushStmt(
        state,
        level + 2,
        `${baseCName}.real[_mtoc_dst] = _mtoc_rhs_re;`
      );
      pushStmt(
        state,
        level + 2,
        `${baseCName}.imag[_mtoc_dst] = _mtoc_rhs_im;`
      );
      pushStmt(state, level + 1, `}`);
    } else {
      // Real scalar RHS — same value broadcast. The `rhsExpr` is
      // evaluated once into a temp so a Call-bearing rhs doesn't
      // re-run per slot.
      pushStmt(state, level + 1, `double _mtoc_rhs = ${rhsExpr};`);
      pushStmt(
        state,
        level + 1,
        `for (long _mtoc_k = 0; _mtoc_k < _mtoc_n; _mtoc_k++) {`
      );
      pushStmt(
        state,
        level + 2,
        `long _mtoc_dst = ${dstOffsetFor("_mtoc_k")};`
      );
      pushStmt(state, level + 2, `${baseCName}.real[_mtoc_dst] = _mtoc_rhs;`);
      if (baseIsComplex) {
        pushStmt(state, level + 2, `${baseCName}.imag[_mtoc_dst] = 0.0;`);
      }
      pushStmt(state, level + 1, `}`);
    }
    pushStmt(state, level, `}`);
    return;
  }

  // Tensor RHS — must already be a Var (lowering doesn't accept a
  // bare TensorLit / IndexSlice in this position; the validator's
  // rejectNestedOwnedExpr ensures only a Var or scalar reaches us).
  if (s.rhs.kind !== "Var") {
    throw new Error(
      `codegen internal: IndexSliceStore RHS must be a scalar or a Var ` +
        `(got ${s.rhs.kind}); should have been caught at lowering / ` +
        `validateIR`
    );
  }
  const rhsCName = s.rhs.cName;
  const rhsTy = s.rhs.ty;
  // Runtime count check — guards against buffer overruns. The
  // diagnostic message matches the style of mtoc_check_shape.
  pushStmt(
    state,
    level + 1,
    `long _mtoc_rhs_n = ${rhsCName}.${tensorRowsField(rhsTy)} * ` +
      `${rhsCName}.${tensorColsField(rhsTy)};`
  );
  pushStmt(state, level + 1, `if (_mtoc_n != _mtoc_rhs_n) {`);
  pushStmt(
    state,
    level + 2,
    `fprintf(stderr, "mtoc: range-write count mismatch: lhs slice has %ld elements, rhs has %ld\\n", _mtoc_n, _mtoc_rhs_n);`
  );
  pushStmt(state, level + 2, `abort();`);
  // abort() requires <stdlib.h>. With includeRuntime:true the header is
  // pulled in transitively by the alloc helper; with includeRuntime:false
  // snippets are stripped so we must mark it explicitly.
  state.needStdlib.value = true;
  pushStmt(state, level + 1, `}`);
  pushStmt(
    state,
    level + 1,
    `for (long _mtoc_k = 0; _mtoc_k < _mtoc_n; _mtoc_k++) {`
  );
  pushStmt(state, level + 2, `long _mtoc_dst = ${dstOffsetFor("_mtoc_k")};`);
  if (baseIsComplex && rhsIsComplex) {
    pushStmt(
      state,
      level + 2,
      `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
    );
    pushStmt(
      state,
      level + 2,
      `${baseCName}.imag[_mtoc_dst] = ${rhsCName}.imag[_mtoc_k];`
    );
  } else if (baseIsComplex) {
    // Real tensor RHS into complex base — write real, zero imag.
    pushStmt(
      state,
      level + 2,
      `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
    );
    pushStmt(state, level + 2, `${baseCName}.imag[_mtoc_dst] = 0.0;`);
  } else {
    pushStmt(
      state,
      level + 2,
      `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
    );
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(state, level, `}`);
}

/** Multi-slot `<base>(slice) = rhs;` write. One nested loop per slot
 *  (slot 0 innermost, column-major). Scalar RHS broadcasts; tensor
 *  RHS is read linearly with a runtime count check against the
 *  product of per-slot counts. */
function emitMultiSlotSliceStore(
  state: EmitState,
  level: number,
  s: Extract<IRStmt, { kind: "IndexSliceStore" }>
): void {
  const baseCName = s.base.cName;
  const baseTy = s.base.ty as NumericType;
  const baseIsComplex = baseTy.isComplex;
  const rhsIsScalar = isNumeric(s.rhs.ty) && isScalar(s.rhs.ty);
  const rhsIsComplex = isNumeric(s.rhs.ty) && s.rhs.ty.isComplex;
  const ndim = s.index.length;

  pushStmt(state, level, `{`);

  const slotDst = emitSliceSlotSetup(state, level + 1, s.index, baseCName);

  // Total slice element count (product of per-slot counts) — used by
  // the tensor-RHS count check and by both branches' linear index.
  const totalParts: string[] = [];
  for (let i = 0; i < ndim; i++) totalParts.push(`_mtoc_n_${i}`);
  pushStmt(state, level + 1, `long _mtoc_n = ${totalParts.join(" * ")};`);

  // RHS preparation.
  let rhsCName: string | null = null;
  if (rhsIsScalar) {
    const rhsExpr = emitExpr(state, s.rhs, 0);
    if (baseIsComplex && rhsIsComplex) {
      pushStmt(state, level + 1, `double _Complex _mtoc_rhs = ${rhsExpr};`);
      pushStmt(state, level + 1, `double _mtoc_rhs_re = creal(_mtoc_rhs);`);
      pushStmt(state, level + 1, `double _mtoc_rhs_im = cimag(_mtoc_rhs);`);
    } else {
      pushStmt(state, level + 1, `double _mtoc_rhs = ${rhsExpr};`);
    }
  } else {
    if (s.rhs.kind !== "Var") {
      throw new Error(
        `codegen internal: IndexSliceStore RHS must be a scalar or a Var ` +
          `(got ${s.rhs.kind}); should have been caught at lowering`
      );
    }
    rhsCName = s.rhs.cName;
    const rhsTy = s.rhs.ty;
    // numel(rhs) — generalized for any-dim tensors.
    let rhsNumel: string;
    if (isNumeric(rhsTy) && rhsTy.elem === "char") {
      rhsNumel = `${rhsCName}.rows * ${rhsCName}.cols`;
    } else if (isNumeric(rhsTy)) {
      const parts: string[] = [];
      for (let j = 0; j < rhsTy.dims.length; j++) {
        parts.push(`${rhsCName}.dims[${j}]`);
      }
      rhsNumel = parts.join(" * ");
    } else {
      throw new Error(
        `codegen internal: IndexSliceStore tensor RHS has non-numeric type ` +
          `${typeToString(rhsTy)}`
      );
    }
    pushStmt(state, level + 1, `long _mtoc_rhs_n = ${rhsNumel};`);
    pushStmt(state, level + 1, `if (_mtoc_n != _mtoc_rhs_n) {`);
    pushStmt(
      state,
      level + 2,
      `fprintf(stderr, "mtoc: range-write count mismatch: lhs slice has %ld elements, rhs has %ld\\n", _mtoc_n, _mtoc_rhs_n);`
    );
    pushStmt(state, level + 2, `abort();`);
    // abort() requires <stdlib.h> — mark explicitly for the no-runtime path.
    state.needStdlib.value = true;
    pushStmt(state, level + 1, `}`);
  }

  // Nested loops, slot 0 innermost.
  for (let i = ndim - 1; i >= 0; i--) {
    pushStmt(
      state,
      level + 1 + (ndim - 1 - i),
      `for (long _mtoc_k_${i} = 0; _mtoc_k_${i} < _mtoc_n_${i}; _mtoc_k_${i}++) {`
    );
  }
  const inner = level + 1 + ndim;
  pushStmt(
    state,
    inner,
    `long _mtoc_dst = ${formatNdOffset(slotDst, j => `${baseCName}.dims[${j}]`)};`
  );
  if (rhsIsScalar) {
    if (baseIsComplex && rhsIsComplex) {
      pushStmt(state, inner, `${baseCName}.real[_mtoc_dst] = _mtoc_rhs_re;`);
      pushStmt(state, inner, `${baseCName}.imag[_mtoc_dst] = _mtoc_rhs_im;`);
    } else if (baseIsComplex) {
      pushStmt(state, inner, `${baseCName}.real[_mtoc_dst] = _mtoc_rhs;`);
      pushStmt(state, inner, `${baseCName}.imag[_mtoc_dst] = 0.0;`);
    } else {
      pushStmt(state, inner, `${baseCName}.real[_mtoc_dst] = _mtoc_rhs;`);
    }
  } else {
    pushStmt(
      state,
      inner,
      `long _mtoc_k = ${formatNdOffset(
        Array.from({ length: ndim }, (_, i) => `_mtoc_k_${i}`),
        j => `_mtoc_n_${j}`
      )};`
    );
    if (baseIsComplex && rhsIsComplex) {
      pushStmt(
        state,
        inner,
        `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
      );
      pushStmt(
        state,
        inner,
        `${baseCName}.imag[_mtoc_dst] = ${rhsCName}.imag[_mtoc_k];`
      );
    } else if (baseIsComplex) {
      pushStmt(
        state,
        inner,
        `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
      );
      pushStmt(state, inner, `${baseCName}.imag[_mtoc_dst] = 0.0;`);
    } else {
      pushStmt(
        state,
        inner,
        `${baseCName}.real[_mtoc_dst] = ${rhsCName}.real[_mtoc_k];`
      );
    }
  }
  for (let i = ndim - 1; i >= 0; i--) {
    pushStmt(state, level + 1 + (ndim - 1 - i), `}`);
  }
  pushStmt(state, level, `}`);
}
