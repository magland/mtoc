/**
 * mtoc type system (seed).
 *
 * The numeric tower is `NumericType` — every numeric value mtoc tracks
 * is in it: scalar or tensor, real or complex, with shape carried
 * alongside element kind. Scalars are 1×1 numerics (no separate
 * "Scalar" variant). Non-numeric siblings live alongside it:
 * `StringType` for double-quoted scalar strings, `StructType` for
 * scalar structs, and `HandleType` for function handles (`@name` /
 * `@(...) ...`). The `kind` discriminator is reserved to grow further
 * variants (Logical, Char, Cell, Class) — those land when there's a
 * concrete need; keeping the discriminator means adding them won't
 * ripple through numeric-only code paths.
 */

import type { FunctionStmt } from "./astAliases.js";
import { fnv1a32Hex } from "./hashing.js";

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

/**
 * Scalar struct type. mtoc supports scalar structs (no struct arrays):
 * a fixed set of named fields, each with its own MType. The field set
 * is determined by a pre-pass (`structPrePass`) before body lowering
 * begins; field types fill in at the first assignment of each field.
 *
 * Two structs are considered the same shape when they have the same
 * sorted field-name list and the canonicalized type tuple of those
 * fields agrees. The `mangled` cache is the unique C typedef name for
 * the shape: `_mtoc_struct__<hash>` where `hash` is FNV-1a 32 over
 * `JSON.stringify({fields: [[name, canonicalize(type)], ...]})`. The
 * cache is filled on demand by `structMangledName`.
 */
export interface StructType {
  kind: "Struct";
  /** Sorted by field name for canonical hashing. */
  fields: ReadonlyArray<{ name: string; type: MType }>;
}

export function structType(
  fields: ReadonlyArray<{ name: string; type: MType }>
): StructType {
  // Defensive: sort alphabetically so callers don't have to remember
  // the canonicalization rule.
  const sorted = [...fields].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return { kind: "Struct", fields: sorted };
}

/** True when `t` is a scalar struct. */
export function isStruct(t: MType): t is StructType {
  return t.kind === "Struct";
}

/**
 * Function-handle type. Carries the statically-resolved target of a
 * `@name` or `@(...) ...` expression PLUS any variables captured from
 * the enclosing scope.
 *
 * The C representation is a real struct (one shared typedef for
 * no-capture handles, one typedef per distinct capture-tuple shape
 * otherwise). The function-call DISPATCH is still static — the
 * target's identity lives on the MType and every `h(args)` resolves
 * to a concrete mangled C function ahead of codegen. The struct
 * carries only the captures' VALUES; it has no function pointer.
 *
 * Three target shapes:
 *  - `userFunc`   — `@my_func`. Carries the resolved AST + source
 *                   file. Always has empty captures (named handles
 *                   don't capture anything).
 *  - `builtin`    — `@sin`, `@sqrt`, etc. Always has empty captures.
 *                   The call site looks the sig up via `getBuiltin`.
 *  - `anonymous`  — `@(...) ...`. The body is synthesized into a
 *                   `FunctionStmt`-shaped AST whose params are
 *                   `[...userParams, ...captureNames]`. Captures
 *                   detected by the lowering helper get snapshotted
 *                   into the handle struct at the `@(...)` site;
 *                   inside the synthesized body they appear as
 *                   regular parameters.
 *
 * Reassigning a handle to a different target identity OR a different
 * capture-tuple shape is a top-level variable split (driven by
 * `storageCategory`); inside control flow it errors with the
 * standard category-mismatch diagnostic.
 */
export type HandleTarget =
  | {
      kind: "userFunc";
      /** numbl source name of the target function (for diagnostics). */
      name: string;
      /** Source file of the target's declaration. Salts the
       *  specialization key so two same-named workspace functions in
       *  different files stay distinct. */
      file: string;
      /** Resolved AST of the target function, threaded into
       *  `specializeUserCall` at the handle-call site. Not part of the
       *  canonical hash. */
      ast: FunctionStmt;
    }
  | {
      kind: "builtin";
      /** numbl name of the builtin (e.g. "sin"). The handle-call path
       *  looks the `BuiltinSig` up via `getBuiltin` so the sig itself
       *  doesn't need to ride on the type. */
      name: string;
    }
  | {
      kind: "anonymous";
      /** Synthetic mangled-base name (`anon_<N>`) the anonymous body
       *  registers under in the specialization cache. Derived from
       *  a per-program counter so two textually distinct `@(...)`
       *  expressions have distinct identities. */
      mangledBase: string;
      /** Synthesized `function <outName> = <mangledBase>(params, captures)`
       *  AST handed to `specializeUserCall`. The params list contains
       *  the user-declared params FIRST, followed by the captures'
       *  names — so the body's references to a captured variable
       *  resolve naturally to the synthesized param. */
      ast: FunctionStmt;
      /** Source file the `@(...)` expression appeared in. */
      file: string;
    };

export interface HandleType {
  kind: "Handle";
  target: HandleTarget;
  /** Variables captured from the enclosing scope at the `@(...)`
   *  site. Each capture lands as a field in the handle's C struct;
   *  reads inside the synthesized body resolve to the parallel synth
   *  param. Empty for userFunc / builtin targets and for
   *  capture-free anonymous functions. Field order is the same as
   *  the synth function's tail params (after user-declared params),
   *  so the call site can read captures back from the struct in
   *  registration order. */
  captures: ReadonlyArray<HandleCapture>;
}

/** One captured variable on a HandleType. The `name` is the
 *  enclosing-scope identifier the @-site snapshot reads from; the
 *  same string is also the synth body's tail-param name. The `ty` is
 *  the captured value's type at the @-site. */
export interface HandleCapture {
  name: string;
  ty: MType;
}

/** True when `t` is a function handle. */
export function isHandle(t: MType): t is HandleType {
  return t.kind === "Handle";
}

/** Constructor for a `@user_func` handle. Named handles never capture. */
export function userFuncHandle(
  name: string,
  file: string,
  ast: FunctionStmt
): HandleType {
  return {
    kind: "Handle",
    target: { kind: "userFunc", name, file, ast },
    captures: [],
  };
}

/** Constructor for a `@builtin_name` handle. Builtin handles never capture. */
export function builtinHandle(name: string): HandleType {
  return {
    kind: "Handle",
    target: { kind: "builtin", name },
    captures: [],
  };
}

/** Constructor for a `@(...)` anonymous-function handle, with zero or
 *  more captured variables in registration order. */
export function anonymousHandle(
  mangledBase: string,
  ast: FunctionStmt,
  file: string,
  captures: ReadonlyArray<HandleCapture> = []
): HandleType {
  return {
    kind: "Handle",
    target: { kind: "anonymous", mangledBase, ast, file },
    captures,
  };
}

/** Stable identity string for a handle's target. Used by
 *  `storageCategory` (so two different identities split into distinct
 *  C bindings) and as the deterministic shard of `canonicalizeType`
 *  (so a higher-order function specializes per-handle-target). The
 *  identity does NOT include the captures' types — capture identity
 *  rides on a separate `capturesId` shard so the storage category
 *  reflects "same target AND same capture shape". */
function handleTargetId(target: HandleTarget): string {
  switch (target.kind) {
    case "userFunc":
      return `userFunc:${target.file}:${target.name}`;
    case "builtin":
      return `builtin:${target.name}`;
    case "anonymous":
      return `anonymous:${target.mangledBase}`;
  }
}

/** Deterministic identity of a handle's capture shape. Two handles
 *  with the same `(name, canonicalize(ty))` tuple for every capture
 *  in order produce the same id — so they share a C typedef and can
 *  unify into a single binding. */
function handleCapturesId(captures: ReadonlyArray<HandleCapture>): string {
  if (captures.length === 0) return "empty";
  return captures
    .map(c => `${c.name}:${JSON.stringify(canonicalizeType(c.ty))}`)
    .join("|");
}

/** True when two handle targets refer to the same concrete function.
 *  Captures are compared separately by `handleCapturesId`. */
function handleTargetsEqual(a: HandleTarget, b: HandleTarget): boolean {
  return handleTargetId(a) === handleTargetId(b);
}

/** True when two handles refer to the same concrete function AND
 *  carry the same capture shape (names + canonicalized types in
 *  order). Both pieces matter — a handle that captures `k:double`
 *  and one that captures `k:complex` are different shapes, and a
 *  handle capturing `k` is different from one capturing `m` even at
 *  the same type. */
function handlesEqual(a: HandleType, b: HandleType): boolean {
  return (
    handleTargetsEqual(a.target, b.target) &&
    handleCapturesId(a.captures) === handleCapturesId(b.captures)
  );
}

/** Mangled C typedef name for a handle shape. All no-capture handles
 *  share the single `_mtoc_handle_empty_t` typedef regardless of
 *  target identity (the function dispatch is static); handles with
 *  captures get a per-shape `_mtoc_handle__<8hex>` typedef hashed
 *  over the captures tuple. */
export function handleMangledName(t: HandleType): string {
  if (t.captures.length === 0) return "_mtoc_handle_empty_t";
  const canonical = JSON.stringify({
    captures: t.captures.map(c => [c.name, canonicalizeType(c.ty)]),
  });
  return `_mtoc_handle__${fnv1a32Hex(canonical)}`;
}

/** Mangled C typedef name for a struct shape. Two `StructType`s with
 *  the same canonicalized field/type tuple produce the same name. */
export function structMangledName(t: StructType): string {
  const canonical = JSON.stringify({
    fields: t.fields.map(f => [f.name, canonicalizeType(f.type)]),
  });
  return `_mtoc_struct__${fnv1a32Hex(canonical)}`;
}

/**
 * Tuple cell — fixed-shape heterogeneous container.
 *
 * A 1×N cell array whose slot count is fixed for the lifetime of a
 * variable and whose per-slot MTypes may differ. Used when a `{e1, e2,
 * …, eN}` literal is the sole pattern of assignment and every `c{i}` /
 * `c{i} = …` reference uses a constant integer index — the cell pre-
 * pass walks the body and decides between this variant and
 * `HomogeneousCellType` based on those observed patterns.
 *
 * C representation: one typedef per distinct slot-type tuple shape
 * (`_mtoc_tcell__<8hex>`) with one named field per slot (`slot_0`,
 * `slot_1`, …) — exactly the structure `StructType` uses, just with
 * positional rather than named members. Nested owned slots compose
 * through `ownedKinds` recursively.
 *
 * Two tuple cells unify iff they have the same slot count and every
 * pairwise slot type unifies; the merged shape pulls through the
 * widened types per slot (same rule as struct field merging).
 */
export interface TupleCellType {
  kind: "TupleCell";
  /** One entry per slot, in declaration (1-based source) order. The
   *  C-side field name is `slot_<index>` (0-based) — see
   *  `tupleCellSlotFieldName`. */
  slots: ReadonlyArray<MType>;
}

export function tupleCellType(slots: ReadonlyArray<MType>): TupleCellType {
  return { kind: "TupleCell", slots };
}

/** True when `t` is a fixed-shape heterogeneous cell. */
export function isTupleCell(t: MType): t is TupleCellType {
  return t.kind === "TupleCell";
}

/** Mangled C typedef name for a tuple-cell shape. Two `TupleCellType`s
 *  with the same canonicalized slot-type list produce the same name. */
export function tupleCellMangledName(t: TupleCellType): string {
  const canonical = JSON.stringify({
    slots: t.slots.map(s => canonicalizeType(s)),
  });
  return `_mtoc_tcell__${fnv1a32Hex(canonical)}`;
}

/** C field identifier for the k-th slot of a tuple cell (0-based). */
export function tupleCellSlotFieldName(k: number): string {
  return `slot_${k}`;
}

/**
 * Homogeneous cell — variable-length container of one element type.
 *
 * A 1×N cell array whose length may vary at runtime and whose every
 * slot carries the same MType. Used when the source program contains
 * dynamic-index access (`c{i}` with `i` not a constant integer literal),
 * the empty-literal pattern (`c = {}` followed by growth), or simply a
 * `{...}` literal whose slot types all agree.
 *
 * C representation: one typedef per distinct element MType
 * (`_mtoc_hcell__<8hex>`) with two fields:
 *   - `data` — pointer to `len` consecutive elements of the element's
 *     C type
 *   - `len` — current element count (`long`)
 * The buffer is heap-allocated; `_assign` consume-replaces; `_copy`
 * deep-copies (per-element via the element kind's `_copy` helper for
 * owned elements).
 *
 * Length is categorical (`one`/`notOne`/`unknown`) — the same lattice
 * used for tensor dims — so two homogeneous cells with the same elem
 * MType but different runtime lengths share one specialization key.
 */
export interface HomogeneousCellType {
  kind: "HomogeneousCell";
  /** The MType every slot carries. Any supported MType (numeric,
   *  string, struct, handle, tuple/homogeneous cell, …) is admissible;
   *  the owned-kind machinery recurses through `elem`'s helpers. */
  elem: MType;
  /** Length lattice: `one` means statically 1-element (rare —
   *  collapses into a tuple cell in most pre-pass paths but kept as
   *  the lattice for uniformity); `notOne` means provably ≥0 but ≠1
   *  (admits empty and any n≥2); `unknown` means nothing known. */
  len: DimInfo;
}

export function homogeneousCellType(
  elem: MType,
  len: DimInfo
): HomogeneousCellType {
  return { kind: "HomogeneousCell", elem, len };
}

/** True when `t` is a variable-length homogeneous cell. */
export function isHomogeneousCell(t: MType): t is HomogeneousCellType {
  return t.kind === "HomogeneousCell";
}

/** True when `t` is any kind of cell — tuple or homogeneous. */
export function isCell(t: MType): t is TupleCellType | HomogeneousCellType {
  return isTupleCell(t) || isHomogeneousCell(t);
}

/** Mangled C typedef name for a homogeneous-cell shape. Two
 *  `HomogeneousCellType`s with the same canonicalized element type
 *  produce the same name; length is NOT part of the hash (it's
 *  runtime data on the struct, like tensor dims). */
export function homogeneousCellMangledName(t: HomogeneousCellType): string {
  const canonical = JSON.stringify({ elem: canonicalizeType(t.elem) });
  return `_mtoc_hcell__${fnv1a32Hex(canonical)}`;
}

/** Maximum tensor dimensionality mtoc emits. MUST match
 *  `MTOC_MAX_NDIM` in `runtime/tensor.h`; the runtime allocator helpers
 *  (`mtoc_tensor_alloc_nd` / `mtoc_tensor_alloc_nd_complex`) `abort()`
 *  when handed an `ndim` greater than this cap. The lowerer rejects
 *  static shapes above the cap up front so the user sees a span
 *  instead of a runtime abort. */
export const MTOC_MAX_NDIM = 8;

/**
 * Class instance type. Structurally a struct with class identity baked
 * in: two class instances of different classes never share a single C
 * variable even when their property shapes coincide, and the resolver
 * sees them as `ClassInstance<className>` so its precedence rules
 * (cross-class dispatch, InferiorClasses promotion, static-method
 * detection) work correctly.
 *
 * The `properties` list is sorted by name and carries the per-property
 * MTypes; it grows incrementally as the constructor / methods assign
 * through `obj.<prop>`, exactly like StructType. The `file` shard salts
 * the mangled C typedef so two same-named classes in different
 * packages stay distinct.
 *
 * mtoc supports value-semantics classes only — assignment makes a
 * deep copy via the same `mtoc_<typedef>_copy` machinery struct uses.
 * Handle classes (`classdef X < handle`) are rejected at lowering
 * with a clear span.
 */
export interface ClassType {
  kind: "Class";
  /** Resolved class name. May be qualified ("pkg.Foo") for class
   *  inside a `+pkg/` namespace. */
  className: string;
  /** Source file (.m) the classdef was declared in. Used to salt the
   *  canonical hash so two classes with the same simple name but
   *  different declaring files stay distinct typedefs. */
  file: string;
  /** Sorted-by-name property list. Property types fill in as the
   *  constructor body assigns through `obj.<prop>`. */
  properties: ReadonlyArray<{ name: string; type: MType }>;
}

export function classType(opts: {
  className: string;
  file: string;
  properties: ReadonlyArray<{ name: string; type: MType }>;
}): ClassType {
  const sorted = [...opts.properties].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return {
    kind: "Class",
    className: opts.className,
    file: opts.file,
    properties: sorted,
  };
}

export function isClass(t: MType): t is ClassType {
  return t.kind === "Class";
}

/** Mangled C typedef name for a class shape.
 *  `_mtoc_class__<className>__<8hex>` where the hex is FNV-1a over the
 *  canonical {className, file, properties} tuple. The `<className>`
 *  segment is purely cosmetic (makes the generated C self-documenting);
 *  uniqueness is guaranteed by the hash. */
export function classMangledName(t: ClassType): string {
  const canonical = JSON.stringify({
    className: t.className,
    file: t.file,
    properties: t.properties.map(p => [p.name, canonicalizeType(p.type)]),
  });
  const safeName = t.className.replace(/[^A-Za-z0-9_]/g, "_");
  return `_mtoc_class__${safeName}__${fnv1a32Hex(canonical)}`;
}

export type MType =
  | NumericType
  | StringType
  | StructType
  | HandleType
  | TupleCellType
  | HomogeneousCellType
  | ClassType
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
 *  multi-element tensors (double and char), strings, and structs. The
 *  struct typedef itself is a flat aggregate but it can transitively
 *  own tensors / strings / nested structs; even an all-scalar struct
 *  is treated as owned so the codegen pattern (`assign` / `free` /
 *  `copy`) stays uniform across struct shapes. Drives the "free at
 *  last use" liveness pass, the scope-exit free walks, and the
 *  "owned-allocating expression cannot appear nested" lowering check. */
export function isOwned(t: MType): boolean {
  // Function handles are treated as owned for uniform machinery —
  // the per-shape typedef gets `_empty`/`_free`/`_copy`/`_assign`
  // helpers like any other struct. For no-capture handles these
  // helpers are trivial (no heap fields) but routing through the
  // owned-kind pipeline keeps every declaration / assign / scope-
  // exit-free dispatch site identical across handle shapes.
  //
  // Class instances are always owned: like structs they may carry
  // transitively-owned property values (tensors, strings, nested
  // structs, nested classes), so even an all-scalar class goes
  // through the owned-kind pipeline for uniformity.
  return (
    isMultiElement(t) ||
    isString(t) ||
    isStruct(t) ||
    isHandle(t) ||
    isCell(t) ||
    isClass(t)
  );
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
 *  become `mtoc_tensor_t`; char arrays become `mtoc_char_tensor_t`;
 *  structs become their unique-per-shape typedef name. Returns null
 *  for types codegen does not yet handle (Unknown, Void). */
export function cTypeFor(t: MType): string | null {
  if (t.kind === "String") return "mtoc_string_t";
  if (t.kind === "Struct") return structMangledName(t);
  // Function handles get a per-shape struct typedef. No-capture
  // handles share one `_mtoc_handle_empty_t` typedef (placeholder
  // field so the struct is standards-conformant); with-capture
  // handles get a `_mtoc_handle__<8hex>` typedef per distinct
  // capture-tuple shape. The function dispatch is still static —
  // the struct only carries captures.
  if (t.kind === "Handle") return handleMangledName(t);
  if (t.kind === "TupleCell") return tupleCellMangledName(t);
  if (t.kind === "HomogeneousCell") return homogeneousCellMangledName(t);
  if (t.kind === "Class") return classMangledName(t);
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

/** Stable identifier for the C storage slot a value of type `t` will
 *  occupy. Two types share a single predeclared C variable iff they
 *  return the same non-null category — codegen picks one C type per
 *  binding (bare `double` vs `double _Complex` vs `mtoc_tensor_t` vs
 *  `mtoc_char_tensor_t` vs `mtoc_string_t` vs the `char` scalar slot),
 *  and an assignment that crosses categories has to split into a
 *  fresh binding.
 *
 *  Null marks "no shareable category" — `Unknown` / `Void` / a numeric
 *  type with `unknown` dims that classifies as neither scalar nor
 *  multi-element. Adding a new owned kind (cells, structs, classes)
 *  is a new branch here; every per-category dispatch site
 *  (`canShareStorage`, `absentDefaultFor`) picks it up automatically. */
/** Discriminator over the C-storage-slot categories a value's type
 *  can occupy. Two types share a single predeclared C variable iff
 *  they produce the same `StorageCategory.kind` AND the same `.id`.
 *  Adding a new owned kind appends one variant here and one branch
 *  in `storageCategory`; the `kind` discriminator is what every
 *  category-aware dispatcher (e.g. `absentDefaultFor`) switches on,
 *  replacing the prior `cat.startsWith("struct:")` string sniff. */
export type CategoryKind =
  | "scalar-real"
  | "scalar-complex"
  | "scalar-char"
  | "tensor-real"
  | "tensor-complex"
  | "char-array"
  | "string"
  | "struct"
  | "handle"
  | "tuple-cell"
  | "homogeneous-cell"
  | "class";

/** Stable identity for a C storage slot. `kind` is the coarse category
 *  used by dispatchers; `id` carries enough additional detail to
 *  distinguish slots within the same kind (struct field-name set,
 *  handle target+captures identity). Two types share a slot iff their
 *  full `id` strings match. */
export interface StorageCategory {
  kind: CategoryKind;
  id: string;
}

export function storageCategory(t: MType): StorageCategory | null {
  if (t.kind === "String") return { kind: "string", id: "string" };
  if (t.kind === "Handle") {
    // Storage category encodes both the resolved target identity AND
    // the capture-tuple shape — two handles share a binding only
    // when they have the same target AND the same captures (so they
    // dispatch to the same C function AND the same struct typedef).
    // Different targets OR different capture shapes trip
    // `canShareStorage` and fall into the split / error path
    // depending on `controlDepth`.
    return {
      kind: "handle",
      id: `handle:${handleTargetId(t.target)}:${handleCapturesId(t.captures)}`,
    };
  }
  if (t.kind === "Struct") {
    // Storage category is keyed on the SORTED FIELD-NAME SET only,
    // not on the field types. Two struct values with the same field
    // names share a single C variable; their final field types come
    // from `unify`, which widens compatibly (e.g. scalar real with
    // sign=positive then sign=negative widens to sign=unknown). When
    // unify can't bridge two field types (e.g. scalar vs tensor),
    // it returns Unknown and `recordAssignment` falls into the error
    // path. Recording the final widened type then lets `cTypeFor`
    // pick a single, stable typedef name for the variable's lifetime.
    return {
      kind: "struct",
      id: `struct:{${t.fields.map(f => f.name).join(",")}}`,
    };
  }
  if (t.kind === "TupleCell") {
    // Tuple-cell storage category is keyed on the slot count only;
    // per-slot types may widen across assignments under the same
    // rule that lets struct fields widen. Two tuple cells with the
    // same arity share one C variable; their final per-slot types
    // come from `unify`, which widens compatibly.
    return {
      kind: "tuple-cell",
      id: `tuple-cell:${t.slots.length}`,
    };
  }
  if (t.kind === "HomogeneousCell") {
    // Homogeneous-cell storage category is keyed on the element
    // type's STORAGE CATEGORY (not the full type). That way two
    // homogeneous cells whose elem types share a C slot (e.g. two
    // double scalars with different signs) share one C cell binding;
    // their final elem type comes from `unify`. The runtime length
    // lives on the struct, like tensor dims.
    const elemCat = storageCategory(t.elem);
    const elemKey = elemCat === null ? "unknown" : elemCat.id;
    return {
      kind: "homogeneous-cell",
      id: `homogeneous-cell:${elemKey}`,
    };
  }
  if (t.kind === "Class") {
    // Storage category is keyed on the class identity (file + name)
    // only — not on the property types. Two ClassType values for the
    // same class share a single C variable; their property types
    // widen via `unify`, just like struct fields. Two different
    // classes never share storage even when their property shapes
    // happen to coincide.
    return {
      kind: "class",
      id: `class:${t.file}:${t.className}`,
    };
  }
  if (t.kind !== "Numeric") return null;
  if (t.elem === "char") {
    if (isScalar(t)) return { kind: "scalar-char", id: "scalar-char" };
    if (isMultiElement(t)) return { kind: "char-array", id: "char-array" };
    return null;
  }
  // elem === "double"
  if (isScalar(t)) {
    return t.isComplex
      ? { kind: "scalar-complex", id: "scalar-complex" }
      : { kind: "scalar-real", id: "scalar-real" };
  }
  if (isMultiElement(t)) {
    return t.isComplex
      ? { kind: "tensor-complex", id: "tensor-complex" }
      : { kind: "tensor-real", id: "tensor-real" };
  }
  return null;
}

/** Can two types share a single predeclared C variable? Equivalent to
 *  "same non-null storage category id" — codegen picks one C type per
 *  binding, and a real-tensor predecl can't hold a complex-tensor
 *  value. Specific runtime size is NOT part of the category; tensor
 *  reassignments at the same coarse shape free and realloc the
 *  backing buffer in place.
 *
 *  One special case: a `HomogeneousCell<Unknown>` (the type of an
 *  empty `c = {}` literal before any slot is written) widens to any
 *  concrete-elem homogeneous cell. This is what makes the "empty
 *  cell, then grow inside a loop" pattern legal — the storage slot
 *  is decided by the eventual concrete elem, and the prior empty
 *  handle was zero-valued anyway. */
export function canShareStorage(prev: MType, next: MType): boolean {
  const pc = storageCategory(prev);
  const nc = storageCategory(next);
  if (pc === null || nc === null) return false;
  if (pc.id === nc.id) return true;
  if (
    pc.kind === "homogeneous-cell" &&
    nc.kind === "homogeneous-cell" &&
    (homogeneousCellElemIsUnknown(prev) || homogeneousCellElemIsUnknown(next))
  ) {
    return true;
  }
  return false;
}

function homogeneousCellElemIsUnknown(t: MType): boolean {
  return isHomogeneousCell(t) && t.elem.kind === "Unknown";
}

/** The "absent default" type a control-flow branch merge picks when
 *  a variable is assigned on some arms but not others. The value seen
 *  at the merge point on the absent arm is the codegen-predeclared
 *  default for the variable's C slot: `0.0` for numeric, `'\0'` for
 *  scalar char, `mtoc_char_tensor_empty()` for char arrays,
 *  `mtoc_string_empty()` for strings. The merge picks the absent
 *  default to match the shared category of the present types so the
 *  merge stays well-typed; mixed-category branches fall back to
 *  `scalarDouble("zero")` (and the caller's unify pass will then
 *  surface a clear conflict error). */
export function absentDefaultFor(present: ReadonlyArray<MType>): MType {
  if (present.length === 0) return scalarDouble("zero");
  const cat = storageCategory(present[0]);
  if (cat === null) return scalarDouble("zero");
  for (let i = 1; i < present.length; i++) {
    const other = storageCategory(present[i]);
    if (other === null || other.id !== cat.id) return scalarDouble("zero");
  }
  switch (cat.kind) {
    case "string":
      return STRING;
    case "char-array":
      return charArrayType({ kind: "notOne" });
    case "scalar-char":
      return scalarChar();
    case "struct":
      // Every arm carries the same struct shape (category-id equality
      // above guaranteed it), so the absent default is that shape —
      // the predeclared empty handle matches it field-for-field.
      return present[0];
    case "handle":
      // Every arm carries the same handle target + capture shape. An
      // absent arm produces no codegen issue: handles' C declarations
      // are zero-init structs whose only liability is the per-shape
      // typedef being in scope (which the predeclaration ensures).
      return present[0];
    case "tuple-cell":
      // Same arity across every arm (category-id guaranteed it). The
      // absent default is that shape — its predeclared empty handle
      // is a zero-init struct that frees cleanly at scope exit.
      return present[0];
    case "homogeneous-cell":
      // Same elem-storage-category across every arm. The absent
      // default is one of the present types (an empty homogeneous
      // cell of that elem shape) — predeclaration zero-inits
      // `{data=NULL, len=0}` which the free helper handles.
      return present[0];
    case "class":
      // Every arm carries the same class identity (storage-category
      // equality above guaranteed it). The absent default is that
      // shape — its predeclared empty handle is a zero-init struct
      // that frees cleanly at scope exit.
      return present[0];
    case "scalar-real":
    case "scalar-complex":
    case "tensor-real":
    case "tensor-complex":
      return scalarDouble("zero");
  }
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
  // Handle: two handles unify iff both their target identity AND
  // their capture shape match — the C struct layout depends on the
  // captures, and the dispatch depends on the target, so both pieces
  // must agree for a single binding to hold both values. Different
  // identity OR different captures collapses to Unknown so
  // `recordAssignment` produces a clear category-mismatch diagnostic.
  if (a.kind === "Handle" || b.kind === "Handle") {
    if (a.kind !== "Handle" || b.kind !== "Handle") return { kind: "Unknown" };
    return handlesEqual(a, b) ? a : { kind: "Unknown" };
  }
  // Struct sibling variant. Two structs unify iff they have the same
  // field-name set AND each pairwise field type unifies. Different
  // field sets or any field-pair unify→Unknown collapses the whole
  // result to Unknown — which `recordAssignment` reports as a
  // category mismatch (different shapes ⇒ different C typedefs).
  if (a.kind === "Struct" || b.kind === "Struct") {
    if (a.kind !== "Struct" || b.kind !== "Struct") return { kind: "Unknown" };
    if (a.fields.length !== b.fields.length) return { kind: "Unknown" };
    const merged: { name: string; type: MType }[] = [];
    for (let i = 0; i < a.fields.length; i++) {
      const af = a.fields[i];
      const bf = b.fields[i];
      if (af.name !== bf.name) return { kind: "Unknown" };
      const u = unify(af.type, bf.type);
      if (u.kind === "Unknown") return { kind: "Unknown" };
      merged.push({ name: af.name, type: u });
    }
    return structType(merged);
  }
  // TupleCell sibling variant. Two tuple cells unify iff they have
  // the same slot count AND every pairwise slot type unifies. The
  // arity rule mirrors struct's field-name-set rule — different
  // arities are different shapes and produce different C typedefs.
  if (a.kind === "TupleCell" || b.kind === "TupleCell") {
    if (a.kind !== "TupleCell" || b.kind !== "TupleCell") {
      return { kind: "Unknown" };
    }
    if (a.slots.length !== b.slots.length) return { kind: "Unknown" };
    const merged: MType[] = [];
    for (let i = 0; i < a.slots.length; i++) {
      const u = unify(a.slots[i], b.slots[i]);
      if (u.kind === "Unknown") return { kind: "Unknown" };
      merged.push(u);
    }
    return tupleCellType(merged);
  }
  // Class sibling variant. Two ClassTypes unify iff they have the
  // same class identity (file + className) AND every pairwise
  // property type unifies. Different classes never unify even when
  // their property shapes coincide — distinct typedefs, distinct C
  // storage. Property-level unify→Unknown collapses the whole
  // result to Unknown so `recordAssignment` reports a clear
  // category mismatch.
  if (a.kind === "Class" || b.kind === "Class") {
    if (a.kind !== "Class" || b.kind !== "Class") return { kind: "Unknown" };
    if (a.className !== b.className || a.file !== b.file) {
      return { kind: "Unknown" };
    }
    if (a.properties.length !== b.properties.length) return { kind: "Unknown" };
    const merged: { name: string; type: MType }[] = [];
    for (let i = 0; i < a.properties.length; i++) {
      const ap = a.properties[i];
      const bp = b.properties[i];
      if (ap.name !== bp.name) return { kind: "Unknown" };
      const u = unify(ap.type, bp.type);
      if (u.kind === "Unknown") return { kind: "Unknown" };
      merged.push({ name: ap.name, type: u });
    }
    return classType({
      className: a.className,
      file: a.file,
      properties: merged,
    });
  }
  // HomogeneousCell sibling variant. Two homogeneous cells unify iff
  // their element types unify; the runtime length joins via the same
  // DimInfo lattice as tensor dims. An Unknown elem (produced by an
  // empty `c = {}` literal before the first slot write fills in the
  // type) is treated as bottom — it loses to any concrete elem so
  // the canonical "empty cell, then grow" pattern widens cleanly.
  if (a.kind === "HomogeneousCell" || b.kind === "HomogeneousCell") {
    if (a.kind !== "HomogeneousCell" || b.kind !== "HomogeneousCell") {
      return { kind: "Unknown" };
    }
    let elemU: MType;
    if (a.elem.kind === "Unknown") elemU = b.elem;
    else if (b.elem.kind === "Unknown") elemU = a.elem;
    else {
      elemU = unify(a.elem, b.elem);
      if (elemU.kind === "Unknown") return { kind: "Unknown" };
    }
    return homogeneousCellType(elemU, joinDim(a.len, b.len));
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

/** Per-axis result under MATLAB's implicit-expansion (broadcasting)
 *  rule: an axis of size 1 expands to match the other operand's size.
 *  Combined statically over the DimInfo lattice:
 *    (one, one)            → one
 *    (one, notOne)         → notOne          (the `one` side expands)
 *    (one, unknown)        → unknown         (other side might be 1 or not)
 *    (notOne, notOne)      → notOne          (must match at runtime; both
 *                                              not-1 ⇒ result not-1)
 *    (notOne, unknown)     → notOne          (unknown is either 1 → notOne
 *                                              expands, or matches → notOne)
 *    (unknown, unknown)    → unknown
 *    (symmetric closure)
 *  Note: no static rejection — two `notOne` axes of different runtime
 *  sizes are caught at runtime by `mtoc_broadcast_dim`. */
function dimBroadcast(a: DimInfo, b: DimInfo): DimInfo {
  if (a.kind === "one") return b;
  if (b.kind === "one") return a;
  // Both are notOne or unknown. `notOne` wins over `unknown` because
  // either the unknown side is 1 (broadcasts to notOne) or it matches
  // notOne at runtime — both yield a notOne result.
  if (a.kind === "notOne" || b.kind === "notOne") return { kind: "notOne" };
  return { kind: "unknown" };
}

/** Combine two shape arrays under the broadcasting rule. Pads the
 *  shorter with `{kind: "one"}` to `max(a.length, b.length, 2)`, then
 *  broadcasts per-axis. Never returns null — every pair is statically
 *  compatible under broadcasting; runtime size mismatch (two non-1
 *  axes that don't match) is trapped by `mtoc_broadcast_dim`.
 *
 *  Result is unnormalized — caller passes through `numericTypeND` /
 *  `normalizeDims` to strip trailing singletons. */
export function broadcastShape(
  a: readonly DimInfo[],
  b: readonly DimInfo[]
): readonly DimInfo[] {
  const len = Math.max(a.length, b.length, 2);
  const result: DimInfo[] = [];
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? DIM_ONE;
    const bi = b[i] ?? DIM_ONE;
    result.push(dimBroadcast(ai, bi));
  }
  return result;
}

/**
 * Result of an arithmetic binary op on two values.
 *
 * The shape rule (MATLAB implicit expansion / broadcasting):
 *  - scalar ⊙ scalar       → scalar
 *  - scalar ⊙ tensor       → tensor (same shape as the tensor)
 *  - tensor ⊙ scalar       → tensor (same shape as the tensor)
 *  - tensor ⊙ tensor       → per-axis broadcast (`broadcastShape`):
 *                            an axis of size 1 expands to match the
 *                            other operand. Runtime size mismatch
 *                            between two non-1 axes is trapped by
 *                            `mtoc_broadcast_dim`.
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
    // Scalar broadcasts to the other operand's shape — fast-path so
    // the legacy 2-D `scalar+tensor` emission stays byte-identical
    // with the pre-broadcasting form.
    const tensor = aSc ? b : a;
    return numericTypeND(tensor.dims, isComplex, sign, resultElem);
  }
  // Both are tensors — per-axis broadcast.
  const broadcasted = broadcastShape(a.dims, b.dims);
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
  if (t.kind === "Handle") {
    // Encode both the target's identity and the canonicalized
    // capture tuple. This is what makes a higher-order function
    // specialize per-handle: `apply(@foo, x)` vs `apply(@bar, x)`
    // differ in the target shard; two anonymous handles with
    // different capture types differ in the captures shard. The
    // AST is excluded — only the type-level identity participates.
    return {
      kind: "Handle",
      target: handleTargetId(t.target),
      captures: t.captures.map(c => [c.name, canonicalizeType(c.ty)]),
    };
  }
  if (t.kind === "Struct") {
    return {
      kind: "Struct",
      // Field names are already sorted by the constructor; recurse on
      // each field type so the canonicalization is deep.
      fields: t.fields.map(f => [f.name, canonicalizeType(f.type)]),
    };
  }
  if (t.kind === "TupleCell") {
    return {
      kind: "TupleCell",
      slots: t.slots.map(s => canonicalizeType(s)),
    };
  }
  if (t.kind === "HomogeneousCell") {
    // Length is runtime data on the struct (not part of the typedef
    // hash), so it's excluded here. The element type's canonical
    // form is what makes two homogeneous cells share a specialization.
    return {
      kind: "HomogeneousCell",
      elem: canonicalizeType(t.elem),
    };
  }
  if (t.kind === "Class") {
    // Class identity (file + name) plus the canonicalized property
    // tuple. Higher-order callers / method specializations key on
    // this shard via `canonicalizeType` of every arg type.
    return {
      kind: "Class",
      className: t.className,
      file: t.file,
      properties: t.properties.map(p => [p.name, canonicalizeType(p.type)]),
    };
  }
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
  if (t.kind === "Handle") {
    let label: string;
    switch (t.target.kind) {
      case "userFunc":
        label = `@${t.target.name} from ${t.target.file}`;
        break;
      case "builtin":
        label = `@${t.target.name}`;
        break;
      case "anonymous":
        label = `@(...) ${t.target.mangledBase}`;
        break;
    }
    if (t.captures.length === 0) return `Handle<${label}>`;
    const caps = t.captures
      .map(c => `${c.name}:${typeToString(c.ty)}`)
      .join(", ");
    return `Handle<${label}, captures={${caps}}>`;
  }
  if (t.kind === "Struct") {
    const parts = t.fields.map(f => `${f.name}:${typeToString(f.type)}`);
    return `Struct<{${parts.join(", ")}}>`;
  }
  if (t.kind === "TupleCell") {
    const parts = t.slots.map(s => typeToString(s));
    return `TupleCell<{${parts.join(", ")}}>`;
  }
  if (t.kind === "HomogeneousCell") {
    return `HomogeneousCell<${typeToString(t.elem)}, len=${dimToString(t.len)}>`;
  }
  if (t.kind === "Class") {
    const parts = t.properties.map(p => `${p.name}:${typeToString(p.type)}`);
    return `Class<${t.className}, {${parts.join(", ")}}>`;
  }
  const cat = shapeCategory(t);
  // dims is array-valued so rendered into the framing prefix; the
  // NUMERIC_FIELDS entries for rows/cols contribute empty fragments.
  const dims = t.dims.map(dimToString).join("x");
  const fragments = NUMERIC_FIELDS.map(f => f.format(t)).filter(s => s !== "");
  return `Numeric<${cat}(${dims}), ${fragments.join(", ")}>`;
}
