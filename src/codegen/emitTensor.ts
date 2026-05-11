/**
 * Tensor-assign codegen helpers.
 *
 * - `emitTensorAssignFromExpr`: elementwise-loop emission for a
 *   multi-element RHS that is not a TensorLit and not a bare Var.
 * - `emitTensorLitAssign`: direct slot-fill emission for a TensorLit RHS.
 * - `findShapeSourceVar` / `findCharLitShapeSource` /
 *   `collectMultiElementVarsByCName`: shape-inference walkers used by
 *   the elementwise-loop emission.
 */

import type { IRExpr } from "../lowering/ir.js";
import {
  isMultiElement,
  isNumeric,
  typeToString,
  type NumericType,
} from "../lowering/types.js";
import { findInExpr, forEachSubExpr } from "../lowering/walk.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import { emitExpr, tensorColsField, tensorRowsField } from "./emitExpr.js";
import { formatNumLit } from "./emitFormat.js";

/** Walk an IR expression and return the first multi-element `Var`
 *  encountered — the "shape source" for an elementwise assign whose
 *  RHS isn't a TensorLit. After the dim coarsening, the assignment-
 *  site allocation reads its size and rows/cols from this Var at
 *  runtime. Returns null if no multi-element Var is reachable; in
 *  practice every multi-element non-TensorLit RHS that the lowerer
 *  accepts contains at least one such Var (TensorLit is rejected
 *  nested, and Calls don't return tensors). */
function findShapeSourceVar(
  e: IRExpr
): Extract<IRExpr, { kind: "Var" }> | null {
  return findInExpr(
    e,
    (sub): sub is Extract<IRExpr, { kind: "Var" }> =>
      sub.kind === "Var" && isMultiElement(sub.ty)
  );
}

/** Walk an IR expression and return the first multi-element CharLit
 *  encountered — the fallback shape-source for elementwise assigns
 *  where the RHS contains no multi-element Var (e.g. `'abc' + 1` or
 *  `'abc' == 'def'`). The CharLit's `.value.length` gives the static
 *  column count; rows are always 1 for char arrays. */
function findCharLitShapeSource(
  e: IRExpr
): Extract<IRExpr, { kind: "CharLit" }> | null {
  return findInExpr(
    e,
    (sub): sub is Extract<IRExpr, { kind: "CharLit" }> =>
      sub.kind === "CharLit" && isMultiElement(sub.ty)
  );
}

/** Walk an IR expression and collect every distinct multi-element
 *  `Var` on its RHS, keyed by C identifier so duplicates collapse
 *  (the canonical `v .* v` case yields a single entry). The walk
 *  order matches `findShapeSourceVar`'s left-first DFS, so the
 *  shape-source picked there is also the first entry in the returned
 *  Map — a nice property for emitting stable shape-check pairs.
 *  Scalars (NumLit, ImagLit, scalar Vars) are skipped: broadcast
 *  handles any shape, so they have nothing to check against. */
function collectMultiElementVarsByCName(
  e: IRExpr,
  out: Map<string, Extract<IRExpr, { kind: "Var" }>>
): void {
  forEachSubExpr(e, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty) && !out.has(sub.cName)) {
      out.set(sub.cName, sub);
    }
  });
}

/** Emit an Assign whose multi-element RHS is NOT a TensorLit and not
 *  a bare Var. Pattern: read shape from a deterministic shape-source
 *  `Var`, allocate a fresh tensor via `mtoc_tensor_alloc{,_complex}`
 *  (so reads from the target inside the body see the OLD buffer —
 *  important when the RHS aliases the target, e.g. `M = M + 1`),
 *  evaluate the body into the staging tensor's slots, then
 *  `mtoc_tensor_assign(&target, _mtoc_t)` to consume-replace the
 *  target. Wrapped in `{}` so the staging local is scoped per
 *  Assign.
 *
 *  Owned-producing sub-expressions (user-func tensor calls,
 *  TensorLit, IndexSlice, string concat) are already hoisted to
 *  their own `_mtoc_anf_<N>` synthetic Assigns by the lowering-pass
 *  ANF normalizer, so by the time we get here the RHS contains only
 *  `Var`, scalar literals, elementwise builtin Calls, Binary, Unary,
 *  IndexLoad, etc. — everything that renders correctly slot-by-slot
 *  inside the iter loop. */
export function emitTensorAssignFromExpr(
  state: EmitState,
  level: number,
  cTarget: string,
  rhs: IRExpr
): void {
  const src = findShapeSourceVar(rhs);
  // When there is no multi-element Var in the RHS (e.g. `'abc' + 1`
  // or `'abc' == 'def'`), fall back to a CharLit whose length gives
  // the static shape.  If neither is found the lowerer has let through
  // something the codegen cannot handle yet.
  const charLitSrc = src === null ? findCharLitShapeSource(rhs) : null;
  if (src === null && charLitSrc === null) {
    throw new Error(
      `codegen internal: cannot determine runtime shape for elementwise ` +
        `assignment target '${cTarget}' (rhs ${typeToString(rhs.ty)}); ` +
        `RHS contains no multi-element variable or char literal to read shape from`
    );
  }
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");

  const isComplex = isNumeric(rhs.ty) && rhs.ty.isComplex;
  // Result ndim drives helper selection: 2-D keeps the legacy
  // `(rows, cols)` alloc shape (preserves byte-for-byte output for
  // every existing 2-D test); >2-D routes through the N-D alloc
  // helpers, passing the dim vector as a compound literal.
  const resultNdim = isNumeric(rhs.ty) ? rhs.ty.dims.length : 2;
  const isNd = resultNdim > 2;
  const allocHelper = isNd
    ? isComplex
      ? "mtoc_tensor_alloc_nd_complex"
      : "mtoc_tensor_alloc_nd"
    : isComplex
      ? "mtoc_tensor_alloc_complex"
      : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);

  const iterId = state.elemwiseLoopCounter++;
  const iterName = iterId === 0 ? "_mtoc_i" : `_mtoc_i${iterId}`;
  // Single-purpose name for the staging tensor — distinct from the
  // `_mtoc_t<n>` per-cell complex temp in `emitTensorLitAssign`, which
  // never appears in this function's emission.
  const stagingName = "_mtoc_t";

  // Collect every distinct multi-element Var in the RHS, keyed by
  // cName so duplicates like `v .* v` collapse. The shape source
  // already picked by `findShapeSourceVar` is the first entry; for
  // every other Var we emit one `mtoc_check_shape(<source>, <other>)`
  // before the staging-buffer alloc. Same-Var and scalar-broadcast
  // cases produce zero checks.
  // When the shape source is a CharLit, no runtime shape checks are
  // emitted for other CharLit operands (their lengths are statically
  // known; the dim lattice already admitted them as compatible).
  const multiVars = new Map<string, Extract<IRExpr, { kind: "Var" }>>();
  collectMultiElementVarsByCName(rhs, multiVars);
  const checkPairs: Array<Extract<IRExpr, { kind: "Var" }>> = [];
  if (src !== null) {
    for (const [cName, v] of multiVars) {
      if (cName === src.cName) continue;
      checkPairs.push(v);
    }
  }
  if (checkPairs.length > 0) {
    useRuntimeByName(state, "mtoc_check_shape");
  }

  // Shape args: either from a Var's runtime shape, or from the
  // static length of a CharLit (always a 1×N row vector — N-D
  // shape sources are always Vars, never CharLits). For the N-D
  // path, pull every axis off the source's `dims[i]`; for the 2-D
  // path, use the legacy field names (which become `rows`/`cols`
  // on char tensors and `dims[0]`/`dims[1]` on double tensors).
  let shapeArgs: string;
  let numelExpr: string;
  if (isNd) {
    if (src === null) {
      throw new Error(
        `codegen internal: N-D elementwise result without a multi-element ` +
          `Var shape source (rhs ${typeToString(rhs.ty)}); CharLit ` +
          `shape sources only produce 2-D results`
      );
    }
    const dimRefs = Array.from(
      { length: resultNdim },
      (_, i) => `${src.cName}.dims[${i}]`
    );
    shapeArgs = `${resultNdim}, (long[]){${dimRefs.join(", ")}}`;
    numelExpr = dimRefs.join(" * ");
  } else {
    shapeArgs =
      src !== null
        ? `${src.cName}.${tensorRowsField(src.ty)}, ${src.cName}.${tensorColsField(src.ty)}`
        : `1, ${charLitSrc!.value.length}`;
    numelExpr = `${stagingName}.dims[0] * ${stagingName}.dims[1]`;
  }

  pushStmt(state, level, `{`);
  if (src !== null) {
    for (const other of checkPairs) {
      pushStmt(
        state,
        level + 1,
        `mtoc_check_shape(${src.cName}, ${other.cName});`
      );
    }
  }
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t ${stagingName} = ${allocHelper}(${shapeArgs});`
  );
  pushStmt(state, level + 1, `long _mtoc_n = ${numelExpr};`);
  pushStmt(
    state,
    level + 1,
    `for (long ${iterName} = 0; ${iterName} < _mtoc_n; ${iterName}++) {`
  );
  state.iterStack.push(iterName);
  const bodyStr = emitExpr(state, rhs, 0);
  state.iterStack.pop();
  if (isComplex) {
    pushStmt(state, level + 2, `double _Complex _mtoc_c = ${bodyStr};`);
    pushStmt(
      state,
      level + 2,
      `${stagingName}.real[${iterName}] = creal(_mtoc_c);`
    );
    pushStmt(
      state,
      level + 2,
      `${stagingName}.imag[${iterName}] = cimag(_mtoc_c);`
    );
  } else {
    pushStmt(
      state,
      level + 2,
      `${stagingName}.real[${iterName}] = ${bodyStr};`
    );
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_assign(&${cTarget}, ${stagingName});`
  );
  pushStmt(state, level, `}`);
}

/** Emit a tensor-literal assignment. The runtime helpers
 *  (`mtoc_tensor_from_row` / `_complex` / `mtoc_tensor_from_matrix` /
 *  `_complex`) take a flat column-major data pointer and return a
 *  freshly-allocated tensor; `mtoc_tensor_assign` consumes that
 *  result and replaces the target's backing in one shot.
 *
 *  Real cells go straight into a C99 compound literal — `(double[])
 *  {1.0, 2.0, x, x*y}` — so the emitted C matches the numbl source
 *  one-for-one.
 *
 *  Complex literals build the staging tensor first (`mtoc_tensor_alloc_complex`),
 *  fill its `.real` / `.imag` slots in column-major order, then
 *  consume-replace via `mtoc_tensor_assign`. This handles arbitrary
 *  per-cell shapes (NumLit, ImagLit, real-scalar exprs, and full
 *  complex exprs needing creal/cimag splits) uniformly. Reads from
 *  the target (e.g. `M = [1, sum(M)]`) see the OLD buffer up until
 *  the final assign call, since the staging tensor is a separate
 *  allocation. */
export function emitTensorLitAssign(
  state: EmitState,
  level: number,
  target: string,
  lit: Extract<IRExpr, { kind: "TensorLit" }>
): void {
  if (!isNumeric(lit.ty)) {
    throw new Error(
      "codegen internal: tensor literal must produce a tensor type; " +
        "should have been caught at lowering"
    );
  }
  const ty = lit.ty as NumericType;
  // The IR node carries the literal's row-major nested elements; cell
  // counts come straight off that array (independent of the type's
  // coarse dim shape). Columns are uniform by lowerTensorLiteral's
  // row-uniformity check.
  const rows = lit.elements.length;
  const cols = rows > 0 ? lit.elements[0].length : 0;
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");

  if (!ty.isComplex) {
    // Real path: every cell is a real-scalar C expression. Drop them
    // straight into a compound literal in column-major order, then
    // hand to the matching from_row / from_matrix helper.
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        cells.push(emitExpr(state, lit.elements[r][c], 0));
      }
    }
    const helper =
      rows === 1 ? "mtoc_tensor_from_row" : "mtoc_tensor_from_matrix";
    useRuntimeByName(state, helper);
    const shapeArgs = rows === 1 ? `${cols}` : `${rows}, ${cols}`;
    pushStmt(
      state,
      level,
      `mtoc_tensor_assign(&${target}, ${helper}((double[]){${cells.join(", ")}}, ${shapeArgs}));`
    );
    return;
  }

  // Complex path: build the staging tensor up front and write each
  // cell's (real, imag) parts into its `.real`/`.imag` slots in
  // column-major order. Complex-typed cells (e.g. `x + 1` where x is
  // complex, or a complex Binary) need a per-cell `double _Complex`
  // temp so creal/cimag don't double-evaluate the expression.
  useRuntimeByName(state, "mtoc_tensor_alloc_complex");
  pushStmt(state, level, `{`);
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc_complex(${rows}, ${cols});`
  );
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cellExpr = lit.elements[r][c];
      const idx = r + c * rows;
      if (cellExpr.kind === "NumLit") {
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.real[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        pushStmt(state, level + 1, `_mtoc_t.imag[${idx}] = 0.0;`);
        continue;
      }
      if (cellExpr.kind === "ImagLit") {
        pushStmt(state, level + 1, `_mtoc_t.real[${idx}] = 0.0;`);
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.imag[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        continue;
      }
      const cellTy = cellExpr.ty;
      if (isNumeric(cellTy) && !cellTy.isComplex) {
        // Real scalar expression; promotes to (cell, 0i).
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.real[${idx}] = ${emitExpr(state, cellExpr, 0)};`
        );
        pushStmt(state, level + 1, `_mtoc_t.imag[${idx}] = 0.0;`);
        continue;
      }
      // Generic complex cell: stash into a temp and split with
      // creal/cimag. The temp is scoped per-cell with a `{}` block so
      // adjacent cells don't collide.
      const tmp = `_mtoc_c${state.elemwiseLoopCounter++}`;
      const cellStr = emitExpr(state, cellExpr, 0);
      pushStmt(state, level + 1, `{`);
      pushStmt(state, level + 2, `double _Complex ${tmp} = ${cellStr};`);
      pushStmt(state, level + 2, `_mtoc_t.real[${idx}] = creal(${tmp});`);
      pushStmt(state, level + 2, `_mtoc_t.imag[${idx}] = cimag(${tmp});`);
      pushStmt(state, level + 1, `}`);
    }
  }
  pushStmt(state, level + 1, `mtoc_tensor_assign(&${target}, _mtoc_t);`);
  pushStmt(state, level, `}`);
}
