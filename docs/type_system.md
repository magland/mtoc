# Type system

Lives in `src/lowering/types.ts`. Designed to grow — the discriminated union
has room for non-numeric variants (Logical, Cell, Struct, Handle) without
reshaping. Today `Numeric`, `String`, and the sentinels are populated.

## MType

The top-level type carrier:

```
MType =
  | NumericType
  | StringType
  | { kind: "Unknown" }
  | { kind: "Void" }
```

`NumericType` covers every numeric value mtoc reasons about — scalar or
tensor, real or complex, **double-elem or char-elem**. numbl's `char`
slots into `NumericType` via the `elem` field rather than as a separate
top-level kind, because every char operation in numbl (`'A' * 2`,
`length('abc')`, `'abc' + 1`) is a numeric-tensor operation that just
happens to read its operand as a single-byte code unit. `StringType` is
the first genuinely non-numeric variant: a scalar handle to a UTF-8
buffer (numbl's `string`, distinct from `char` in shape and semantics).
`Unknown` shows up at type-check failures; `Void` is reserved for
statement-only constructs (e.g. `disp` returns nothing).

When further non-numeric kinds (Logical/Cell/Struct/Handle) get added,
they land as new top-level variants — the discriminator is already there.
Numeric code paths keep narrowing to `NumericType` without touching them.

## NumericType

```
NumericType {
  kind: "Numeric"
  elem: ElemKind        // "double" or "char" — char-elem covers numbl's `char` type
  isComplex: boolean    // tracks the complex axis; codegen picks
                        //   `double` / `double _Complex` / `mtoc_tensor_t`
                        //   accordingly. Complex tensors mirror numbl's
                        //   split storage (separate real/imag buffers).
  rows: DimInfo
  cols: DimInfo
  sign: Sign
}
```

Scalars are 1×1 numerics — there is no separate "Scalar" type. Operations
dispatch on shape via the `isScalar` / `isRowVec` / `isColVec` / `isVector` /
`isMatrix` / `isMultiElement` predicates. Codegen picks the C representation
via `cTypeFor` (bare `double` for scalars, `mtoc_tensor_t` struct for
multi-element).

The predicates intentionally return plain `boolean`, not `t is NumericType`: a
type predicate would have TS narrow `NumericType` to `never` in the false
branch, which is wrong. Callers needing `NumericType` narrowing should
`isNumeric(t)` first.

A small set of constructor helpers (`scalarDouble`, `scalarComplex`,
`rowVecDouble`, `colVecDouble`, and the general `numericType(rows, cols, …)`)
keeps lowering call sites short. The vec/scalar variants no longer take a
numeric `n` — dims are categorical and the row/col arity is `one` or `notOne`.

## DimInfo

```
DimInfo =
  | { kind: "one" }               // statically exactly 1 (broadcast axis)
  | { kind: "notOne" }            // provably not 1; specific size is runtime
                                  //   data (admits empty n=0 and any n≥2)
  | { kind: "unknown" }           // nothing known — could be 1, could not be
```

The lattice is intentionally coarse: it tracks only what's invariant under
runtime variation. A row vector's `cols` axis is `notOne` (≥ 2 or 0) regardless
of whether the actual length is 3 or 4; the size lives on
`mtoc_tensor_t.cols` at runtime. `lowerBinary`'s scalar-vs-broadcast dispatch
(and the shape predicates) only ever care about the categorical question
"is this axis a scalar broadcast?" — which the three-state lattice answers
directly.

Codegen consumes the coarse dims to pick the C representation
(`isScalar` ⇒ `double` / `double _Complex`; `isMultiElement` ⇒
`mtoc_tensor_t`). Specific row/col counts are read from
`mtoc_tensor_t.rows` / `.cols` at runtime — for tensor literals, the
lowering pass attaches the source-level cell counts to the IR's
`TensorLit.elements`, and codegen emits those as static integers at
the assignment site.

Specialization-key collapse falls out of this. Two calls
`total([1 2 3])` and `total([1 2 3 4])` canonicalize to the same
argument-type tuple (`one × notOne` row vector) and so share a single
emitted `total__<hash>` function body. The runtime size flows through
the `mtoc_tensor_t` struct.

## StringType

```
StringType { kind: "String" }
```

A scalar handle to a UTF-8 byte buffer. There are no shape fields — mtoc
treats string as scalar-only; arrays of strings (numbl's `["a", "b"]` form)
are deferred. The `STRING` constant is the singleton instance every string
expression carries.

Codegen picks `mtoc_string_t` for any `StringType` (see `cTypeFor`). The
struct is `{ const char *data; long len; int owned; }`: literals point at
`.rodata` with `owned=0`, while concat / copy results allocate a fresh
buffer with `owned=1`. The free helper consults the flag, so passing a
literal handle through `mtoc_string_assign` (or letting it fall out of
scope) is a safe no-op.

Two strings unify to a string; a string vs anything else collapses to
`Unknown`, which `recordAssignment` turns into a top-level split (or a
clear error inside control flow). `canonicalizeType` produces
`{ kind: "String" }`, so a function that takes a string parameter
specializes on a single key.

Today only one binary op is defined for strings: `+` is concatenation
(numbl's `"a" + "b" == "ab"`). Mixed string + numeric `+` is rejected with a
`TypeError` ("both operands to be strings"); other arithmetic / comparison
ops on strings raise `UnsupportedConstruct`. The introspection builtins
`length(s)` and `numel(s)` are folded to the constant `1` at lowering (numbl
semantics — a numbl `string` is a scalar handle, not a char vector).

## Sign

```
Sign = positive | nonnegative | negative | nonpositive | zero | nonzero | unknown
```

Tracked on every `NumericType`. Used by builtins to refuse translation when an
input could land outside the function's domain — `sqrt(x)` requires `x` to be
statically `nonnegative`; `log(x)` requires `positive`. The canonical pattern
when a user has only `unknown` info is `sqrt(abs(x))`.

The sign lattice has its own helpers (`signNegate`, `signAdd`, `signSub`,
`signMul`, `signDiv`, `joinSign`, `signFromValue`). The rules are conservative
but not paranoid — `pos + pos = pos`, `pos * neg = neg`, `nonneg * unknown =
unknown`, etc.

A handful of _structural_ refinements live alongside the lattice:

- `x * x` (same variable) is detected as `nonneg` regardless of `x`'s sign.
- `for k = 1:n` ⇒ `k` is `positive` inside the body, `nonneg` after the loop
  (the latter accounts for the "loop never ran" path).

## Operations

- **`unify(a, b)`** — least upper bound. Used at control-flow merges and at
  `assignedVars` accumulation (which type does a single C variable need to
  hold across all assignments). Returns `Unknown` when `elem` differs, when
  one side is `Unknown`/`Void`, or when `String` is unified with a non-String
  type — that's the trigger for the "this variable can't share one C storage
  location" error.
- **`arithResult(op, a, b)`** — result of `+ - * /` (and elementwise
  variants). Handles scalar⊙scalar, scalar↔tensor broadcast, and tensor⊙tensor
  with pointwise dim-compatible inputs. Categorical mismatches (e.g. rowVec +
  colVec) are rejected at lowering; specific runtime sizes are NOT checked at
  lowering — they're runtime data and a future stage will add an
  `mtoc_check_shape` helper. Reserved for the future: tensor⊙tensor with `*` /
  `/` (matrix multiply / divide) is an explicit unsupported case in lowering.
- **`mergeBranchEnvs(envs, span, construct)`** — joins multiple post-arm envs
  at an `if`/`while`/`for` exit. Variables present in only some arms unify
  against `scalarDouble("zero")` for the missing arms (matches the `0.0`
  predeclaration default).

## Canonicalization

`canonicalizeType` produces a deterministic field-ordered representation used
to hash a function's argument-type tuple into a stable specialization name (8
hex chars of FNV-1a 32-bit). Together with `typeToString`, it's driven by a
`NUMERIC_FIELDS` table — adding a new `NumericType` field means appending one
table entry.

## Error attribution

Type errors surface from lowering with a `Span`. The two shapes are:

- `UnsupportedConstruct(message, span)` — "this construct isn't yet supported"
  (defines a roadmap item if hit by a real program).
- `TypeError(message, span)` — "the program is well-formed numbl but
  inconsistent for static codegen" (e.g. `sqrt(x)` with `x.sign === "negative"`).

A small post-lowering `validateIR` pass catches structural invariants (tensor
literals only as `Assign` RHS, etc.) so the codegen never has to surface
errors with line-number-less stack traces.
