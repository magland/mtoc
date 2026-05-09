/**
 * mtoc type system (seed).
 *
 * The numeric tower is `NumericType` — every numeric value mtoc tracks
 * is in it: scalar or tensor, real or complex, with shape carried
 * alongside element kind. Scalars are 1×1 numerics (no separate
 * "Scalar" variant). The first non-numeric sibling, `StringType`,
 * lives alongside it for double-quoted scalar string handles. The
 * `kind` discriminator is reserved to grow further variants (Logical,
 * Char, Cell, Struct, Handle) — those land when there's a concrete
 * need; keeping the discriminator means adding them won't ripple
 * through numeric-only code paths.
 */

export type ElemKind = "double";

/**
 * What we know about a single tensor dimension. The lattice is
 * intentionally coarse: we only track whether the axis is a scalar
 * broadcast (`one`) or not (`notOne`), or whether we don't know yet
 * (`unknown`). The specific size is runtime data — codegen reads it
 * off the `mtoc_tensor_t.rows` / `.cols` fields.
 *
 *   one      — statically exactly 1 (broadcast axis).
 *   notOne   — provably not 1 (admits 0 for empty tensors and any n≥2);
 *              specific size unknown. The signal `lowerBinary`'s
 *              scalar-vs-broadcast dispatch actually cares about: is
 *              this axis a scalar broadcast or not?
 *   unknown  — nothing known (might be 1, might not).
 */
export type DimInfo =
  | { kind: "one" }
  | { kind: "notOne" }
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
 * Every numeric value — scalar or tensor, real or complex — is a
 * NumericType. There is no separate "Scalar" variant; scalars are
 * 1×1 numerics. Operations dispatch on the shape predicates below
 * (isScalar / isRowVec / etc.); codegen uses cTypeFor() to pick the
 * C representation (`double` vs `double _Complex` vs the
 * `mtoc_tensor_t` struct).
 *
 * Invariant: `sign` is meaningful only when `isComplex === false`.
 * For complex numerics, `sign` MUST be `"unknown"`. The invariant is
 * enforced wherever the type is observed for behavioral effect:
 * `canonicalizeType` (specialization keys) and `unify` (assigned-var
 * type merging) both normalize a complex type's sign to "unknown"
 * before producing their output. Constructors should already respect
 * the invariant; the normalize step exists so a stray `sign` carried
 * through a join can't bloat the specialization cache.
 */
export interface NumericType {
  kind: "Numeric";
  elem: ElemKind;
  isComplex: boolean;
  rows: DimInfo;
  cols: DimInfo;
  /** Meaningful only when `isComplex === false`; "unknown" otherwise. */
  sign: Sign;
}

/**
 * Return `t` with `sign: "unknown"` when `t.isComplex === true`, else
 * `t` unchanged. Internal — used by `canonicalizeType` and `unify` to
 * enforce the "sign is undefined on complex" invariant at observation
 * sites without forcing every constructor to remember the rule.
 */
function normalizeComplexSign(t: NumericType): NumericType {
  return t.isComplex && t.sign !== "unknown" ? { ...t, sign: "unknown" } : t;
}

/**
 * Scalar string handle. mtoc supports the numbl "string" type
 * (double-quoted literals: `"hello"`) only as a scalar — no string
 * arrays. Char (single-quoted literals) is intentionally rejected at
 * lowering as a separate follow-up.
 *
 * The C representation is `mtoc_string_t` (see `runtime/string.h`):
 * a small struct carrying a `data` pointer, a byte length, and an
 * `owned` flag distinguishing literal-pointing-at-rodata from
 * heap-allocated-from-concat. Encoding is UTF-8 by convention; the
 * runtime never inspects code points (concat is byte-level
 * memcpy and `length` returns 1 per numbl semantics).
 */
export interface StringType {
  kind: "String";
}

export const STRING: StringType = { kind: "String" };

export type MType =
  | NumericType
  | StringType
  | { kind: "Unknown" }
  | { kind: "Void" };

export const SCALAR_DOUBLE: NumericType = {
  kind: "Numeric",
  elem: "double",
  isComplex: false,
  rows: { kind: "one" },
  cols: { kind: "one" },
  sign: "unknown",
};

export function scalarDouble(sign: Sign = "unknown"): NumericType {
  return { ...SCALAR_DOUBLE, sign };
}

/** Construct a complex scalar (1×1 complex double). Sign is forced to
 *  "unknown" to honor the invariant that sign is meaningless on
 *  complex types. */
export function scalarComplex(): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: true,
    rows: { kind: "one" },
    cols: { kind: "one" },
    sign: "unknown",
  };
}

/** Construct a row-vector type. The cols dim is `notOne` (i.e.
 *  provably ≠ 1); the specific size is runtime data and lives on
 *  `mtoc_tensor_t.cols` at runtime. */
export function rowVecDouble(sign: Sign = "unknown"): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    rows: { kind: "one" },
    cols: { kind: "notOne" },
    sign,
  };
}

/** Construct a column-vector type. Rows dim is `notOne`; specific
 *  size is runtime data. */
export function colVecDouble(sign: Sign = "unknown"): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    rows: { kind: "notOne" },
    cols: { kind: "one" },
    sign,
  };
}

/** Build a `NumericType` from explicit dim shapes — the general
 *  factory used by lowerings that compute their own row/col `DimInfo`
 *  (e.g. `lowerTensorLiteral`). Sign is forced to "unknown" when
 *  `isComplex` is true (the type-system invariant). */
export function numericType(
  rows: DimInfo,
  cols: DimInfo,
  isComplex: boolean = false,
  sign: Sign = "unknown"
): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex,
    rows,
    cols,
    sign: isComplex ? "unknown" : sign,
  };
}

// ── Predicates ───────────────────────────────────────────────────────────

export function isNumeric(t: MType): t is NumericType {
  return t.kind === "Numeric";
}

/** True when `t` is the scalar `string` type. mtoc treats string as
 *  scalar-only; arrays of strings are deferred. */
export function isString(t: MType): t is StringType {
  return t.kind === "String";
}

/** Statically known to be exactly 1 — i.e. broadcastable in this axis. */
export function dimIsOne(d: DimInfo): boolean {
  return d.kind === "one";
}

/** Statically known to NOT be 1. Admits empty (n=0) and any n≥2 alike;
 *  what matters for dispatch is just "is this a scalar broadcast in
 *  this axis or not?" */
export function dimIsNotOne(d: DimInfo): boolean {
  return d.kind === "notOne";
}

// Note on shape predicates: these return plain `boolean`, not type
// predicates. `isNumeric(t)` already narrows to `NumericType`; layering
// "is-scalar" on top of that as a predicate would have TS exclude
// NumericType from itself in the false branch, narrowing to `never`.
// Callers that need NumericType narrowing should `isNumeric(t)` first.

/** True when both dimensions are statically known to be exactly 1. */
export function isScalar(t: MType): boolean {
  return isNumeric(t) && dimIsOne(t.rows) && dimIsOne(t.cols);
}

/** True when rows is exactly 1 and cols is statically known to be not 1. */
export function isRowVec(t: MType): boolean {
  return isNumeric(t) && dimIsOne(t.rows) && dimIsNotOne(t.cols);
}

/** True when cols is exactly 1 and rows is statically known to be not 1. */
export function isColVec(t: MType): boolean {
  return isNumeric(t) && dimIsOne(t.cols) && dimIsNotOne(t.rows);
}

/** A vector is a row vector or a column vector (and not a scalar). */
export function isVector(t: MType): boolean {
  return isRowVec(t) || isColVec(t);
}

/** A matrix is anything tensor-shaped that isn't a scalar or vector. */
export function isMatrix(t: MType): boolean {
  return isMultiElement(t) && !isVector(t);
}

/** Multi-element tensor (vector or matrix). At least one dim is
 *  statically known to be not 1. Codegen uses this to pick between the
 *  bare `double` representation and `mtoc_tensor_t`. */
export function isMultiElement(t: MType): boolean {
  return isNumeric(t) && (dimIsNotOne(t.rows) || dimIsNotOne(t.cols));
}

export function isScalarReal(t: MType): boolean {
  return isNumeric(t) && isScalar(t) && !t.isComplex;
}

export function isScalarComplex(t: MType): boolean {
  return isNumeric(t) && isScalar(t) && t.isComplex;
}

/** Statically known element count, else null. After the dim coarsening
 *  the only shape with a statically known count is the all-`one`
 *  shape — i.e. a scalar (count=1). Every other shape's element count
 *  is runtime data (read off `mtoc_tensor_t.rows * .cols`). */
export function staticNumElements(t: MType): number | null {
  if (!isNumeric(t)) return null;
  if (isScalar(t)) return 1;
  return null;
}

/** The C type used to represent values of this MType in the generated
 *  source. Scalars become bare `double` (real) or `double _Complex`
 *  (complex); multi-element tensors become `mtoc_tensor_t` (the struct
 *  from runtime/tensor.h) — the struct's `imag` buffer answers the
 *  complex question on the C side. Returns null for types codegen does
 *  not yet handle (Unknown, Void, non-double elem). */
export function cTypeFor(t: MType): string | null {
  if (t.kind === "String") return "mtoc_string_t";
  if (t.kind !== "Numeric") return null;
  if (t.elem !== "double") return null;
  if (isScalar(t)) return t.isComplex ? "double _Complex" : "double";
  return "mtoc_tensor_t";
}

/** Get the "shape category" as a short string, derived from rows/cols.
 *  Used in human-readable output (typeToString, function header
 *  comments). NOT stored on the type. */
export function shapeCategory(t: NumericType): string {
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

// joinDim — least upper bound on the DimInfo lattice. Symmetric.
//
//   one      ∨ one      → one
//   notOne   ∨ notOne   → notOne
//   one      ∨ notOne   → unknown
//   unknown  ∨ _        → unknown
function joinDim(a: DimInfo, b: DimInfo): DimInfo {
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  if (a.kind === b.kind) return a;
  return { kind: "unknown" };
}

// ── NumericType field template ───────────────────────────────────────────
//
// Single source of truth describing every storable field on `NumericType`.
// `canonicalizeType`, `typeToString`, and `unify` all iterate this list
// instead of hand-rolling a copy of every field. Adding a new field
// (say, `complexKind`) means appending one entry here — the three
// shared routines pick it up automatically.
//
// IMPORTANT: the field ORDER below is the canonical hash order. Since
// the lowerer hashes `JSON.stringify(canonicalizeType(...))` to produce
// a function specialization's mangled C name, reordering would change
// every emitted specialization name (and therefore the generated C).
// New fields MUST be appended to the end.

interface TensorFieldEntry {
  /** Field key on `NumericType`. */
  readonly name: keyof NumericType;
  /** Canonical-hash value contributed by this field (deterministic JSON
   *  for `canonicalizeType`). Default: pass-through of `t[name]`. */
  readonly canonicalize: (t: NumericType) => unknown;
  /** typeToString fragment contributed by this field. Empty string is
   *  fine — the framing handles separators. Receives the whole type so
   *  paired-field renderings (rows+cols → "RxC") can be coalesced into
   *  a single field's contribution. */
  readonly format: (t: NumericType) => string;
  /** Joins this field across `a` and `b`, writing the result into
   *  `out`. Returns `false` when the two values can't share a single
   *  C representation — `unify` then short-circuits to Unknown. */
  readonly joinInto: (
    a: NumericType,
    b: NumericType,
    out: Record<string, unknown>
  ) => boolean;
}

/** Build a field entry with per-field types preserved. The resulting
 *  closures cast inside the union so callers see a uniform interface. */
function makeField<K extends keyof NumericType>(
  name: K,
  format: (t: NumericType) => string,
  join: (a: NumericType[K], b: NumericType[K]) => NumericType[K] | null
): TensorFieldEntry {
  return {
    name,
    canonicalize: t => t[name],
    format,
    joinInto: (a, b, out) => {
      const r = join(a[name], b[name]);
      if (r === null) return false;
      out[name] = r;
      return true;
    },
  };
}

const NUMERIC_FIELDS: ReadonlyArray<TensorFieldEntry> = [
  makeField(
    "elem",
    t => t.elem,
    (a, b) => (a === b ? a : null)
  ),
  makeField(
    "isComplex",
    t => (t.isComplex ? "complex" : "real"),
    (a, b) => a || b
  ),
  // rows/cols emit the empty fragment — their pretty-printed form
  // ("RxC") is rendered by typeToString itself in the framing prefix
  // because it reads both fields together.
  makeField("rows", () => "", joinDim),
  makeField("cols", () => "", joinDim),
  makeField(
    "sign",
    t => (t.sign === "unknown" ? "" : `sign=${t.sign}`),
    joinSign
  ),
];

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
  // String is a sibling top-level variant. Two strings unify to a
  // string; string vs anything else (numeric / unrelated) collapses
  // to Unknown — codegen can't share one C representation across
  // categories, and `recordAssignment` will pick that up at the
  // first such reassignment.
  if (a.kind === "String" || b.kind === "String") {
    return a.kind === "String" && b.kind === "String"
      ? STRING
      : { kind: "Unknown" };
  }
  // Walk the field template, building a fresh NumericType in the
  // canonical field order (kind, then NUMERIC_FIELDS in array order).
  // Insertion order matters because canonicalizeType normalizes by
  // re-iterating the same template, but keeping it consistent here
  // keeps debug-prints stable too.
  const out: Record<string, unknown> = { kind: "Numeric" };
  for (const f of NUMERIC_FIELDS) {
    if (!f.joinInto(a, b, out)) return { kind: "Unknown" };
  }
  return normalizeComplexSign(out as unknown as NumericType);
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

/** Pointwise dim compatibility for tensor⊙tensor arithmetic. The only
 *  categorical incompatibility under the coarse lattice is `one` vs
 *  `notOne` — provably-1 against provably-not-1 in the same axis;
 *  that's the rowVec-vs-colVec broadcast case mtoc doesn't support
 *  yet. Anything involving `unknown` admits a runtime match (the
 *  type system can't disprove it). Same-kind pairs are compatible. */
function dimAccept(a: DimInfo, b: DimInfo): boolean {
  if (a.kind === "one" && b.kind === "notOne") return false;
  if (a.kind === "notOne" && b.kind === "one") return false;
  return true;
}

/** Most-refined of two compatible dims. Assumes `dimAccept(a,b)`. */
function dimMeet(a: DimInfo, b: DimInfo): DimInfo {
  if (a.kind === b.kind) return a;
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  // Per dimAccept's contract, the (one, notOne) pair never gets here.
  return { kind: "unknown" };
}

/**
 * Result of an arithmetic binary op on two values.
 *
 * The shape rule:
 *  - scalar ⊙ scalar       → scalar
 *  - scalar ⊙ tensor       → tensor (same shape as the tensor)  — broadcast
 *  - tensor ⊙ scalar       → tensor (same shape as the tensor)  — broadcast
 *  - tensor ⊙ tensor       → if dims are pointwise compatible
 *                            (see `dimAccept`), the result takes the
 *                            most-refined dim per axis. Categorical
 *                            mismatches (rowVec + colVec, etc.) reject.
 *                            Specific size matching is runtime data —
 *                            not checked here; codegen will pick that
 *                            up in a follow-up stage.
 *
 * For `Mul`/`Div`, tensor⊙tensor is *not* element-wise in MATLAB —
 * it's matrix multiply / matrix divide. We do not support those yet,
 * so tensor⊙tensor with `*`/`/` returns Unknown. Callers that want
 * elementwise should use `.*`/`./` (still Add/Sub/Mul/Div in the
 * abstract op kind here, since lower.ts maps both `Mul` and `ElemMul`
 * to `Mul`; tensor⊙tensor with that abstract op is rejected).
 */
export function arithResult(op: ArithKind, a: MType, b: MType): MType {
  if (!isNumeric(a) || !isNumeric(b)) return { kind: "Unknown" };
  if (a.elem !== b.elem) return { kind: "Unknown" };
  // Complex propagates: real⊙complex and complex⊙complex both produce
  // complex. Sign is meaningless on a complex result (the invariant is
  // enforced at output sites — canonicalizeType / unify normalize) so
  // we just compute it on the real branch.
  const isComplex = a.isComplex || b.isComplex;
  const sign = isComplex ? "unknown" : arithSign(op, a.sign, b.sign);

  const aSc = isScalar(a);
  const bSc = isScalar(b);

  if (aSc && bSc) {
    return {
      kind: "Numeric",
      elem: a.elem,
      isComplex,
      rows: { kind: "one" },
      cols: { kind: "one" },
      sign,
    };
  }
  if (aSc || bSc) {
    // Scalar broadcasts to the other operand's shape.
    const tensor = aSc ? b : a;
    return {
      kind: "Numeric",
      elem: tensor.elem,
      isComplex,
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
  if (!dimAccept(a.rows, b.rows) || !dimAccept(a.cols, b.cols)) {
    return { kind: "Unknown" };
  }
  return {
    kind: "Numeric",
    elem: a.elem,
    isComplex,
    rows: dimMeet(a.rows, b.rows),
    cols: dimMeet(a.cols, b.cols),
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
 * land on the same specialization. Iterates `NUMERIC_FIELDS` so the
 * serialization doesn't depend on the order TS happened to insert keys
 * (and so a new field shows up in the hash automatically by being
 * appended to the template above).
 */
export function canonicalizeType(t: MType): unknown {
  if (t.kind === "Unknown") return { kind: "Unknown" };
  if (t.kind === "Void") return { kind: "Void" };
  if (t.kind === "String") return { kind: "String" };
  // Normalize before serializing so two complex types differing only
  // in a leftover `sign` field hash to the same specialization key.
  const normalized = normalizeComplexSign(t);
  const out: Record<string, unknown> = { kind: "Numeric" };
  for (const f of NUMERIC_FIELDS) {
    out[f.name] = f.canonicalize(normalized);
  }
  return out;
}

function dimToString(d: DimInfo): string {
  if (d.kind === "one") return "1";
  if (d.kind === "notOne") return "≠1";
  return "?";
}

export function typeToString(t: MType): string {
  if (t.kind === "Unknown") return "Unknown";
  if (t.kind === "Void") return "Void";
  if (t.kind === "String") return "String";
  const cat = shapeCategory(t);
  // Dims are rendered into the framing prefix — they're a paired
  // rows+cols read, which doesn't fit the per-field iteration model.
  // The corresponding NUMERIC_FIELDS entries return the empty fragment.
  const dims = `${dimToString(t.rows)}x${dimToString(t.cols)}`;
  const fragments = NUMERIC_FIELDS.map(f => f.format(t)).filter(s => s !== "");
  return `Numeric<${cat}(${dims}), ${fragments.join(", ")}>`;
}
