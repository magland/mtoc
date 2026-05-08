/**
 * mtoc type system (seed).
 *
 * The basic type is `Tensor`. Scalars are 1×1 tensors. Today only
 * real `double` scalars are exercised end-to-end; the lattice is
 * shaped to grow into shape-aware reasoning (rowVec, colVec, matrix)
 * and other element kinds (single, int*, logical, char) without
 * reshaping the discriminated union.
 */

export type ElemKind = "double";

export type DimInfo =
  | { kind: "exact"; n: number }
  | { kind: "atLeast"; n: number }
  | { kind: "unknown" };

/**
 * What we know statically about the sign of a real-valued tensor.
 * Used by builtins like sqrt/log to refuse translation when the input
 * could land outside their domain.
 */
export type Sign =
  | "positive" //  x  >  0
  | "nonnegative" // x >= 0
  | "negative" //  x  <  0
  | "nonpositive" // x <= 0
  | "zero" //      x  == 0
  | "nonzero" //   x  != 0
  | "unknown";

/**
 * Every numeric value is a Tensor — including scalars, which are 1×1
 * tensors. There is no separate "Scalar" type. Operations dispatch on
 * the shape predicates below (isScalar / isRowVec / etc.); codegen
 * uses cTypeFor() to pick the C representation (double vs the
 * mtoc_tensor_t struct).
 */
export interface TensorType {
  kind: "Tensor";
  elem: ElemKind;
  isComplex: boolean;
  rows: DimInfo;
  cols: DimInfo;
  sign: Sign;
}

export type MType =
  | TensorType
  | { kind: "Unknown" }
  | { kind: "Void" };

export const SCALAR_DOUBLE: TensorType = {
  kind: "Tensor",
  elem: "double",
  isComplex: false,
  rows: { kind: "exact", n: 1 },
  cols: { kind: "exact", n: 1 },
  sign: "unknown",
};

export function scalarDouble(sign: Sign = "unknown"): TensorType {
  return { ...SCALAR_DOUBLE, sign };
}

/** Construct a row-vector type with cols known exactly. */
export function rowVecDouble(cols: number, sign: Sign = "unknown"): TensorType {
  return {
    kind: "Tensor",
    elem: "double",
    isComplex: false,
    rows: { kind: "exact", n: 1 },
    cols: { kind: "exact", n: cols },
    sign,
  };
}

/** Construct a column-vector type with rows known exactly. */
export function colVecDouble(rows: number, sign: Sign = "unknown"): TensorType {
  return {
    kind: "Tensor",
    elem: "double",
    isComplex: false,
    rows: { kind: "exact", n: rows },
    cols: { kind: "exact", n: 1 },
    sign,
  };
}

/** Construct a matrix type with rows × cols known exactly. */
export function matrixDouble(
  rows: number,
  cols: number,
  sign: Sign = "unknown"
): TensorType {
  return {
    kind: "Tensor",
    elem: "double",
    isComplex: false,
    rows: { kind: "exact", n: rows },
    cols: { kind: "exact", n: cols },
    sign,
  };
}

// ── Predicates ───────────────────────────────────────────────────────────

export function isTensor(t: MType): t is TensorType {
  return t.kind === "Tensor";
}

function dimIsExactly(d: DimInfo, n: number): boolean {
  return d.kind === "exact" && d.n === n;
}

// Note on shape predicates: these return plain `boolean`, not type
// predicates. `isTensor(t)` already narrows to `TensorType`; layering
// "is-scalar" on top of that as a predicate would have TS exclude
// TensorType from itself in the false branch, narrowing to `never`.
// Callers that need TensorType narrowing should `isTensor(t)` first.

/** True when both dimensions are statically known to be exactly 1. */
export function isScalar(t: MType): boolean {
  return isTensor(t) && dimIsExactly(t.rows, 1) && dimIsExactly(t.cols, 1);
}

/** True when rows is exactly 1 but cols is not (i.e., not a scalar). */
export function isRowVec(t: MType): boolean {
  return (
    isTensor(t) && dimIsExactly(t.rows, 1) && !dimIsExactly(t.cols, 1)
  );
}

/** True when cols is exactly 1 but rows is not. */
export function isColVec(t: MType): boolean {
  return (
    isTensor(t) && dimIsExactly(t.cols, 1) && !dimIsExactly(t.rows, 1)
  );
}

/** A vector is a row vector or a column vector (and not a scalar). */
export function isVector(t: MType): boolean {
  return isRowVec(t) || isColVec(t);
}

/** A matrix is anything tensor-shaped that isn't a scalar or vector. */
export function isMatrix(t: MType): boolean {
  return isTensor(t) && !isScalar(t) && !isVector(t);
}

/** Multi-element tensor (vector or matrix). Codegen uses this to pick
 *  between the bare `double` representation and `mtoc_tensor_t`. */
export function isMultiElement(t: MType): boolean {
  return isTensor(t) && !isScalar(t);
}

export function isScalarReal(t: MType): boolean {
  return isTensor(t) && isScalar(t) && !t.isComplex;
}

/** Element count when both dims are statically exact, else null. */
export function staticNumElements(t: MType): number | null {
  if (!isTensor(t)) return null;
  if (t.rows.kind !== "exact" || t.cols.kind !== "exact") return null;
  return t.rows.n * t.cols.n;
}

/** The C type used to represent values of this MType in the generated
 *  source. Scalars become bare `double`; multi-element tensors become
 *  `mtoc_tensor_t` (the struct from runtime/tensor.h). Returns null for
 *  types codegen does not yet handle (complex, Unknown, Void). */
export function cTypeFor(t: MType): string | null {
  if (t.kind !== "Tensor") return null;
  if (t.isComplex) return null;
  if (t.elem !== "double") return null;
  if (isScalar(t)) return "double";
  return "mtoc_tensor_t";
}

/** Get the "shape category" as a short string, derived from rows/cols.
 *  Used in human-readable output (typeToString, function header
 *  comments). NOT stored on the type. */
export function shapeCategory(t: TensorType): string {
  if (isScalar(t)) return "scalar";
  if (isRowVec(t)) return "rowVec";
  if (isColVec(t)) return "colVec";
  return "matrix";
}

// ── Sign helpers ─────────────────────────────────────────────────────────

export function signFromValue(n: number): Sign {
  if (Number.isNaN(n)) return "unknown";
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "zero";
}

export function signIsNonneg(s: Sign): boolean {
  return s === "positive" || s === "nonnegative" || s === "zero";
}

export function signIsPositive(s: Sign): boolean {
  return s === "positive";
}

export function signNegate(s: Sign): Sign {
  switch (s) {
    case "positive":
      return "negative";
    case "negative":
      return "positive";
    case "nonnegative":
      return "nonpositive";
    case "nonpositive":
      return "nonnegative";
    case "zero":
      return "zero";
    case "nonzero":
      return "nonzero";
    case "unknown":
      return "unknown";
  }
}

/** Lattice join for sign — used at control-flow merges and re-assignment. */
export function joinSign(a: Sign, b: Sign): Sign {
  if (a === b) return a;
  const isNN = (s: Sign) =>
    s === "positive" || s === "nonnegative" || s === "zero";
  const isNP = (s: Sign) =>
    s === "negative" || s === "nonpositive" || s === "zero";
  const isNZ = (s: Sign) =>
    s === "positive" || s === "negative" || s === "nonzero";
  if (isNN(a) && isNN(b)) return "nonnegative";
  if (isNP(a) && isNP(b)) return "nonpositive";
  if (isNZ(a) && isNZ(b)) return "nonzero";
  return "unknown";
}

export function signAdd(a: Sign, b: Sign): Sign {
  if (a === "zero") return b;
  if (b === "zero") return a;
  const isPos = (s: Sign) => s === "positive";
  const isNonnegStrict = (s: Sign) => s === "positive" || s === "nonnegative";
  const isNeg = (s: Sign) => s === "negative";
  const isNonposStrict = (s: Sign) => s === "negative" || s === "nonpositive";
  if (isPos(a) && isNonnegStrict(b)) return "positive";
  if (isNonnegStrict(a) && isPos(b)) return "positive";
  if (isNonnegStrict(a) && isNonnegStrict(b)) return "nonnegative";
  if (isNeg(a) && isNonposStrict(b)) return "negative";
  if (isNonposStrict(a) && isNeg(b)) return "negative";
  if (isNonposStrict(a) && isNonposStrict(b)) return "nonpositive";
  return "unknown";
}

export function signSub(a: Sign, b: Sign): Sign {
  return signAdd(a, signNegate(b));
}

export function signMul(a: Sign, b: Sign): Sign {
  if (a === "zero" || b === "zero") return "zero";
  const isPos = (s: Sign) => s === "positive";
  const isNeg = (s: Sign) => s === "negative";
  const isNonneg = (s: Sign) =>
    s === "positive" || s === "nonnegative" || s === "zero";
  const isNonpos = (s: Sign) =>
    s === "negative" || s === "nonpositive" || s === "zero";
  if (isPos(a) && isPos(b)) return "positive";
  if (isNeg(a) && isNeg(b)) return "positive";
  if ((isPos(a) && isNeg(b)) || (isNeg(a) && isPos(b))) return "negative";
  if (isNonneg(a) && isNonneg(b)) return "nonnegative";
  if (isNonpos(a) && isNonpos(b)) return "nonnegative";
  if ((isNonneg(a) && isNonpos(b)) || (isNonpos(a) && isNonneg(b)))
    return "nonpositive";
  return "unknown";
}

/** Sign of a/b. Same as multiplicative sign when divisor is non-zero. We
 *  treat division by a sign that includes zero as "unknown" because the
 *  C result is +-Inf/NaN and downstream reasoning would be unsafe. */
export function signDiv(a: Sign, b: Sign): Sign {
  if (b === "positive" || b === "negative" || b === "nonzero") {
    return signMul(a, b);
  }
  return "unknown";
}

// ── Lattice operations ───────────────────────────────────────────────────

function joinDim(a: DimInfo, b: DimInfo): DimInfo {
  if (a.kind === "exact" && b.kind === "exact" && a.n === b.n) return a;
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  // Same lower bound? (atLeast/exact merging) — drop to atLeast of the min,
  // or unknown if shapes differ. For the seed we just go to unknown.
  return { kind: "unknown" };
}

/**
 * Compute the least upper bound of two types (used at control-flow joins
 * and at re-assignment). Returns `Unknown` if the types can't share a
 * single C representation — different elem kinds, or one Void/Unknown.
 *
 * Note: dimensions widen via joinDim. So unifying two row vectors of
 * different exact lengths produces a tensor with cols=unknown — which
 * codegen will reject until we add dynamic-size support. The lowerer's
 * recordAssignment guard surfaces that as a clear conflict at the
 * offending line.
 */
export function unify(a: MType, b: MType): MType {
  if (a.kind === "Unknown" || b.kind === "Unknown") return { kind: "Unknown" };
  if (a.kind === "Void" || b.kind === "Void") return { kind: "Unknown" };
  if (a.elem !== b.elem) return { kind: "Unknown" };
  return {
    kind: "Tensor",
    elem: a.elem,
    isComplex: a.isComplex || b.isComplex,
    rows: joinDim(a.rows, b.rows),
    cols: joinDim(a.cols, b.cols),
    sign: joinSign(a.sign, b.sign),
  };
}

export type ArithKind = "Add" | "Sub" | "Mul" | "Div";

function arithSign(op: ArithKind, a: Sign, b: Sign): Sign {
  switch (op) {
    case "Add":
      return signAdd(a, b);
    case "Sub":
      return signSub(a, b);
    case "Mul":
      return signMul(a, b);
    case "Div":
      return signDiv(a, b);
  }
}

function dimsEqualExact(a: DimInfo, b: DimInfo): boolean {
  return a.kind === "exact" && b.kind === "exact" && a.n === b.n;
}

/**
 * Result of an arithmetic binary op on two values.
 *
 * The shape rule:
 *  - scalar ⊙ scalar       → scalar
 *  - scalar ⊙ tensor       → tensor (same shape as the tensor)  — broadcast
 *  - tensor ⊙ scalar       → tensor (same shape as the tensor)  — broadcast
 *  - tensor ⊙ tensor       → only if dims match exactly. Today we
 *                            require both rows and both cols to be
 *                            exact and equal. Returns a tensor of
 *                            that shape.
 *
 * For `Mul`/`Div`, tensor⊙tensor is *not* element-wise in MATLAB —
 * it's matrix multiply / matrix divide. We do not support those yet,
 * so tensor⊙tensor with `*`/`/` returns Unknown. Callers that want
 * elementwise should use `.*`/`./` (still Add/Sub/Mul/Div in the
 * abstract op kind here, since lower.ts maps both `Mul` and `ElemMul`
 * to `Mul`; tensor⊙tensor with that abstract op is rejected).
 */
export function arithResult(
  op: ArithKind,
  a: MType,
  b: MType
): MType {
  if (!isTensor(a) || !isTensor(b)) return { kind: "Unknown" };
  if (a.elem !== b.elem) return { kind: "Unknown" };
  if (a.isComplex || b.isComplex) return { kind: "Unknown" };
  const sign = arithSign(op, a.sign, b.sign);

  const aSc = isScalar(a);
  const bSc = isScalar(b);

  if (aSc && bSc) {
    return scalarDouble(sign);
  }
  if (aSc || bSc) {
    // Scalar broadcasts to the other operand's shape.
    const tensor = aSc ? b : a;
    return {
      kind: "Tensor",
      elem: tensor.elem,
      isComplex: false,
      rows: tensor.rows,
      cols: tensor.cols,
      sign,
    };
  }
  // Both are tensors — only elementwise (Add/Sub) is allowed today
  // when we route here. Mul/Div on two tensors are matrix multiply /
  // matrix divide (deferred), but the lowerer maps `.* ./` to
  // `Mul`/`Div` in the abstract kind too, so we accept those here for
  // same-shape and reject in the lowerer's path that distinguishes
  // `Mul` from `ElemMul`.
  if (!dimsEqualExact(a.rows, b.rows) || !dimsEqualExact(a.cols, b.cols)) {
    return { kind: "Unknown" };
  }
  return {
    kind: "Tensor",
    elem: a.elem,
    isComplex: false,
    rows: a.rows,
    cols: a.cols,
    sign,
  };
}

/** Backwards-compat alias for code paths that only deal with the
 *  scalar case. New code should call arithResult. */
export const arithResultScalar = arithResult;

// ── Canonical serialization for specialization keying ───────────────────

/**
 * Canonical (deterministic) representation of an MType. Used by the
 * lowerer to hash a function's argument type tuple into a stable suffix:
 * two calls with identical type tuples produce the same hash, and so
 * land on the same specialization. Field order is explicit so the
 * serialization doesn't depend on the order TS happened to insert keys.
 */
export function canonicalizeType(t: MType): unknown {
  if (t.kind === "Unknown") return { kind: "Unknown" };
  if (t.kind === "Void") return { kind: "Void" };
  return {
    kind: "Tensor",
    elem: t.elem,
    isComplex: t.isComplex,
    rows: t.rows,
    cols: t.cols,
    sign: t.sign,
  };
}

function dimToString(d: DimInfo): string {
  if (d.kind === "exact") return `${d.n}`;
  if (d.kind === "atLeast") return `>=${d.n}`;
  return "?";
}

export function typeToString(t: MType): string {
  if (t.kind === "Unknown") return "Unknown";
  if (t.kind === "Void") return "Void";
  const cstr = t.isComplex ? ", complex" : ", real";
  const signStr = t.sign === "unknown" ? "" : `, sign=${t.sign}`;
  const cat = shapeCategory(t);
  const dims = `${dimToString(t.rows)}x${dimToString(t.cols)}`;
  return `Tensor<${cat}(${dims}), ${t.elem}${cstr}${signStr}>`;
}
