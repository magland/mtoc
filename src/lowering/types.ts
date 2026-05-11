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

export type ElemKind = "double" | "char";

/**
 * What we know about a single tensor dimension. The lattice is
 * intentionally coarse: we only track whether the axis is a scalar
 * broadcast (`one`) or not (`notOne`), or whether we don't know yet
 * (`unknown`). The specific size is runtime data — codegen reads it
 * off the `mtoc_tensor_t.dims[…]` fields.
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

const DIM_ONE: DimInfo = { kind: "one" };

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
 * Shape representation: `dims[i]` is the lattice value for axis `i`.
 * The invariant is `dims.length >= 2`; trailing singleton axes above
 * index 1 are stripped by factories (matching numbl's `reshape`
 * normalization rule). Today every numeric value mtoc actually
 * constructs has exactly `dims.length === 2`; the array form exists
 * so the IR can grow to N-D without further plumbing changes.
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
  /** Per-axis DimInfo. Length >= 2 (invariant — see file header). */
  dims: readonly DimInfo[];
  /** Meaningful only when `isComplex === false`; "unknown" otherwise. */
  sign: Sign;
}

/** Normalize a dims array to satisfy the `length >= 2` invariant by
 *  padding with `{kind: "one"}`, and strip trailing singletons above
 *  index 1 (matching numbl's `reshape` rule). The result has minimum
 *  length 2; any trailing axes that are statically known to be 1 are
 *  dropped down to that floor. */
function normalizeDims(dims: readonly DimInfo[]): readonly DimInfo[] {
  const padded: DimInfo[] = dims.length >= 2 ? dims.slice() : [...dims];
  while (padded.length < 2) padded.push(DIM_ONE);
  while (padded.length > 2 && padded[padded.length - 1].kind === "one") {
    padded.pop();
  }
  return padded;
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
  dims: [DIM_ONE, DIM_ONE],
  sign: "unknown",
};

/** Scalar char (1×1, C type `char`). The char elem does not carry a
 *  meaningful sign (code-unit values are unsigned by convention). */
export const SCALAR_CHAR: NumericType = {
  kind: "Numeric",
  elem: "char",
  isComplex: false,
  dims: [DIM_ONE, DIM_ONE],
  sign: "unknown",
};

/** Construct a scalar char type. */
export function scalarChar(): NumericType {
  return SCALAR_CHAR;
}

/** Construct a 1×N char-array type with the given cols DimInfo. */
export function charArrayType(cols: DimInfo): NumericType {
  return {
    kind: "Numeric",
    elem: "char",
    isComplex: false,
    dims: [DIM_ONE, cols],
    sign: "unknown",
  };
}

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
    dims: [DIM_ONE, DIM_ONE],
    sign: "unknown",
  };
}

/** Construct a row-vector type. The cols dim is `notOne` (i.e.
 *  provably ≠ 1); the specific size is runtime data and lives on
 *  `mtoc_tensor_t.dims[1]` at runtime. */
export function rowVecDouble(sign: Sign = "unknown"): NumericType {
  return {
    kind: "Numeric",
    elem: "double",
    isComplex: false,
    dims: [DIM_ONE, { kind: "notOne" }],
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
    dims: [{ kind: "notOne" }, DIM_ONE],
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
  return numericTypeND([rows, cols], isComplex, sign);
}

/** N-dimensional factory. The dims array is normalized: padded to
 *  `length >= 2` and trailing singletons above index 1 stripped
 *  (numbl's `reshape` normalization). For 2-D callers, the 2-arg
 *  `numericType(rows, cols, …)` shim above is more readable. */
export function numericTypeND(
  dims: readonly DimInfo[],
  isComplex: boolean = false,
  sign: Sign = "unknown",
  elem: ElemKind = "double"
): NumericType {
  return {
    kind: "Numeric",
    elem,
    isComplex,
    dims: normalizeDims(dims),
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

/** True when every axis is statically known to be exactly 1. */
export function isScalar(t: MType): boolean {
  return isNumeric(t) && t.dims.every(dimIsOne);
}

/** True when axis 0 is exactly 1, axis 1 is statically known to be not 1,
 *  and any further axes are 1 (trailing-singleton normalization keeps a
 *  pure row vector at exactly length 2). */
export function isRowVec(t: MType): boolean {
  return (
    isNumeric(t) &&
    t.dims.length >= 2 &&
    dimIsOne(t.dims[0]) &&
    dimIsNotOne(t.dims[1]) &&
    t.dims.slice(2).every(dimIsOne)
  );
}

/** True when axis 0 is statically not 1 and every other axis is 1. */
export function isColVec(t: MType): boolean {
  return (
    isNumeric(t) &&
    t.dims.length >= 1 &&
    dimIsNotOne(t.dims[0]) &&
    t.dims.slice(1).every(dimIsOne)
  );
}

/** A vector is a row vector or a column vector (and not a scalar). */
export function isVector(t: MType): boolean {
  return isRowVec(t) || isColVec(t);
}

/** A matrix is anything tensor-shaped that isn't a scalar or vector. */
export function isMatrix(t: MType): boolean {
  return isMultiElement(t) && !isVector(t);
}

/** Multi-element tensor (vector or matrix). At least one axis is NOT
 *  statically known to be 1 — `notOne` or `unknown` both count.
 *  Codegen uses this to pick between the bare `double` representation
 *  and `mtoc_tensor_t`; `unknown` defaults to the tensor representation
 *  because it might be > 1 at runtime (e.g. the output of `reshape`,
 *  whose per-axis sizes are runtime-determined). */
export function isMultiElement(t: MType): boolean {
  return isNumeric(t) && t.dims.some(d => !dimIsOne(d));
}

/** True when `t` is a scalar char (1×1, C `char`). */
export function isCharScalar(t: MType): boolean {
  return isNumeric(t) && t.elem === "char" && isScalar(t);
}

/** True when `t` is a multi-element char array (`mtoc_char_tensor_t`). */
export function isCharArray(t: MType): boolean {
  return isNumeric(t) && t.elem === "char" && isMultiElement(t);
}

/** True when `t`'s static shape is known to extend past 2 axes
 *  (`dims.length > 2`). Lowering sites that do not yet handle N-D
 *  tensors gate on this and emit a clear "not yet supported"
 *  diagnostic — disp, reshape, size, ndims, numel, length, and
 *  variable assignment are the only operations currently allowed
 *  to consume one. */
export function isHigherDim(t: MType): boolean {
  return isNumeric(t) && t.dims.length > 2;
}

/** True when `t` is something a "text-accepting" runtime helper can
 *  consume via `mtoc_text_view_t` — today: a `string` handle or a
 *  multi-element `char` array. Scalar chars (bare C `char`) are
 *  intentionally excluded; they keep their numeric character role
 *  (`'A' + 1`, `disp('a')` prints the byte as text via the dedicated
 *  `mtoc_disp_char`). The shared predicate lets builtins like
 *  `disp` / `error` / `assert(_, msg)` / `strcmp` and the `+`
 *  concatenation path write one code path that accepts both source
 *  kinds. */
export function isText(t: MType): boolean {
  return isString(t) || isCharArray(t);
}

/** True when the value of type `t` is backed by a heap allocation that
 *  the generated code is responsible for releasing — currently
 *  multi-element tensors (double and char) and strings. Drives the
 *  "free at last use" liveness pass, the scope-exit free walks, and
 *  the "owned-allocating expression cannot appear nested" lowering
 *  check. New owned kinds (cell arrays, structs, …) plug in here. */
export function isOwned(t: MType): boolean {
  return isMultiElement(t) || isString(t);
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
 *  (complex); char scalars become bare `char`; multi-element tensors
 *  become `mtoc_tensor_t`; char arrays become `mtoc_char_tensor_t`.
 *  Returns null for types codegen does not yet handle (Unknown, Void). */
export function cTypeFor(t: MType): string | null {
  if (t.kind === "String") return "mtoc_string_t";
  if (t.kind !== "Numeric") return null;
  if (t.elem === "char") {
    if (isScalar(t)) return "char";
    return "mtoc_char_tensor_t";
  }
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
// instead of hand-rolling a copy of every field. Adding a new scalar
// field (say, `complexKind`) means appending one entry here — the three
// shared routines pick it up automatically.
//
// Shape (`dims`) is special-cased outside this template because it is
// array-valued; the template handles only the scalar fields. The
// "rows"/"cols" entries below are synthetic canonicalize-only fragments
// that pull from `dims[0]`/`dims[1]` to preserve mangled-name hash
// compatibility with the pre-N-D 2-D form (`canonicalizeType` for a
// 2-D type produces the same JSON as before; for ndim > 2 it appends
// a `dims` field so higher axes participate in the hash).
//
// IMPORTANT: the field ORDER below is the canonical hash order. Since
// the lowerer hashes `JSON.stringify(canonicalizeType(...))` to produce
// a function specialization's mangled C name, reordering would change
// every emitted specialization name (and therefore the generated C).
// New fields MUST be appended to the end.

interface TensorFieldEntry {
  /** Output key in the canonicalized JSON object. */
  readonly name: string;
  /** Canonical-hash value contributed by this field (deterministic JSON
   *  for `canonicalizeType`). */
  readonly canonicalize: (t: NumericType) => unknown;
  /** typeToString fragment contributed by this field. Empty string is
   *  fine — the framing handles separators. */
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

/** Build a field entry for a scalar (non-array) `NumericType` key.
 *  Array-valued fields like `dims` are handled separately. */
function makeField<K extends Exclude<keyof NumericType, "dims" | "kind">>(
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
  // Synthetic rows/cols canonicalize fragments: preserve the legacy
  // {rows, cols} hash form for 2-D types. Joining is handled separately
  // by `joinDimsArray` in `unify`, so these entries are no-ops there.
  // typeToString renders dims via its own dedicated path.
  {
    name: "rows",
    canonicalize: t => t.dims[0],
    format: () => "",
    joinInto: () => true,
  },
  {
    name: "cols",
    canonicalize: t => t.dims[1],
    format: () => "",
    joinInto: () => true,
  },
  makeField(
    "sign",
    t => (t.sign === "unknown" ? "" : `sign=${t.sign}`),
    joinSign
  ),
];

/** Join two dims arrays. Pads the shorter to `max(a.length, b.length, 2)`
 *  with `{kind: "one"}`, then `joinDim`s element-wise. The result
 *  satisfies the `length >= 2` invariant on `NumericType.dims` (and is
 *  re-normalized through `normalizeDims` by the factory at the call
 *  site to strip trailing singletons). */
function joinDimsArray(
  a: readonly DimInfo[],
  b: readonly DimInfo[]
): readonly DimInfo[] {
  const len = Math.max(a.length, b.length, 2);
  const result: DimInfo[] = [];
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? DIM_ONE;
    const bi = b[i] ?? DIM_ONE;
    result.push(joinDim(ai, bi));
  }
  return result;
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
  // Build a fresh NumericType. Shape is array-valued so it's joined
  // separately; the template walks only the scalar fields.
  const out: Record<string, unknown> = {
    kind: "Numeric",
    dims: normalizeDims(joinDimsArray(a.dims, b.dims)),
  };
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

/** Broadcast two shape arrays. Pads the shorter with `{kind: "one"}`
 *  to `max(a.length, b.length, 2)`, then takes `dimMeet` element-wise.
 *  Returns `null` when any axis fails `dimAccept` (categorical
 *  mismatch — the rowVec-vs-colVec case the coarse lattice can prove
 *  incompatible).
 *
 *  Result is unnormalized — caller passes through `numericTypeND` /
 *  `normalizeDims` to strip trailing singletons. */
export function broadcastShape(
  a: readonly DimInfo[],
  b: readonly DimInfo[]
): readonly DimInfo[] | null {
  const len = Math.max(a.length, b.length, 2);
  const result: DimInfo[] = [];
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? DIM_ONE;
    const bi = b[i] ?? DIM_ONE;
    if (!dimAccept(ai, bi)) return null;
    result.push(dimMeet(ai, bi));
  }
  return result;
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
  // Char promotion: any arithmetic with at least one char operand produces
  // a double result. char + char → double, char + double → double.
  // Any other elem mismatch (if future elem kinds are added) is Unknown.
  const hasChar = a.elem === "char" || b.elem === "char";
  if (!hasChar && a.elem !== b.elem) return { kind: "Unknown" };
  const resultElem: ElemKind = hasChar ? "double" : a.elem;
  // Complex propagates: real⊙complex and complex⊙complex both produce
  // complex. Sign is meaningless on a complex result (the invariant is
  // enforced at output sites — canonicalizeType / unify normalize) so
  // we just compute it on the real branch.
  const isComplex = a.isComplex || b.isComplex;
  const sign = isComplex ? "unknown" : arithSign(op, a.sign, b.sign);

  const aSc = isScalar(a);
  const bSc = isScalar(b);

  if (aSc && bSc) {
    return numericTypeND([DIM_ONE, DIM_ONE], isComplex, sign, resultElem);
  }
  if (aSc || bSc) {
    // Scalar broadcasts to the other operand's shape.
    const tensor = aSc ? b : a;
    return numericTypeND(tensor.dims, isComplex, sign, resultElem);
  }
  // Both are tensors — only elementwise (Add/Sub) is allowed today
  // when we route here. Mul/Div on two tensors are matrix multiply /
  // matrix divide (deferred), but the lowerer maps `.* ./` to
  // `Mul`/`Div` in the abstract kind too, so we accept those here for
  // same-shape and reject in the lowerer's path that distinguishes
  // `Mul` from `ElemMul`.
  const broadcasted = broadcastShape(a.dims, b.dims);
  if (broadcasted === null) return { kind: "Unknown" };
  return numericTypeND(broadcasted, isComplex, sign, resultElem);
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
  // For ndim > 2, the synthetic rows/cols fragments above only capture
  // axes 0 and 1; append the full dims array so higher axes participate
  // in the specialization hash. For ndim === 2 this key is omitted so
  // the hash form remains byte-identical to the pre-N-D representation.
  if (normalized.dims.length > 2) {
    out.dims = normalized.dims;
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
  // dims is array-valued so rendered into the framing prefix; the
  // NUMERIC_FIELDS entries for rows/cols contribute empty fragments.
  const dims = t.dims.map(dimToString).join("x");
  const fragments = NUMERIC_FIELDS.map(f => f.format(t)).filter(s => s !== "");
  return `Numeric<${cat}(${dims}), ${fragments.join(", ")}>`;
}
