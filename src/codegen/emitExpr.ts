/**
 * Expression-level codegen.
 *
 * `emitExpr` renders an `IRExpr` into a C expression string;
 * `analyzeExpr` is the pre-walk that flips header flags
 * (`needMath` / `needComplex`) for any node that forces them. Both
 * traversals dispatch on `IRExpr.kind` and stay in lock-step so the
 * activation order (`useRuntime` calls inside builtin emit closures)
 * matches what the emitted C consumes.
 *
 * `wrapOwnedArgCopy` is the small helper that puts an owned-typed
 * user-function arg through its kind's `copy` helper at the call
 * site (copy-on-arg-pass).
 */

import type { IRExpr } from "../lowering/ir.js";
import {
  cTypeFor,
  isCharArray,
  isClass,
  isMultiElement,
  isNumeric,
  isScalar,
  isString,
  isStruct,
  structMangledName,
  tupleCellSlotFieldName,
  typeToString,
  type MType,
  type NumericType,
  type StructType,
} from "../lowering/types.js";
import { forEachSubExpr } from "../lowering/walk.js";
import { isDirectOwnedCall } from "../lowering/anf.js";
import {
  BIN_OP_C,
  CMP_OR_LOGICAL,
  formatCharLit,
  formatNumLit,
  formatStringLit,
  precedence,
  stringLitByteLen,
  UN_OP_C,
} from "./emitFormat.js";
import { ownedOps } from "./ownedKinds.js";
import {
  builtinEmitFacade,
  pushStmt,
  useRuntimeByName,
  useSnippet,
  type EmitState,
} from "./emitState.js";

/** C-side struct field name for the row count of a tensor handle of
 *  type `ty`. Double tensors store shape in `dims[…]`; char tensors
 *  are 2-D-only and keep their legacy `.rows`/`.cols` fields. */
export function tensorRowsField(ty: MType): string {
  return isNumeric(ty) && ty.elem === "char" ? "rows" : "dims[0]";
}

/** Resolve the linear-index expression to use when rendering a
 *  multi-element `Var` (or other per-operand source) inside a
 *  per-element loop. In the flat-shape frame every operand shares the
 *  same iter name; in the broadcast frame each operand's cName maps
 *  to its own precomputed linear index. Callers that miss the map
 *  hit an internal-error throw because the broadcast emitter should
 *  have registered every multi-element operand. */
function iterIndexFor(state: EmitState, varCName: string): string {
  if (state.iterStack.length === 0) {
    throw new Error("codegen internal: iterIndexFor called outside iter loop");
  }
  const frame = state.iterStack[state.iterStack.length - 1];
  if (frame.kind === "flat") return frame.iter;
  const idx = frame.perVarIndex.get(varCName);
  if (idx === undefined) {
    throw new Error(
      `codegen internal: no broadcast iter index registered for '${varCName}'`
    );
  }
  return idx;
}

/** C-side struct field name for the column count of a tensor handle. */
export function tensorColsField(ty: MType): string {
  return isNumeric(ty) && ty.elem === "char" ? "cols" : "dims[1]";
}

/** Compute the linear column-major buffer offset for a scalar
 *  IndexStore / IndexLoad with `indices.length` scalar indices into a
 *  base of the given type. Three branches:
 *    - 1-arg linear: `(long)idx - 1L`.
 *    - 2-arg row-major fast path: `(i - 1) + (j - 1) * rows` (char
 *      tensors read `.rows`, double tensors `.dims[0]` via
 *      `tensorRowsField`).
 *    - N-D general (double tensors only — char is 2-D-only):
 *      `sum_k (idx_k - 1) * prod(dims[0..k-1])`.
 *  Centralized so IndexLoad, IndexStore, and any future scalar-index
 *  consumer share one formula. */
export function emitNdScalarOffset(
  state: EmitState,
  indices: ReadonlyArray<IRExpr>,
  baseCName: string,
  baseTy: NumericType
): string {
  if (indices.length === 1) {
    return `(long)(${emitExpr(state, indices[0], 0)}) - 1L`;
  }
  if (indices.length === 2) {
    const rowsField = tensorRowsField(baseTy);
    return (
      `(long)(${emitExpr(state, indices[0], 0)}) - 1L + ` +
      `((long)(${emitExpr(state, indices[1], 0)}) - 1L) * ` +
      `${baseCName}.${rowsField}`
    );
  }
  const terms: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const idxStr = `((long)(${emitExpr(state, indices[i], 0)}) - 1L)`;
    if (i === 0) {
      terms.push(idxStr);
    } else {
      const strideParts: string[] = [];
      for (let j = 0; j < i; j++) strideParts.push(`${baseCName}.dims[${j}]`);
      terms.push(`${idxStr} * ${strideParts.join(" * ")}`);
    }
  }
  return terms.join(" + ");
}

/** Wrap an already-emitted text expression in the appropriate
 *  `mtoc_text_from_*` adapter so it can be passed to any helper that
 *  takes `mtoc_text_view_t` (`mtoc_disp_text`, `mtoc_error_text`,
 *  `mtoc_strcmp_text`, `mtoc_assert_double_msg_text`,
 *  `mtoc_string_concat`). Activates `mtoc_text_view_t` plus the
 *  source-specific adapter as a side effect. Throws on non-text
 *  types — callers must gate on `isText` first. */
export function wrapTextView(
  state: EmitState,
  ty: MType,
  inner: string
): string {
  useRuntimeByName(state, "mtoc_text_view_t");
  if (isString(ty)) {
    return `mtoc_text_from_string(${inner})`;
  }
  if (isCharArray(ty)) {
    return `mtoc_text_from_char_tensor(${inner})`;
  }
  throw new Error(
    `codegen internal: wrapTextView called on non-text type ${typeToString(ty)}`
  );
}

/** Copy-on-arg-pass: wrap an owned-typed argument in its kind's `copy`
 *  helper so the callee gets a freshly-owned value to manage. Tensors
 *  (real / complex), char arrays, and structs follow this protocol;
 *  strings don't — they're not yet accepted as user-function args.
 *  Returns `inner` unchanged for non-owned arg types. Activates the
 *  chosen copy helper as a side effect. */
export function wrapOwnedArgCopy(
  state: EmitState,
  argTy: MType,
  inner: string
): string {
  const owned = ownedOps(argTy);
  if (owned === null) return inner;
  // Multi-element tensors, structs, and function handles use the
  // copy-on-arg-pass convention: the callee receives an independently-
  // owned value that it may freely mutate / reassign / free at scope
  // exit. Strings and char-tensors as args are borrowed (no automatic
  // wrap) — they were never in this convention.
  if (
    !isMultiElement(argTy) &&
    !isStruct(argTy) &&
    !isClass(argTy) &&
    argTy.kind !== "Handle"
  ) {
    return inner;
  }
  const helper = owned.copy(argTy);
  useSnippet(state, helper);
  return `${helper.name}(${inner})`;
}

export function emitExpr(
  state: EmitState,
  e: IRExpr,
  parentPrec: number
): string {
  // Tensor-typed sub-expressions in scalar codegen contexts are caught
  // by the lowering-pass validator (lower.ts: `validateIR`). If one
  // reaches here, the lowerer let it through — that's an internal bug.
  // Inside an iter context, multi-element Binary/Unary nodes are
  // expected (each iteration consumes one element), so we only enforce
  // the check at the top level.
  // `CharLit` is excluded: a non-owning literal handle (char scalar or
  // char array) is safe in any expression position — no allocation.
  // Direct-Call producers — user-function `Call`s OR non-elementwise
  // builtin `Call`s — that return a multi-element tensor are also
  // excluded: they return a fully-formed `mtoc_tensor_t` struct by
  // value, which the surrounding owned-LHS assign path consumes via
  // `mtoc_<kind>_assign(&lhs, foo(args))` without going through the
  // iter-loop materialization machinery.
  if (
    state.iterStack.length === 0 &&
    e.kind !== "Var" &&
    e.kind !== "TensorLit" &&
    e.kind !== "CharLit" &&
    e.kind !== "MemberLoad" &&
    e.kind !== "HandleCaptureLoad" &&
    e.kind !== "CellIndexLoad" &&
    !isDirectOwnedCall(e) &&
    isMultiElement(e.ty)
  ) {
    throw new Error(
      `codegen internal: tensor-valued expression (${typeToString(e.ty)}) ` +
        `reached emitExpr; should have been rejected at lowering`
    );
  }

  switch (e.kind) {
    case "NumLit":
      return formatNumLit(e.value);

    case "HandleLit": {
      // Render as a C compound literal of the handle's per-shape
      // struct: `(_mtoc_handle__<hex>){.cap_<name> = <value>, ...}`,
      // or `(_mtoc_handle_empty_t){0}` for the no-capture form.
      // Captured values feed in directly; owned captures (tensors,
      // strings, nested structs / handles) are deep-copied by an
      // ownership-aware wrapper so the snapshot is independent of
      // later mutations to the source binding.
      if (e.ty.kind !== "Handle") {
        throw new Error("codegen internal: HandleLit with non-Handle ty");
      }
      const cTy = cTypeFor(e.ty);
      if (cTy === null) {
        throw new Error("codegen internal: HandleLit ty has no C type");
      }
      const handleOwned = ownedOps(e.ty);
      if (handleOwned !== null) useSnippet(state, handleOwned.structSnippet);
      if (e.captures.length === 0) {
        return `(${cTy}){0}`;
      }
      const parts: string[] = [];
      for (const c of e.captures) {
        const inner = emitExpr(state, c.value, 0);
        parts.push(
          `.cap_${c.name} = ${wrapOwnedArgCopy(state, c.value.ty, inner)}`
        );
      }
      return `(${cTy}){${parts.join(", ")}}`;
    }

    case "HandleCaptureLoad":
      return `${e.base.cName}.cap_${e.captureName}`;

    case "StringLit": {
      // Build a non-owning `mtoc_string_t` whose `data` field points
      // straight at a C string literal in `.rodata`. Cheap — no
      // allocation. Activates the typedef + the helper.
      useRuntimeByName(state, "mtoc_string_t");
      useRuntimeByName(state, "mtoc_string_from_literal");
      const lit = formatStringLit(e.value);
      const len = stringLitByteLen(e.value);
      return `mtoc_string_from_literal(${lit}, ${len})`;
    }

    case "ImagLit": {
      // Render as `<value> * I`. C99's `_Complex_I` macro expands to
      // a `const float _Complex` (or `const double _Complex`) value
      // representing 0+1i; multiplying a `double` by it produces a
      // `double _Complex`. Wrap in parens so adjacent operators (e.g.
      // a unary `-`, or an Add) bind correctly. The `<complex.h>`
      // header was already activated by analyzeExpr.
      return `(${formatNumLit(e.value)} * I)`;
    }

    case "Var":
      // Inside a per-element loop, a multi-element `Var` reads the
      // current slot; scalar `Var`s broadcast unchanged. Real
      // multi-element Vars render as `<v>.real[<iter>]`; complex
      // multi-element Vars compose `<v>.real[<iter>] + <v>.imag[<iter>] * I`
      // so the resulting C value is a `double _Complex` that mixes
      // cleanly with both real and complex sub-exprs in the body.
      // Char-array Vars in iter context widen to double (char arithmetic
      // always produces double; the iter loop stores into a double
      // tensor staging buffer).
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = iterIndexFor(state, e.cName);
        if (isNumeric(e.ty) && e.ty.elem === "char") {
          return `(double)(${e.cName}.data[${iter}])`;
        }
        if (isNumeric(e.ty) && e.ty.isComplex) {
          return `(${e.cName}.real[${iter}] + ${e.cName}.imag[${iter}] * I)`;
        }
        return `${e.cName}.real[${iter}]`;
      }
      return e.cName;

    case "CharLit": {
      // Multi-element char in iter context: each iteration reads one
      // byte and widens to double for arithmetic. CharLits only appear
      // in the flat-iter (same-shape) emission path — the broadcast
      // dispatcher rejects multi-element CharLit operands ahead of time.
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const frame = state.iterStack[state.iterStack.length - 1];
        if (frame.kind !== "flat") {
          throw new Error(
            "codegen internal: multi-element CharLit in broadcast iter " +
              "context; broadcast dispatcher should have routed elsewhere"
          );
        }
        return `(double)(${formatStringLit(e.value)}[${frame.iter}])`;
      }
      // Scalar char literal: render as a C char literal.
      if (isScalar(e.ty)) {
        return formatCharLit(e.value);
      }
      // Multi-element char in non-iter context: build a non-owning
      // `mtoc_char_tensor_t` pointing at the string literal in .rodata.
      useRuntimeByName(state, "mtoc_char_tensor_t");
      useRuntimeByName(state, "mtoc_char_tensor_from_literal");
      const lit = formatStringLit(e.value);
      return `mtoc_char_tensor_from_literal(${lit}, ${e.value.length})`;
    }

    case "TensorLit":
      // Tensor literals are only legal at the top level of Assign.rhs
      // (handled directly by `emitTensorLitAssign`); every other
      // position is rejected by the lowering-pass validator. Reaching
      // here means the lowerer let one through.
      throw new Error(
        "codegen internal: TensorLit reached emitExpr; should have been " +
          "rejected at lowering"
      );

    case "IndexSlice":
      // Range/colon indexing produces a fresh tensor — same legal
      // position as TensorLit (top of Assign.rhs). The dedicated
      // emitter `emitIndexSliceAssign` handles it; arriving here is
      // a lowerer escape.
      throw new Error(
        "codegen internal: IndexSlice reached emitExpr; should have been " +
          "rejected at lowering"
      );

    case "MakeRange":
      // Bare `a:b` / `a:s:b` produces a fresh 1×n tensor — same legal
      // position as TensorLit / IndexSlice (top of Assign.rhs). The
      // dedicated emitter `emitMakeRangeAssign` handles it; arriving
      // here is a lowerer escape.
      throw new Error(
        "codegen internal: MakeRange reached emitExpr; should have been " +
          "rejected at lowering"
      );

    case "Call": {
      // User-function calls render as `mangled(args)`. Builtins delegate
      // to the registry's `emit` closure, which renders the C call and
      // activates any runtime helper it depends on (libm builtins return
      // a plain `cName(args)`; runtime-helper builtins also call
      // `state.useRuntime(name)`). The closure can also flip
      // `needMath` for builtins that conditionally pull in <math.h>.
      // The closure receives the arg MTypes so it can dispatch on
      // `isComplex` (e.g. `sqrt(x)` vs `sqrt(z)` → `csqrt(z)`).
      //
      // Copy-on-arg-pass: for user-function calls, every owned-typed
      // argument (tensor, string, char-array, struct, handle-with-
      // captures) is wrapped in the kind's `_copy` helper so the
      // callee gets an independently-owned value. Builtins are known
      // read-only and skip the wrap. `wrapOwnedArgCopy` returns the
      // input unchanged for non-owned types.
      const isUserCall = e.callee.kind === "userFunc";
      const argStrs = e.args.map(a => {
        const inner = emitExpr(state, a, 0);
        return isUserCall ? wrapOwnedArgCopy(state, a.ty, inner) : inner;
      });
      if (e.callee.kind === "userFunc") {
        return `${e.callee.mangled}(${argStrs.join(", ")})`;
      }
      const argTys = e.args.map(a => a.ty);
      return e.callee.sig.emit(argStrs, argTys, builtinEmitFacade(state));
    }

    case "Binary": {
      // String concatenation has its own helper; route there before
      // the numeric-binary branches.
      if (isString(e.ty)) {
        if (e.op !== "Add") {
          throw new Error(
            `codegen internal: string Binary with non-Add op ${e.op}; ` +
              `should have been rejected at lowering`
          );
        }
        useRuntimeByName(state, "mtoc_string_t");
        useRuntimeByName(state, "mtoc_string_concat");
        const left = wrapTextView(state, e.left.ty, emitExpr(state, e.left, 0));
        const right = wrapTextView(
          state,
          e.right.ty,
          emitExpr(state, e.right, 0)
        );
        return `mtoc_string_concat(${left}, ${right})`;
      }
      // Comparison / logical ops with any complex operand take a
      // dedicated branch — C's bare `<`/`==`/`&&` operators don't
      // match numbl's complex semantics (real-part-only for ordering;
      // both parts for equality; toBool for `&& ||`).
      const lc = isNumeric(e.left.ty) && e.left.ty.isComplex;
      const rc = isNumeric(e.right.ty) && e.right.ty.isComplex;
      if ((lc || rc) && CMP_OR_LOGICAL.has(e.op)) {
        return emitComplexCmpOrLogical(state, e, parentPrec);
      }
      // Complex division: C99's bare `/` on `double _Complex` produces
      // NaN+NaN*I on divide-by-zero, but numbl's interpreter carves
      // out signed-Inf parts via `complexDivide` (see cdiv.h). Route
      // every complex-involving Div / ElemDiv through the helper so
      // the divide-by-zero shape matches numbl byte-for-byte.
      if ((lc || rc) && (e.op === "Div" || e.op === "ElemDiv")) {
        useRuntimeByName(state, "mtoc_cdiv");
        const left = emitExpr(state, e.left, 0);
        const right = emitExpr(state, e.right, 0);
        return `mtoc_cdiv(${left}, ${right})`;
      }
      const cOp = BIN_OP_C[e.op];
      if (cOp) {
        const p = precedence(e.op);
        // Left-associative: left at p, right at p+1 to force parens on
        // equal-precedence right-nested operators.
        const inner = `${emitExpr(state, e.left, p)} ${cOp} ${emitExpr(state, e.right, p + 1)}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      if (e.op === "Pow" || e.op === "ElemPow") {
        // Complex-result Pow (negative base, non-integer exponent —
        // see lowerPow). C99 implicitly promotes the real operand
        // strings to `double _Complex` at the cpow call boundary.
        if (isNumeric(e.ty) && e.ty.isComplex) {
          return `cpow(${emitExpr(state, e.left, 0)}, ${emitExpr(state, e.right, 0)})`;
        }
        return `pow(${emitExpr(state, e.left, 0)}, ${emitExpr(state, e.right, 0)})`;
      }
      throw new Error(
        `codegen internal: unsupported binary op ${e.op}; ` +
          `should have been caught at lowering`
      );
    }

    case "EndRef": {
      // Resolve `end` to the relevant axis size of the base. The
      // result is a `long`-valued C expression that auto-promotes to
      // `double` in arithmetic; the indexing site re-casts to long
      // before forming the bracket index.
      //
      // Char tensors are 2-D only and keep their legacy `.rows`/`.cols`
      // fields; double tensors carry shape in `dims[0..ndim-1]`.
      const isChar = isNumeric(e.baseTy) && e.baseTy.elem === "char";
      if (e.axis === "linear") {
        if (isChar) {
          return `(${e.baseCName}.rows * ${e.baseCName}.cols)`;
        }
        const ndim = isNumeric(e.baseTy) ? e.baseTy.dims.length : 2;
        const parts: string[] = [];
        for (let i = 0; i < ndim; i++) {
          parts.push(`${e.baseCName}.dims[${i}]`);
        }
        return `(${parts.join(" * ")})`;
      }
      if (isChar) {
        return e.axis === 0 ? `${e.baseCName}.rows` : `${e.baseCName}.cols`;
      }
      return `${e.baseCName}.dims[${e.axis}]`;
    }

    case "IndexLoad": {
      // Compute the linear C buffer offset from the (1-indexed) MATLAB
      // indices via the shared `emitNdScalarOffset` helper — same path
      // IndexStore uses, keeping the column-major formula in one place.
      //
      // The base is always rendered as the bare cName here — the per-
      // element iter rendering for multi-element Vars (`v.real[<iter>]`)
      // is wrong for indexing; we want the struct itself so we can
      // pick the right slot.
      const baseCName = e.base.cName;
      const baseTy = e.base.ty;
      if (!isNumeric(baseTy)) {
        throw new Error(
          `codegen internal: IndexLoad base has non-numeric type ` +
            `${typeToString(baseTy)}`
        );
      }
      const offset = emitNdScalarOffset(state, e.indices, baseCName, baseTy);
      // Char tensor: read `.data[offset]` — yields a scalar `char`.
      if (baseTy.elem === "char") {
        return `${baseCName}.data[${offset}]`;
      }
      // Double tensor: complex composes `.real + .imag*I` into one
      // `double _Complex` value so the result can flow into either
      // real- or complex-typed contexts uniformly.
      if (baseTy.isComplex) {
        return (
          `(${baseCName}.real[${offset}] + ` +
          `${baseCName}.imag[${offset}] * I)`
        );
      }
      return `${baseCName}.real[${offset}]`;
    }

    case "MemberLoad": {
      // `<base>.<field>`. The base is rendered as a plain C expression
      // (a Var, a nested MemberLoad, etc.). If we're inside an iter
      // loop the base may be a multi-element Var that renders to
      // `<cName>.real[<iter>]` — but MemberLoad only applies to struct
      // values, which are never multi-element. So emit the base in
      // expression context (no iter substitution).
      const baseStr = emitExpr(state, e.base, parentPrec);
      return `${baseStr}.${e.field}`;
    }

    case "StructLit": {
      // C99 designated-initializer compound literal. For each field
      // present in the struct's TY (which may include fields the
      // user didn't initialize), we look up the matching value
      // entry; missing fields default to `{0}` (and any owned-typed
      // missing field stays zero-initialized — `mtoc_string_t {0}`
      // is a valid empty handle, ditto tensors / nested structs).
      if (!isStruct(e.ty)) {
        throw new Error(
          `codegen internal: StructLit with non-struct type ${typeToString(e.ty)}`
        );
      }
      const sty: StructType = e.ty;
      const name = structMangledName(sty);
      const valueByName = new Map<string, IRExpr>();
      for (const f of e.fields) valueByName.set(f.name, f.value);
      const inits: string[] = [];
      for (const field of sty.fields) {
        const val = valueByName.get(field.name);
        if (val === undefined) {
          // Field present in shape but not specified in this literal.
          // C99 zero-init via designated initializer requires us to
          // omit the field — `{ .x = 1 }` zeros every unmentioned slot.
          continue;
        }
        // Field-valued owned RHS gets a deep copy if it's a Var, so
        // the struct gets its own copy of the buffer (matching the
        // semantics user code expects from struct-by-value moves).
        const owned = ownedOps(field.type);
        let valStr = emitExpr(state, val, 0);
        if (owned !== null && val.kind === "Var") {
          const copyHelper = owned.copy(val.ty);
          useSnippet(state, copyHelper);
          valStr = `${copyHelper.name}(${val.cName})`;
        }
        inits.push(`.${field.name} = ${valStr}`);
      }
      if (inits.length === 0) {
        // Empty struct literal: `(typedef){0}`. C99 says `{0}` zeros
        // every slot — same as `_empty()`.
        return `(${name}){0}`;
      }
      return `(${name}){${inits.join(", ")}}`;
    }

    case "CellLit":
      // Cell literals are owned-allocating producers — the same legal
      // position as TensorLit / IndexSlice / MakeRange / StructLit
      // (top of Assign.rhs). The dedicated emitter handles it; arriving
      // here means the lowerer let one through.
      throw new Error(
        "codegen internal: CellLit reached emitExpr; should have been " +
          "rejected at lowering"
      );

    case "CellIndexLoad": {
      // Tuple cell: `c{k}` (k is a literal int) → `<base>.slot_<k-1>`.
      // Homogeneous cell: `c{idx}` → `<base>.data[<idx-expr>-1]` (1-based).
      const baseTy = e.base.ty;
      const baseStr = emitExpr(state, e.base, 0);
      if (baseTy.kind === "TupleCell") {
        if (e.index.kind !== "NumLit") {
          throw new Error(
            "codegen internal: TupleCell CellIndexLoad with non-NumLit index; " +
              "should have been rejected at lowering"
          );
        }
        return `${baseStr}.${tupleCellSlotFieldName(e.index.value - 1)}`;
      }
      if (baseTy.kind === "HomogeneousCell") {
        const idx = emitExpr(state, e.index, 0);
        return `${baseStr}.data[(long)(${idx}) - 1]`;
      }
      throw new Error(
        `codegen internal: CellIndexLoad on non-cell type ${typeToString(baseTy)}`
      );
    }

    case "Unary": {
      // Complex `~z` (Not) is the toBool negation: 1 iff re==0 && im==0.
      if (e.op === "Not" && isNumeric(e.operand.ty) && e.operand.ty.isComplex) {
        let s = emitExpr(state, e.operand, 0);
        // The operand is used twice (creal + cimag). Hoist non-Var complex
        // expressions to a temp to avoid double-evaluating Call nodes.
        if (e.operand.kind !== "Var") {
          const tmp = `_mtoc_cx_tmp_${state.complexTmpCounter++}`;
          pushStmt(state, state.currentLevel, `double _Complex ${tmp} = ${s};`);
          s = tmp;
        }
        return `(!(creal(${s}) != 0.0 || cimag(${s}) != 0.0))`;
      }
      const cOp = UN_OP_C[e.op];
      if (!cOp) {
        throw new Error(
          `codegen internal: unsupported unary op ${e.op}; ` +
            `should have been caught at lowering`
        );
      }
      const p = precedence(e.op);
      // Parenthesize a nested unary operand to avoid C's `--`/`++` token
      // (e.g. `-(-x)` not `--x`, which would be a decrement).
      const operandStr =
        e.operand.kind === "Unary"
          ? `(${emitExpr(state, e.operand, 0)})`
          : emitExpr(state, e.operand, p);
      const inner = `${cOp}${operandStr}`;
      return p < parentPrec ? `(${inner})` : inner;
    }
  }
}

/** Emit a comparison or logical op when at least one operand is
 *  complex. Mirrors numbl's semantics:
 *    <  <=  >  >=     real-part only
 *    ==  !=           both real and imag parts
 *    &&  ||           toBool: re != 0 || im != 0
 *  Real operands are unwrapped (no creal/cimag) since C's implicit
 *  promotion rules don't help us here — we want plain `double`s on
 *  the C side wherever the IR side is real. */
function emitComplexCmpOrLogical(
  state: EmitState,
  e: Extract<IRExpr, { kind: "Binary" }>,
  parentPrec: number
): string {
  const lc = isNumeric(e.left.ty) && e.left.ty.isComplex;
  const rc = isNumeric(e.right.ty) && e.right.ty.isComplex;
  let left = emitExpr(state, e.left, 0);
  let right = emitExpr(state, e.right, 0);

  // For ops that use each complex operand twice (Equal / NotEqual expand
  // into re+im comparisons; AndAnd / OrOr / BitAnd / BitOr expand truthy
  // into re+im checks), hoist any non-Var complex operand to a temp so
  // a Call-bearing expression (e.g. csqrt(z)) is not evaluated twice in
  // the generated C. Var operands are pure reads — double-use is harmless.
  const doubledOp =
    e.op === "Equal" ||
    e.op === "NotEqual" ||
    e.op === "AndAnd" ||
    e.op === "OrOr" ||
    e.op === "BitAnd" ||
    e.op === "BitOr";
  if (doubledOp) {
    if (lc && e.left.kind !== "Var") {
      const tmp = `_mtoc_cx_tmp_${state.complexTmpCounter++}`;
      pushStmt(state, state.currentLevel, `double _Complex ${tmp} = ${left};`);
      left = tmp;
    }
    if (rc && e.right.kind !== "Var") {
      const tmp = `_mtoc_cx_tmp_${state.complexTmpCounter++}`;
      pushStmt(state, state.currentLevel, `double _Complex ${tmp} = ${right};`);
      right = tmp;
    }
  }

  const reOf = (s: string, isComplex: boolean): string =>
    isComplex ? `creal(${s})` : s;
  const imOf = (s: string, isComplex: boolean): string =>
    isComplex ? `cimag(${s})` : "0.0";
  const truthy = (s: string, isComplex: boolean): string =>
    isComplex ? `(creal(${s}) != 0.0 || cimag(${s}) != 0.0)` : `(${s} != 0.0)`;

  let inner: string;
  switch (e.op) {
    case "Less":
    case "LessEqual":
    case "Greater":
    case "GreaterEqual": {
      const cOp = BIN_OP_C[e.op]!;
      inner = `${reOf(left, lc)} ${cOp} ${reOf(right, rc)}`;
      break;
    }
    case "Equal": {
      inner =
        `${reOf(left, lc)} == ${reOf(right, rc)} && ` +
        `${imOf(left, lc)} == ${imOf(right, rc)}`;
      break;
    }
    case "NotEqual": {
      inner =
        `${reOf(left, lc)} != ${reOf(right, rc)} || ` +
        `${imOf(left, lc)} != ${imOf(right, rc)}`;
      break;
    }
    case "AndAnd":
    case "BitAnd": {
      // Elementwise `&` (BitAnd) and short-circuit `&&` (AndAnd) collapse
      // to the same truthy-AND form on already-evaluated IR operands;
      // numbl's non-short-circuit semantics for `&` are preserved because
      // there are no IR-level side effects to observe a re-evaluation of.
      inner = `${truthy(left, lc)} && ${truthy(right, rc)}`;
      break;
    }
    case "OrOr":
    case "BitOr": {
      inner = `${truthy(left, lc)} || ${truthy(right, rc)}`;
      break;
    }
    default:
      throw new Error(
        `codegen internal: emitComplexCmpOrLogical called with op ${e.op}`
      );
  }
  // Always parenthesize at parent>=1 since the inner is a logical-style
  // expression; at top level we let it pass through.
  const p = precedence(e.op);
  return p < parentPrec ? `(${inner})` : inner;
}

/**
 * One-pass walker over an expression. Mutates `state.needMath`
 * whenever a node forces `<math.h>` (Call, Pow/ElemPow, infinite
 * NumLit) and activates any runtime snippet referenced by a Call.
 * Libm and user-function callees don't need a snippet; runtime
 * helpers do.
 *
 * Per-node analysis: runs `forEachSubExpr` so the per-node recursion
 * stays in one place. Each sub-expression flips the header flags it
 * forces, regardless of nesting depth.
 *   - Any complex-typed node forces <complex.h> (its rendering touches
 *     `I` / `creal` / `cimag` / `double _Complex`).
 *   - Non-finite NumLit / ImagLit forces <math.h> for INFINITY/NAN.
 *   - Pow / ElemPow forces <math.h> (rendered as `pow(...)`).
 *   - Any Call forces <math.h> (every builtin we currently emit lives
 *     in <math.h>; runtime-helper activation happens inside the
 *     closure when the call renders).
 */
export function analyzeExpr(state: EmitState, e: IRExpr): void {
  forEachSubExpr(e, sub => {
    if (isNumeric(sub.ty) && sub.ty.isComplex) {
      state.needComplex.value = true;
    }
    if (sub.kind === "NumLit" || sub.kind === "ImagLit") {
      if (!Number.isFinite(sub.value)) state.needMath.value = true;
      return;
    }
    if (sub.kind === "Call") {
      state.needMath.value = true;
      return;
    }
    if (sub.kind === "Binary" && (sub.op === "Pow" || sub.op === "ElemPow")) {
      state.needMath.value = true;
      return;
    }
  });
}
