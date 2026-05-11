/**
 * Typed intermediate representation (IR).
 *
 * Mirrors the subset of the AST that mtoc supports today. Every IRExpr
 * carries the inferred MType so codegen can dispatch on type without
 * rerunning inference.
 */

import type { Span, BinaryOperation, UnaryOperation } from "../parser/index.js";
import type { BuiltinSig } from "../workspace/builtins.js";
import type { MType } from "./types.js";

export type IRExpr =
  | { kind: "NumLit"; value: number; ty: MType; span: Span }
  | {
      /** Imaginary literal — the complex number `0 + value*i`. Produced
       *  by lowering when the AST exposes either a bare `ImagUnit` (i.e.
       *  the implicit `1i`) or a `Binary(Mul, NumLit, ImagUnit)` (i.e.
       *  `<NumLit>i` such as `2.5i`). The real-coefficient case folds
       *  here so codegen never has to recognize the binary form, and
       *  `arithResult(Add, real, complex)` cleanly produces the
       *  complex sum for `3 + 4i`. `ty` is always a complex scalar. */
      kind: "ImagLit";
      value: number;
      ty: MType;
      span: Span;
    }
  | {
      /** Double-quoted string literal `"..."`. `value` is the decoded
       *  string contents (quotes stripped, doubled-quote escapes
       *  collapsed). Codegen lowers this to
       *  `mtoc_string_from_literal("...", N)` — a non-owning handle
       *  pointing at the C string constant in `.rodata` (cheap; no
       *  allocation). The owned-flag mtoc_string_t convention means
       *  passing literals through builtins like `disp` doesn't need
       *  freeing. `ty` is always `STRING`. */
      kind: "StringLit";
      value: string;
      ty: MType;
      span: Span;
    }
  | {
      /** Single-quoted char literal `'...'`. `value` is the decoded
       *  content (quotes stripped, doubled-quote `''` collapsed).
       *  Codegen maps this to:
       *    - a C `char` literal (e.g. `'a'`) for 1×1 scalar chars, or
       *    - `mtoc_char_tensor_from_literal("abc", N)` for 1×N arrays,
       *      which is a non-owning handle pointing at the string
       *      constant in `.rodata`.
       *  `ty` is a `NumericType` with `elem: "char"`. Scalar chars have
       *  rows=one, cols=one; arrays have rows=one, cols=notOne. */
      kind: "CharLit";
      value: string;
      ty: MType;
      span: Span;
    }
  | {
      kind: "Var";
      /** MATLAB name (for diagnostics and assignedVars lookups). */
      name: string;
      /** C identifier the codegen emits for this variable. Computed
       *  once during lowering (see `cNameFor`) so emit.ts never has to
       *  re-mangle. */
      cName: string;
      ty: MType;
      span: Span;
    }
  | {
      /** Tensor literal `[a b c; d e f]`. Elements are stored in
       *  row-major nested arrays mirroring the source syntax; codegen
       *  re-orders to column-major when writing to memory. Every
       *  element must lower to a real scalar (no nested tensors yet). */
      kind: "TensorLit";
      elements: IRExpr[][];
      ty: MType;
      span: Span;
    }
  | {
      kind: "Binary";
      op: BinaryOperation;
      left: IRExpr;
      right: IRExpr;
      ty: MType;
      span: Span;
    }
  | {
      kind: "Unary";
      op: UnaryOperation;
      operand: IRExpr;
      ty: MType;
      span: Span;
    }
  | {
      /** Function call — covers builtins (libm scalar math and mtoc
       *  runtime helpers) and user-defined scalar functions. The `callee`
       *  variant tells codegen which header / runtime snippet to pull
       *  in (libm needs `<math.h>`, runtime helpers self-activate, user
       *  funcs need no extra activation). */
      kind: "Call";
      /** MATLAB name (for diagnostics). */
      name: string;
      callee: CallTarget;
      args: ReadonlyArray<IRExpr>;
      ty: MType;
      span: Span;
    }
  | {
      /** Scalar read of an indexed multi-element value: `v(i)`,
       *  `M(i, j)`, or any expression where the indexed value
       *  receives one or two scalar indices. The result type is
       *  always a scalar of the base's element kind / complexity.
       *  Range and colon indices (which produce a tensor slice)
       *  belong on a future `IndexSlice` variant — not in this MVP.
       *
       *  `base` is the IRExpr.Var read of the variable being indexed
       *  (modeling "read the tensor handle, then index into its
       *  buffer"). Storing it as a real Var node lets every existing
       *  walker (liveness, owned-arg-copy, validators) see the read
       *  without special-casing. `indices` is one or two scalar
       *  IRExprs (1-indexed in MATLAB; codegen emits `-1` conversions
       *  to reach C's 0-indexed buffers). The number of indices
       *  selects between linear (one) and 2D (two) addressing, with
       *  the same shape interpretation MATLAB uses. */
      kind: "IndexLoad";
      base: Extract<IRExpr, { kind: "Var" }>;
      indices: IRExpr[];
      ty: MType;
      span: Span;
    }
  | {
      /** Range / colon / scalar-mix read of a multi-element value,
       *  producing a fresh tensor: `v(a:b)`, `v(a:s:b)`, `v(:)`,
       *  `M(:, j)`, `T(:, i, :)`, …. `index` is a per-slot list whose
       *  length is either 1 (single-slot linear indexing) or equal to
       *  the base's `ndim` (full per-axis indexing). Mixed scalar +
       *  range + colon slots are supported in the full per-axis form.
       *
       *  Result-shape rules:
       *    - Single-slot (`index.length === 1`), matching numbl's
       *      linear-indexing semantics:
       *        - `Range` slot, base is row-vec  → row-vec (preserves)
       *        - `Range` slot, base is col-vec  → col-vec (preserves)
       *        - `Range` slot, base is matrix   → row-vec (the range
       *                                          is itself a row)
       *        - `Colon` slot                    → col-vec (always
       *                                          linearizes to column)
       *    - Multi-slot (`index.length === base.ndim`), per axis:
       *        - `Colon`  at axis k → result keeps `base.dims[k]`
       *        - `Range`  at axis k → result has `{notOne}` at k
       *        - `Scalar` at axis k → result has `{one}` at k
       *      Trailing singletons in the result are stripped by
       *      `numericTypeND`.
       *
       *  Like `TensorLit`, an `IndexSlice` is an owned-allocating
       *  producer — it can only appear at the top level of
       *  `Assign.rhs`. Nested uses are rejected by `validateIR`. */
      kind: "IndexSlice";
      base: Extract<IRExpr, { kind: "Var" }>;
      index: readonly IndexSliceArg[];
      ty: MType;
      span: Span;
    }
  | {
      /** Reference to the `end` keyword inside an index expression.
       *  Resolved at lowering time to the relevant axis size of the
       *  enclosing index's base. The result is a nonneg long-valued
       *  expression (rendered as `<base>.rows`, `<base>.cols`, or
       *  `(<base>.rows * <base>.cols)`); the IR type is
       *  `scalarDouble("nonnegative")` so it composes cleanly with
       *  the rest of the numeric arithmetic.
       *
       *  Out-of-context uses (`end` outside an index) are rejected at
       *  lowering with a span. The lowerer maintains a per-scope
       *  `endStack` and pops/pushes around each index slot. */
      kind: "EndRef";
      baseCName: string;
      baseTy: MType;
      /** Which axis of the base this `end` refers to:
       *    - number k : `end` in the k-th index slot of a multi-slot
       *                 index expression. Resolves to `<base>.dims[k]`
       *                 for double tensors and `<base>.rows`/.cols for
       *                 the 2-D char-tensor special case.
       *    - "linear" : 1D index over a multi-element tensor →
       *                 `numel(<base>)` = product of every dim. */
      axis: number | "linear";
      ty: MType;
      span: Span;
    };

/** Discriminator on a `Call`'s C-side target. Codegen consumes this
 *  directly — builtin calls hold a reference to the typed
 *  `BuiltinSig` (whose `emit` closure activates any runtime helper
 *  it needs and renders the C expression); user-function calls hold
 *  the mangled specialization name. */
export type CallTarget =
  | { kind: "builtin"; sig: BuiltinSig }
  | { kind: "userFunc"; mangled: string };

/** One slot of an `IndexSlice` / `IndexSliceStore` index. The variants:
 *    - `Range`  : `start:step:end`. `step` is always populated — the
 *                 lowerer fills in a literal `1` when the source was
 *                 `a:b` (no explicit step).
 *    - `Colon`  : bare `:`. No sub-expressions.
 *    - `Scalar` : a single 1-based MATLAB index. Used only in the
 *                 multi-slot form: e.g. slot 1 of `M(:, 3)` is
 *                 `Scalar(3)`. Single-slot scalar reads stay on the
 *                 `IndexLoad` IR node; this variant only ever appears
 *                 alongside at least one Range or Colon slot. */
export type IndexSliceArg =
  | {
      kind: "Range";
      start: IRExpr;
      step: IRExpr;
      end: IRExpr;
      span: Span;
    }
  | { kind: "Colon"; span: Span }
  | { kind: "Scalar"; expr: IRExpr; span: Span };

export type IRStmt =
  | {
      /** `<name> = <rhs>`. The RHS may be:
       *    - a scalar expression (codegen emits `<cName> = <expr>;`),
       *    - a `TensorLit` (codegen writes literal values into the
       *      slots of `<cName>.real[idx]` directly),
       *    - any other multi-element expression (codegen emits a
       *      per-element loop over `numel(rhs.ty)` slots, evaluating
       *      the body once per slot with multi-element `Var`s reading
       *      `<varCName>.real[<iter>]`).
       *  All three paths use the same `Assign` node — codegen
       *  dispatches on `rhs.kind` and `rhs.ty`'s shape. */
      kind: "Assign";
      /** numbl target name (for diagnostics and assignedVars lookup). */
      name: string;
      /** Pre-mangled C identifier of the target. */
      cName: string;
      rhs: IRExpr;
      ty: MType;
      span: Span;
    }
  | {
      /** In-place range / colon / scalar-mix write into a multi-element
       *  tensor: `v(a:b) = w`, `v(:) = w`, `v(:) = scalar`,
       *  `M(:, j) = w`, `T(:, i, :) = w`, … . The base's heap buffer
       *  is mutated in place (slots covered by the slice are
       *  overwritten); the buffer is reused, so this is NOT an owned
       *  re-assignment. `index` follows the same per-slot list shape
       *  as `IndexSlice.index` — length 1 for the linear single-slot
       *  form, length `ndim` for full per-axis writes.
       *
       *  RHS shapes:
       *    - tensor RHS: a count match is enforced at runtime
       *      (numel(rhs) must equal the slice's element count).
       *    - scalar RHS: broadcast — same scalar written to every
       *      slot in the slice.
       *
       *  Type rules mirror IndexStore: real RHS into a complex base
       *  zeros the imag side per slot; complex RHS into a real base
       *  is rejected at lowering. */
      kind: "IndexSliceStore";
      base: Extract<IRExpr, { kind: "Var" }>;
      index: readonly IndexSliceArg[];
      rhs: IRExpr;
      span: Span;
    }
  | {
      /** In-place scalar write at an index of a multi-element tensor:
       *  `v(i) = x`, `M(i, j) = x`. The base's heap allocation is
       *  reused — only one slot is mutated — so this is NOT an
       *  owned re-assignment; the freed-set bookkeeping is left
       *  alone. The RHS must be a scalar; type rules:
       *    - real RHS into real base   → write `.real[off] = rhs;`
       *    - real RHS into complex base → write `.real[off] = rhs;
       *                                    .imag[off] = 0;` (numbl
       *                                    semantics: real promotes).
       *    - complex RHS into complex base → write both halves via a
       *                                       `double _Complex` temp
       *                                       so creal/cimag don't
       *                                       double-evaluate the RHS.
       *    - complex RHS into real base   → rejected at lowering. */
      kind: "IndexStore";
      base: Extract<IRExpr, { kind: "Var" }>;
      indices: IRExpr[];
      rhs: IRExpr;
      span: Span;
    }
  | { kind: "ExprStmt"; expr: IRExpr; span: Span }
  | { kind: "Disp"; arg: IRExpr; span: Span }
  | {
      /** `error(s)` — raises a runtime error with the given text
       *  message. Statement-only (numbl's `error` never returns).
       *  Codegen emits `mtoc_error_text(<view>);` (the arg is
       *  wrapped in a text view at the call site, so the same path
       *  serves both string and char-array messages). Lowering
       *  accepts a `StringLit` / `CharLit` / `Var` as the argument;
       *  nested text expressions must be assigned to a name first. */
      kind: "Error";
      arg: IRExpr;
      span: Span;
    }
  | {
      /** `assert(cond)` / `assert(cond, msg)` — aborts on stderr when
       *  `cond` is a falsy or NaN scalar; otherwise a no-op. Statement-
       *  only (numbl's `assert` returns nothing on success and throws
       *  on failure). Codegen emits `mtoc_assert_double` (1-arg form,
       *  prints "Assertion failed") or `mtoc_assert_double_msg_text`
       *  (2-arg form, prints the user-supplied message; the msg is
       *  wrapped in a text view at the call site, so both string and
       *  char-array messages funnel through the same helper). Lowering
       *  today accepts a scalar real `cond`; the multi-element tensor
       *  form is deferred. The optional `msg` must be a `Var`,
       *  `StringLit`, or `CharLit` (mirroring the `error` rule —
       *  nested text expressions have no name to be released through). */
      kind: "Assert";
      cond: IRExpr;
      msg: IRExpr | null;
      span: Span;
    }
  | {
      /** `fprintf(fmt, args...)` / `fprintf(fid, fmt, args...)` —
       *  formatted output to stdout. Statement-only in v1 (the
       *  value-returning form `n = fprintf(...)` is deferred — the
       *  byte count is rarely consumed in practice and adds an
       *  expression-position path with no test corpus). Lowering
       *  restricts `fid` to a literal `1` or `2` and routes both to
       *  stdout, matching numbl's runtime (numbl's `output` stream
       *  receives both fid=1 and fid=2 — see specialBuiltins.ts).
       *
       *  Codegen emits one call:
       *      mtoc_fprintf(stdout, <fmt-view>, N, (mtoc_fprintf_arg_t[]){…})
       *  The args array is a C99 compound literal whose entries
       *  discriminate on the IR arg type (double, complex, text,
       *  tensor). The runtime helper mirrors numbl's `sprintfFormat`
       *  byte-for-byte (specs, escape handling, arg cycling, tensor
       *  flattening). See `runtime/format_engine.h`. */
      kind: "Fprintf";
      fmt: IRExpr;
      args: IRExpr[];
      span: Span;
    }
  | {
      kind: "If";
      cond: IRExpr;
      thenBody: IRStmt[];
      elseifs: Array<{ cond: IRExpr; body: IRStmt[] }>;
      elseBody: IRStmt[] | null;
      span: Span;
    }
  | {
      kind: "For";
      /** MATLAB loop-variable name (for diagnostics). */
      var: string;
      /** C identifier for the loop variable's storage. */
      cVar: string;
      start: IRExpr;
      step: IRExpr;
      end: IRExpr;
      body: IRStmt[];
      span: Span;
    }
  | {
      kind: "While";
      cond: IRExpr;
      body: IRStmt[];
      span: Span;
    }
  | { kind: "Break"; span: Span }
  | { kind: "Continue"; span: Span }
  /** numbl `return` inside a function — emitted by lowering only when
   *  inside a function scope. For a 1-output function, codegen turns this
   *  into `return <outputCNames[0]>;`; for a 0-output function, into
   *  `return;`; for an N-output function (N≥2), into a sequence of
   *  `*_mtoc_o<i> = <outputCNames[i]>;` writes followed by `return;`. */
  | { kind: "ReturnFromFunction"; outputCNames: string[]; span: Span }
  /** Multi-output / 0-output user-function call statement. Drives:
   *    - `[a, b] = foo(x);`            (N≥2 outputs, mix of named lvalues
   *                                     and ignored `~` slots)
   *    - `foo(x);`                     (0-output bare statement)
   *    - `foo(x);`                     (N-output statement form — every
   *                                     output is dropped via a discard
   *                                     temp, mirroring numbl's "drop-all"
   *                                     semantics)
   *  Each entry of `outputs` is either a real lvalue (the slot's typed
   *  binding plus the C identifier the assigned value lands in — driven
   *  through `recordAssignment` like any other Assign) or `null` for an
   *  ignored slot. The codegen wraps the call in a `{ … }` block and
   *  declares one inline `_mtoc_discard_<callIdx>_<slot>` per `null`
   *  slot so those temporaries stay scoped to the call. */
  | {
      kind: "MultiAssignCall";
      /** numbl name (for diagnostics). */
      name: string;
      /** Mangled C identifier of the user-function specialization. */
      mangled: string;
      args: IRExpr[];
      /** One entry per output slot of the callee. `ty` is the slot's
       *  static type (always populated, so codegen can declare a
       *  typed discard temp for ignored slots). `binding` is the
       *  destination — `null` means "ignored output" (`~` lvalue or
       *  unconsumed trailing slot in `[a] = f_with_two_outputs(x);`),
       *  in which case codegen emits a `_mtoc_discard_<call>_<slot>`
       *  local of type `ty` and passes its address. A non-null
       *  binding means "store the call's i-th output into
       *  <binding.cName>; the lowerer has already registered the
       *  assignment via recordAssignment, so the codegen-side
       *  predeclaration pipeline picks it up like any other Assign
       *  target". */
      outputs: {
        ty: MType;
        binding: { name: string; cName: string } | null;
      }[];
      span: Span;
    };

/** A predeclared variable: its inferred type plus the C identifier the
 *  codegen will emit. Computed once during lowering so emit.ts never
 *  has to re-mangle. */
export interface VarBinding {
  ty: MType;
  cName: string;
}

/** A single specialization of a user-defined function, ready for codegen. */
export interface IRFunction {
  /** Mangled C identifier (e.g. "sq__d"). */
  mangledName: string;
  /** numbl-source name (for diagnostics). */
  matlabName: string;
  params: { name: string; cName: string; ty: MType }[];
  /** Output variables of the function specialization, in declaration
   *  order. Empty when the function has zero outputs (statement-only
   *  invocation); length 1 for the classic single-output convention
   *  (return-by-value); length ≥ 2 for the multi-output convention
   *  (extra `T_i *_mtoc_o<i>` C parameters appended after the user
   *  params, body assigns to each output's local, and at every return
   *  path the codegen writes `*_mtoc_o<i> = <cName>;`).
   *  `name` is the numbl identifier (for diagnostics); `cName` is the
   *  identifier of the local that holds the value just before the
   *  return. After body lowering, the binding may have been split via
   *  `recordAssignment` so `cName` reflects the LIVE binding at the
   *  function's exit point, not the original declaration. */
  outputs: { name: string; cName: string; ty: MType }[];
  /** Locals declared inside the body (excluding params). Keyed by
   *  C identifier — one entry per emitted C variable. A single MATLAB
   *  name may produce multiple entries when the lowerer splits an
   *  incompatible reassignment (see `Lowerer.recordAssignment`). */
  assignedVars: Map<string, VarBinding>;
  body: IRStmt[];
  span: Span;
  /** 1-based line range of the original `function … end` block. Codegen
   *  uses this in the header comment so generated C points back to the
   *  source. */
  sourceLocation: { file: string; startLine: number; endLine: number };
}

export interface IRProgram {
  /** Variables assigned anywhere in the program (with their inferred
   *  type and C identifier). Codegen uses this to predeclare them at
   *  the top of main(). Keyed by C identifier — see the same field on
   *  `IRFunction` for why a single MATLAB name can map to several
   *  entries. */
  assignedVars: Map<string, VarBinding>;
  /** User-function specializations, in lowering order. Emitted before
   *  `main()` in the C output. */
  functions: IRFunction[];
  stmts: IRStmt[];
}
