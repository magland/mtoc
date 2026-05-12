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
import { isParallelThreadsOption } from "../build.js";

/** Minimum element count for OpenMP parallelization. Loops with fewer
 *  elements stay serial regardless of the `threads` build option —
 *  the OpenMP region setup overhead would dominate. Picked
 *  conservatively so even very simple per-iter bodies (e.g. `a + b`)
 *  amortize on the parallel side. Centralized so flat-iter and
 *  broadcast emitters use the same threshold. */
const PARALLEL_MIN_N = 1024;

/** Return the `#pragma omp parallel for if(<sizeExpr> > K)` string the
 *  current state's threads option calls for, or `null` when threads=1
 *  (no pragma emitted; user-code C stays bit-identical to today's
 *  serial output). Same predicate as `BuildOptions::threads` via
 *  `isParallelThreadsOption`. */
function parallelForPragma(state: EmitState, sizeExpr: string): string | null {
  return isParallelThreadsOption(state.threads)
    ? `#pragma omp parallel for if(${sizeExpr} > ${PARALLEL_MIN_N})`
    : null;
}

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

/** True when two multi-element operand types have the same static
 *  shape under the dim lattice. Used by the broadcast dispatcher to
 *  decide between the flat-iter path (all operands same shape; one
 *  shared loop variable suffices) and the broadcast path (per-axis
 *  size-1 expansion required). Different ndim ⇒ different shape;
 *  same ndim with any axis-kind mismatch ⇒ different shape. */
function sameStaticShape(a: NumericType, b: NumericType): boolean {
  if (a.dims.length !== b.dims.length) return false;
  for (let i = 0; i < a.dims.length; i++) {
    if (a.dims[i].kind !== b.dims[i].kind) return false;
  }
  return true;
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
 *  Two emission paths: when every multi-element operand has the same
 *  static shape, a single flat iter loop walks the shared layout (the
 *  byte-for-byte legacy form). When operands have differing static
 *  shapes (e.g. row vec + col vec) we switch to a broadcast-aware
 *  nested-loop path with per-operand stride tables — a size-1 axis
 *  on one operand reads the same element while the others advance.
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

  // Collect every distinct multi-element Var in the RHS, keyed by
  // cName so duplicates like `v .* v` collapse.
  const multiVars = new Map<string, Extract<IRExpr, { kind: "Var" }>>();
  collectMultiElementVarsByCName(rhs, multiVars);

  // Decide between the flat-iter and broadcast-aware paths. We take
  // the broadcast path only when the static shapes of two multi-
  // element Vars disagree — same-shape cases (including all the
  // pre-existing 2-D and N-D tests) keep the flat-iter emission so
  // their generated C stays byte-for-byte identical. CharLits stay
  // on the flat path; mixing CharLits with a differently-shaped Var
  // is rare enough to defer.
  let needsBroadcast = false;
  if (src !== null && multiVars.size > 1 && isNumeric(src.ty)) {
    for (const v of multiVars.values()) {
      if (v.cName === src.cName) continue;
      if (!isNumeric(v.ty)) continue;
      if (!sameStaticShape(src.ty, v.ty)) {
        needsBroadcast = true;
        break;
      }
    }
  }

  if (needsBroadcast) {
    emitBroadcastAssign(state, level, cTarget, rhs, multiVars);
    return;
  }
  emitFlatAssign(state, level, cTarget, rhs, src, charLitSrc, multiVars);
}

/** Same-shape (no implicit expansion) emission. Every multi-element
 *  operand has identical static shape, so one shared iter variable
 *  walks every operand's flat layout. Runtime mismatch between two
 *  same-static-shape operands (e.g. both `[notOne, notOne]` but
 *  different sizes) is caught by `mtoc_check_shape` before the loop. */
function emitFlatAssign(
  state: EmitState,
  level: number,
  cTarget: string,
  rhs: IRExpr,
  src: Extract<IRExpr, { kind: "Var" }> | null,
  charLitSrc: Extract<IRExpr, { kind: "CharLit" }> | null,
  multiVars: Map<string, Extract<IRExpr, { kind: "Var" }>>
): void {
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

  // The shape source already picked above is the first entry of
  // multiVars; for every other Var we emit one
  // `mtoc_check_shape(<source>, <other>)` before the staging-buffer
  // alloc. Same-Var and scalar-broadcast cases produce zero checks.
  // When the shape source is a CharLit, no runtime shape checks are
  // emitted for other CharLit operands (their lengths are statically
  // known; the dim lattice already admitted them as compatible).
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
  const pragma = parallelForPragma(state, "_mtoc_n");
  if (pragma !== null) pushStmt(state, level + 1, pragma);
  pushStmt(
    state,
    level + 1,
    `for (long ${iterName} = 0; ${iterName} < _mtoc_n; ${iterName}++) {`
  );
  state.iterStack.push({ kind: "flat", iter: iterName });
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

/** Axis-i runtime size for operand `v`. Double tensors carry shape in
 *  `dims[…]`; char tensors keep their legacy `.rows`/`.cols` fields
 *  for axes 0/1. Operand axes past the operand's own ndim are
 *  implicit-1 (the trailing-pad rule). */
function operandAxisSize(
  v: Extract<IRExpr, { kind: "Var" }>,
  i: number
): string {
  const ndim = isNumeric(v.ty) ? v.ty.dims.length : 2;
  if (i < ndim) {
    if (i === 0) return `${v.cName}.${tensorRowsField(v.ty)}`;
    if (i === 1) return `${v.cName}.${tensorColsField(v.ty)}`;
    return `${v.cName}.dims[${i}]`;
  }
  return "1L";
}

/** Broadcast-aware (implicit-expansion) emission. Computes the output
 *  shape at runtime from a per-axis `mtoc_broadcast_dim` chain across
 *  every operand, allocates the output, opens nested column-major
 *  loops, and precomputes a per-operand linear index inside the
 *  innermost body — a size-1 operand axis contributes `0`, a
 *  statically `notOne` axis uses the loop variable directly, and an
 *  `unknown` axis takes a runtime `?:` against the operand's dim
 *  field. The body re-uses `emitExpr` with a `broadcast` iter frame
 *  that maps each operand's cName to its precomputed index. */
function emitBroadcastAssign(
  state: EmitState,
  level: number,
  cTarget: string,
  rhs: IRExpr,
  multiVars: Map<string, Extract<IRExpr, { kind: "Var" }>>
): void {
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");
  useRuntimeByName(state, "mtoc_broadcast_dim");

  const operands = Array.from(multiVars.values());
  const outNdim = operands.reduce(
    (n, v) => Math.max(n, isNumeric(v.ty) ? v.ty.dims.length : 2),
    2
  );

  const isComplex = isNumeric(rhs.ty) && rhs.ty.isComplex;
  const isNd = outNdim > 2;
  const allocHelper = isNd
    ? isComplex
      ? "mtoc_tensor_alloc_nd_complex"
      : "mtoc_tensor_alloc_nd"
    : isComplex
      ? "mtoc_tensor_alloc_complex"
      : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);

  const stagingName = "_mtoc_t";
  const outDimNames: string[] = [];
  for (let i = 0; i < outNdim; i++) outDimNames.push(`_mtoc_d${i}`);
  const loopVars: string[] = [];
  for (let i = 0; i < outNdim; i++) loopVars.push(`_mtoc_k${i}`);

  pushStmt(state, level, `{`);

  // Per-axis broadcast result: chain mtoc_broadcast_dim across every
  // operand. Validates compatibility at runtime and yields the
  // axis-wise output size in one shot.
  for (let i = 0; i < outNdim; i++) {
    let expr = operandAxisSize(operands[0], i);
    for (let k = 1; k < operands.length; k++) {
      expr = `mtoc_broadcast_dim(${expr}, ${operandAxisSize(operands[k], i)})`;
    }
    pushStmt(state, level + 1, `long ${outDimNames[i]} = ${expr};`);
  }

  // Allocate the output. 2-D output keeps the `(rows, cols)` alloc
  // shape; N-D uses the compound-literal dims vector.
  const shapeArgs = isNd
    ? `${outNdim}, (long[]){${outDimNames.join(", ")}}`
    : `${outDimNames[0]}, ${outDimNames[1]}`;
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t ${stagingName} = ${allocHelper}(${shapeArgs});`
  );

  // Open nested loops, outermost first (highest axis → column-major
  // fill, matching the existing flat-iter convention). The pragma —
  // emitted only when the threads option is non-serial — parallelizes
  // the outermost loop; its `if(...)` clause guards against fork
  // overhead on tiny broadcasts by checking total element count.
  const totalElems = outDimNames.join(" * ");
  const broadcastPragma = parallelForPragma(state, totalElems);
  for (let i = outNdim - 1; i >= 0; i--) {
    const lvl = level + 1 + (outNdim - 1 - i);
    if (i === outNdim - 1 && broadcastPragma !== null) {
      pushStmt(state, lvl, broadcastPragma);
    }
    pushStmt(
      state,
      lvl,
      `for (long ${loopVars[i]} = 0; ${loopVars[i]} < ${outDimNames[i]}; ${loopVars[i]}++) {`
    );
  }
  const bodyLevel = level + outNdim + 1;

  // Output linear index: k0 + k1*d0 + k2*d0*d1 + …
  const outIdxParts: string[] = [];
  for (let i = 0; i < outNdim; i++) {
    const strideParts = outDimNames.slice(0, i);
    const term =
      strideParts.length === 0
        ? loopVars[i]
        : `${loopVars[i]} * ${strideParts.join(" * ")}`;
    outIdxParts.push(term);
  }
  pushStmt(state, bodyLevel, `long _mtoc_oi = ${outIdxParts.join(" + ")};`);

  // Precompute each operand's linear index. Static `one` → drop the
  // axis term (contributes 0); static `notOne` → loop var directly;
  // static `unknown` or operand-padded axis → runtime `?:`. Stride
  // for axis i is the product of the operand's lower-axis sizes
  // (column-major), padded with `1L` for axes the operand doesn't
  // carry.
  const perVarIndex = new Map<string, string>();
  for (const [cName, v] of multiVars) {
    const ndim = isNumeric(v.ty) ? v.ty.dims.length : 2;
    const idxName = `_mtoc_${cName}_idx`;
    const parts: string[] = [];
    const stridePieces: string[] = [];
    for (let i = 0; i < outNdim; i++) {
      const axis = operandAxisSize(v, i);
      const staticDim =
        i < ndim && isNumeric(v.ty) ? v.ty.dims[i] : { kind: "one" as const };
      let term: string | null;
      if (staticDim.kind === "one") {
        term = null;
      } else if (staticDim.kind === "notOne") {
        term = loopVars[i];
      } else {
        term = `(${axis} == 1 ? 0 : ${loopVars[i]})`;
      }
      if (term !== null) {
        const stride =
          stridePieces.length === 0 ? "" : ` * ${stridePieces.join(" * ")}`;
        parts.push(stride === "" ? term : `${term}${stride}`);
      }
      stridePieces.push(axis);
    }
    const idxExpr = parts.length === 0 ? "0L" : parts.join(" + ");
    pushStmt(state, bodyLevel, `long ${idxName} = ${idxExpr};`);
    perVarIndex.set(cName, idxName);
  }

  // Render the body with the broadcast iter frame so each operand
  // Var read picks up its precomputed index.
  state.iterStack.push({ kind: "broadcast", perVarIndex });
  const bodyStr = emitExpr(state, rhs, 0);
  state.iterStack.pop();

  if (isComplex) {
    pushStmt(state, bodyLevel, `double _Complex _mtoc_c = ${bodyStr};`);
    pushStmt(
      state,
      bodyLevel,
      `${stagingName}.real[_mtoc_oi] = creal(_mtoc_c);`
    );
    pushStmt(
      state,
      bodyLevel,
      `${stagingName}.imag[_mtoc_oi] = cimag(_mtoc_c);`
    );
  } else {
    pushStmt(state, bodyLevel, `${stagingName}.real[_mtoc_oi] = ${bodyStr};`);
  }

  // Close nested loops (innermost first).
  for (let i = 0; i < outNdim; i++) {
    const lvl = level + 1 + (outNdim - 1 - i);
    pushStmt(state, lvl, `}`);
  }

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
