# Type system

Lives in `src/lowering/types.ts`. Designed to grow — the discriminated union
has room for non-numeric variants (Logical, Class) without reshaping. Today
`Numeric`, `String`, `Struct`, `Handle`, `TupleCell`, `HomogeneousCell`, and
the sentinels are populated.

## MType

The top-level type carrier:

```
MType =
  | NumericType
  | StringType
  | StructType
  | HandleType
  | TupleCellType
  | HomogeneousCellType
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

When further non-numeric kinds (Logical/Class) get added, they land as new
top-level variants — the discriminator is already there. Numeric code paths
keep narrowing to `NumericType` without touching them.

## NumericType

```
NumericType {
  kind: "Numeric"
  elem: ElemKind        // "double" or "char" — char-elem covers numbl's `char` type
  isComplex: boolean    // tracks the complex axis; codegen picks
                        //   `double` / `double _Complex` / `mtoc_tensor_t`
                        //   accordingly. Complex tensors mirror numbl's
                        //   split storage (separate real/imag buffers).
  dims: DimInfo[]       // per-axis dim lattice; invariant length >= 2,
                        //   matching numbl's min-2 padding convention.
                        //   Trailing singletons above index 1 are stripped
                        //   by the `numericTypeND` factory (numbl's
                        //   `reshape` normalization rule).
  sign: Sign
}
```

Scalars are 1×1 numerics — there is no separate "Scalar" type. Operations
dispatch on shape via the `isScalar` / `isRowVec` / `isColVec` / `isVector` /
`isMatrix` / `isMultiElement` predicates. Codegen picks the C representation
via `cTypeFor` (bare `double` for scalars, `mtoc_tensor_t` struct for
multi-element).

The dims array has invariant length >= 2; for 2-D values (the common case
today) it is exactly `[rowsDim, colsDim]`. Builtins that produce N-D
results (`reshape`) push longer arrays through `numericTypeND`. The
`isHigherDim` predicate guards the operations that don't yet support
`ndim > 2` (arithmetic, indexing, slicing) with a clear "not yet
supported" diagnostic.

The predicates intentionally return plain `boolean`, not `t is NumericType`: a
type predicate would have TS narrow `NumericType` to `never` in the false
branch, which is wrong. Callers needing `NumericType` narrowing should
`isNumeric(t)` first.

A small set of constructor helpers (`scalarDouble`, `scalarComplex`,
`rowVecDouble`, `colVecDouble`, the 2-D shim `numericType(rows, cols, …)`,
and the N-D factory `numericTypeND(dims, …)`) keeps lowering call sites
short. The vec/scalar variants no longer take a numeric `n` — dims are
categorical and each axis is `one`, `notOne`, or `unknown`.

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
`mtoc_tensor_t`). Specific dim sizes are read from
`mtoc_tensor_t.dims[i]` at runtime — for tensor literals, the lowering
pass attaches the source-level cell counts to the IR's
`TensorLit.elements`, and codegen emits those as static integers at
the assignment site. `isMultiElement` treats `unknown` as multi-element
so reshape's runtime-shape result lands in the tensor representation.

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

## StructType

```
StructType {
  kind: "Struct"
  fields: ReadonlyArray<{ name: string; type: MType }>   // sorted by name
}
```

A scalar struct value carrying a fixed set of named fields, each with
its own MType. Struct support is **scalar-only** in v1 — no struct
arrays. The field-name set for a given local variable is determined
by a pre-pass (`structPrePass.ts`) that walks the entire body before
lowering, so the struct's C typedef is stable across the variable's
lifetime. Field types fill in at the first assignment of each field
and widen via `unify` on subsequent assignments — for example, two
scalar-double assignments with different signs widen to `unknown`
sign, like any other scalar reassignment.

Two structs unify iff they have the same field-name set and every
pairwise field type unifies; otherwise the result is `Unknown` and
`recordAssignment` turns it into a clear conflict error. The
`storageCategory` arm for structs is keyed on the field-NAME SET only
(not field types), so a sign-only widening of a scalar field doesn't
trigger a per-struct-shape split.

`cTypeFor(structType)` returns a mangled `_mtoc_struct__<hash>`
typedef name; the hash is FNV-1a 32 over the canonicalized
`{fields: [[name, canonicalize(type)], ...]}` representation, so two
identical struct shapes (same field-name list AND same canonical
field types) share one typedef in the emitted C. The post-lowering
`normalizeStructTypes` pass walks every IR node and rewrites
struct-typed Var/MemberLoad/StructLit nodes to use the FINAL widened
type from `assignedVars`, so the generated C emits exactly one
typedef per logical variable. Without that pass, intermediate
widening states would leak into the IR and cause duplicate typedefs.

Codegen for structs lives in `src/codegen/emitStruct.ts`. Per unique
struct shape the codegen emits a typedef plus five helpers
(`<typedef>_empty`, `_free`, `_copy`, `_assign`, `_disp`); the
`ownedKinds` and `dispKinds` registries route the relevant per-kind
dispatch sites (declarations, scope-exit frees, the
`mtoc_<kind>_assign` consume-replace pattern, `disp(s)`) through
those generated helpers.

Today only one binary op is defined for strings: `+` is concatenation
(numbl's `"a" + "b" == "ab"`). Mixed string + numeric `+` is rejected with a
`TypeError` ("both operands to be strings"); other arithmetic / comparison
ops on strings raise `UnsupportedConstruct`. The introspection builtins
`length(s)` and `numel(s)` are folded to the constant `1` at lowering (numbl
semantics — a numbl `string` is a scalar handle, not a char vector).

## TupleCellType

```
TupleCellType {
  kind: "TupleCell"
  slots: ReadonlyArray<MType>   // one entry per slot, source order
}
```

A 1-D cell array whose arity is fixed for the lifetime of a variable and
whose per-slot types may differ. Picked by the cell pre-pass
(`src/lowering/cellPrePass.ts`) when every `c{k}` / `c{k} = …` access uses
a literal integer index AND no empty `c = {}` literal appears.

C representation: one typedef per distinct canonicalized slot-type tuple,
`_mtoc_tcell__<8hex>` with positional fields `slot_0`, `slot_1`, ….
Codegen for `c{k}` resolves to a typed field access; the tuple-cell
codegen lives in `src/codegen/emitTupleCell.ts` and shares the
named-typedef scaffolding (`src/codegen/emitNamedTypedef.ts`) with
struct / handle codegen. Owned slot types (string, tensor, struct, cell)
compose through `ownedKinds` recursively.

Two tuple cells unify iff they have the same slot count AND every
pairwise slot type unifies; the merged shape pulls through the widened
types per slot (same rule as struct field merging).

`storageCategory` for tuple cells is keyed on the slot count only
(`tuple-cell:N`), so per-slot type widening doesn't trigger a binding
split — `normalizeStructTypes` propagates the final widened slot types
to every IR reference at the end of lowering.

## HomogeneousCellType

```
HomogeneousCellType {
  kind: "HomogeneousCell"
  elem: MType                   // every slot carries this type
  len: DimInfo                  // length lattice — runtime size lives on the struct
}
```

A 1-D cell array whose length may vary at runtime and whose every slot
carries the same MType. Picked by the cell pre-pass when ANY of:

- some `c{i}` / `c{i} = …` uses a non-literal index, OR
- an empty `c = {}` literal appears, OR
- only curly-index reads / writes appear (no literal anchors the
  tuple's static arity)

C representation: one typedef per distinct canonicalized element type,
`_mtoc_hcell__<8hex>` with two fields:

- `data` — pointer to `len` consecutive elements of the elem's C type
- `len` — current element count (`long`)

Helpers are emitted directly by `src/codegen/emitHomogeneousCell.ts`:
`_empty` (zero handle), `_free` (per-element free for owned elems +
`free(data)`), `_copy` (deep copy via the elem-kind's `_copy`),
`_assign` (consume-replace), `_disp` (numbl-style `{e1, …}\n`), and
`_grow` (extend the buffer to fit a new highest index, zero-initializing
new slots — drives the `c{k} = v` auto-grow rule).

The empty literal `c = {}` produces a `HomogeneousCell<Unknown, len=notOne>`;
the Unknown elem is treated as bottom by `unify` (it loses to any
concrete elem on first slot write) and by `canShareStorage` (Unknown elem
matches any concrete-elem cell for the purpose of widening a single C
binding). The actual typedef emitted is the one for the final widened
elem, propagated via `normalizeStructTypes`.

Length is categorical (`one`/`notOne`/`unknown`) — the same lattice used
for tensor dims — so two homogeneous cells with the same elem MType but
different runtime lengths share one specialization.

`storageCategory` for homogeneous cells is keyed on the elem's storage
category (`homogeneous-cell:<elem-storage-id>`); `canShareStorage` has a
special case that treats an Unknown elem as matching any concrete elem
so the empty-cell-then-grow pattern doesn't split bindings.

## HandleType

```
HandleType {
  kind: "Handle"
  target: HandleTarget
  captures: ReadonlyArray<{ name; ty }>
}

HandleTarget =
  | { kind: "userFunc"; name; file; ast }          // @my_func
  | { kind: "builtin";  name }                      // @sin
  | { kind: "anonymous"; mangledBase; ast; file }   // @(x) ...
```

A function-handle type carrying the _statically resolved_ target of an
`@name` or `@(...) ...` expression PLUS the variables captured from
the enclosing scope at the `@(...)` site. The C representation is a
real struct (one shared `_mtoc_handle_empty_t` typedef for every
no-capture handle, one per-shape `_mtoc_handle__<8hex>` typedef per
distinct capture-tuple shape otherwise). The function-call DISPATCH
remains static — every `h(args)` call site reads the bound variable's
`HandleType` and resolves to a concrete mangled C function at lowering
time; the struct only carries the captures' VALUES, no function
pointer.

Three properties fall out of "identity lives in the type":

- **`unify(handle_a, handle_b)`** returns `handle_a` iff both target
  identity AND capture shape match. Mismatch collapses to `Unknown`,
  which `recordAssignment` reports as a clear category conflict.
- **`storageCategory(handle)`** encodes both the target identity and
  the capture-tuple shape (`handle:<target-id>:<captures-id>`).
  `canShareStorage` therefore returns false across distinct targets OR
  distinct capture shapes — `f = @foo; f = @bar` at top level splits
  into a fresh C binding, and inside control flow it errors with the
  standard category-mismatch diagnostic.
- **`canonicalizeType(handle)`** encodes both the target's identity
  and the canonicalized capture tuple. A higher-order function
  `apply(h, x)` specializes per-handle-target AND per-capture-shape:
  `apply(@foo, x)` and `apply(@bar, x)` produce two distinct
  `apply__<hex>` specializations.

Codegen consequences:

- `cTypeFor(HandleType)` returns the per-shape typedef name. No-capture
  handles share `_mtoc_handle_empty_t` (a struct with a single
  `char _placeholder` field for standards-conformant C); with-capture
  handles use `_mtoc_handle__<8hex>` with one `cap_<name>` field per
  capture.
- Handles are an owned kind in the registry (see
  `src/codegen/ownedKinds.ts`). Each per-shape typedef gets generated
  `_empty` / `_free` / `_copy` / `_assign` helpers via
  `src/codegen/emitHandle.ts`, mirroring `emitStruct.ts`. Captured
  tensors / strings / nested structs / nested handles compose
  recursively through the owned-kind dispatch.
- Function returns of a HandleType use the standard owned return-by-
  value path: the factory function's body installs the captures into
  the return handle, and the caller consumes it via the handle's
  `_assign` helper.
- A handle's compound literal `(<typedef>){.cap_<name> = <value>, ...}`
  appears as the RHS of an Assign at the `@(...)` site. Owned captures
  are wrapped in their kind's `_copy` helper so the snapshot is
  independent of subsequent reassignments at the source binding.
- At each `h(args)` call site, `lowerHandle.ts::lowerHandleCall`
  builds the underlying call's args as
  `[<user-args>..., HandleCaptureLoad(h, cap_1), HandleCaptureLoad(h, cap_2), ...]`,
  feeding the captures from the struct's fields. The synth function's
  param list mirrors that order (`[...userParams, ...captureNames]`)
  so positional binding lines up.

Anonymous functions get a synthesized `FunctionStmt` AST whose params
list is `[...userParams, ...captureNames]` and a counter-derived
`mangledBase` (`anon_<N>`). The output assign is `anonOut_<N>`. The
synth body's references to a captured variable resolve to the synth
function's tail param of the same name.

Storage-category guarantees: a `Handle:userFunc:<file>:<name>` ≠
`Handle:userFunc:<file>:<other-name>` ≠ `Handle:builtin:<name>` ≠
`Handle:anonymous:<mangledBase>`, and within each target identity
distinct capture-tuple shapes produce distinct categories. Two
anonymous expressions at different source spans bump the shared
counter and always produce distinct identities even before captures
are considered.

`normalizeStructTypes` extends to handles: after lowering, every
HandleType's captures are rewritten to use the binds-aligned final
widened types (the same machinery that ensures every struct reference
uses a single canonical typedef per logical variable).

## Sign

```
Sign = positive | nonnegative | negative | nonpositive | zero | nonzero | unknown
```

Tracked on every `NumericType`. Used by builtins to refuse translation when an
input could land outside the function's domain — `log(x)` requires `x` to be
statically `nonnegative` (numbl defines `log(0) = -Inf`, so the zero-input case
is well-formed and matches C's `log(0.0)`). The canonical pattern when a user
has only `unknown` info is `log(abs(x))`. `sqrt` has the same `nonnegative`
declared domain but opts into `BuiltinSig.promoteOnDomainMiss`: a domain miss
admits the call and promotes the result type to complex (the C call goes
through `csqrt`), mirroring numbl's `realFn → NaN → complexFn` runtime
fallback. The downstream result type is complex even when the runtime value
happens to be nonneg — `mtoc_format_complex` collapses `im == 0` to the real
format so disp/fprintf still match byte-for-byte, but subsequent
real-operand-only ops (`x > 0`, `floor(x)`, etc.) will refuse.

The sign lattice has its own helpers (`signNegate`, `signAdd`, `signSub`,
`signMul`, `signDiv`, `joinSign`, `signFromValue`). The rules are conservative
but not paranoid — `pos + pos = pos`, `pos * neg = neg`, `nonneg * unknown =
unknown`, etc.

A handful of _structural_ refinements live alongside the lattice:

- `x * x` (same variable) is detected as `nonneg` regardless of `x`'s sign.
- `for k = 1:n` ⇒ `k` is `positive` inside the body, `nonneg` after the loop
  (the latter accounts for the "loop never ran" path).
- `x .^ n` / `x ^ n` infer a refined sign from the base and a foldable
  exponent: positive base stays `positive`; constant positive even-integer
  exponent gives `nonneg` (or `positive` when the base is known nonzero);
  positive odd-integer exponent propagates the base sign; nonneg base with
  any non-negative constant exponent stays `nonneg`.

## Operations

- **`unify(a, b)`** — least upper bound. Used at control-flow merges and at
  `assignedVars` accumulation (which type does a single C variable need to
  hold across all assignments). Returns `Unknown` when `elem` differs, when
  one side is `Unknown`/`Void`, or when `String` is unified with a non-String
  type — that's the trigger for the "this variable can't share one C storage
  location" error.
- **`arithResult(op, a, b)`** — result of `+ - * /` (and elementwise
  variants). Handles scalar⊙scalar, scalar↔tensor broadcast, and tensor⊙tensor
  under MATLAB's implicit-expansion rule: per-axis, a `one` side expands to
  the other side's category (`broadcastShape` walks the padded dims arrays).
  No static rejections — two `notOne` axes of different sizes mismatch only
  at runtime, where the broadcast codegen's `mtoc_broadcast_dim` chain traps
  it. Reserved for the future: tensor⊙tensor with `*` / `/` (matrix
  multiply / divide) is an explicit unsupported case in lowering.
- **`mergeBranchEnvs(envs, span, construct)`** — joins multiple post-arm envs
  at an `if`/`while`/`for` exit. Variables present in only some arms unify
  against an "absent default" picked by `absentDefaultFor(present)` so the
  merge stays well-typed for non-numeric kinds: string → `STRING`, char
  array → empty `mtoc_char_tensor_t`, scalar char → `'\0'`, mixed /
  numeric → `scalarDouble("zero")`.

## Storage categories

Two helper functions in `types.ts` keep the "what shares a C variable?"
decisions in one place — both `recordAssignment` and `mergeBranchEnvs`
dispatch through them:

- **`storageCategory(t)`** → a stable identifier for the C slot a value
  of type `t` occupies: `"string"`, `"scalar-char"`, `"char-array"`,
  `"scalar-real"`, `"scalar-complex"`, `"tensor-real"`, or `"tensor-complex"`
  (or `null` for `Unknown` / `Void` / a numeric with `unknown` dims).
- **`canShareStorage(prev, next)`** = `storageCategory(prev) !== null &&
storageCategory(prev) === storageCategory(next)`. New owned kinds
  (cells, structs, classes) plug in by adding a category arm here;
  every per-category dispatch site picks it up automatically.

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
  inconsistent for static codegen" (e.g. `log(x)` with `x.sign === "negative"`).

A small post-lowering `validateIR` pass catches structural invariants (tensor
literals only as `Assign` RHS, etc.) so the codegen never has to surface
errors with line-number-less stack traces.
