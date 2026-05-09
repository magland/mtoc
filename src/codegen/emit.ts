/**
 * C code generator — typed IR → self-contained C source string.
 *
 * Emits a single .c file with a `main()` body. Today only scalar
 * `double` variables and a tiny subset of operators are supported;
 * everything else should have been rejected upstream.
 */

import { BinaryOperation, UnaryOperation } from "../parser/index.js";
import type {
  IRExpr,
  IRFunction,
  IRProgram,
  IRStmt,
  VarBinding,
} from "../lowering/ir.js";
import {
  cTypeFor,
  isCharArray,
  isCharScalar,
  isMultiElement,
  isOwned,
  isScalar,
  isScalarComplex,
  isScalarReal,
  isNumeric,
  isString,
  typeToString,
  type MType,
  type NumericType,
} from "../lowering/types.js";
import type { BuiltinEmitState } from "../workspace/builtins.js";
import {
  MTOC_CHAR_TENSOR_STRUCT,
  MTOC_DISP_COMPLEX,
  MTOC_DISP_DOUBLE,
  MTOC_STRING_STRUCT,
  MTOC_TENSOR_STRUCT,
  RUNTIME_HELPERS,
  type RuntimeSnippet,
} from "./runtime.js";
import {
  computeFutureTouches,
  topLevelOwnedDefs,
  topLevelOwnedUses,
  type FutureTouchMap,
} from "./liveness.js";

// Note: C-name mangling lives in lower.ts (`cNameFor`). Every IR.Var,
// IR.Assign, IR.For, IR.ReturnFromFunction and IRFunction param /
// output / assignedVars entry already carries the C identifier the
// codegen emits — emit.ts consumes those fields directly. The only
// names synthesized here are scope-local helpers (`_mtoc_i`,
// `_mtoc_n`, `_mtoc_t`, etc.) for loop counters and elementwise
// staging temporaries.

/** Render a numbl string-literal value as a C string-literal token,
 *  including the surrounding double quotes. UTF-8 bytes pass through;
 *  the C-side escape rules are minimal — the code units that need
 *  escaping in a C string are `"`, `\`, and the non-printable controls
 *  (`\n`, `\r`, `\t`, plus everything `< 0x20`). Anything ≥ 0x80 is
 *  emitted verbatim (assuming UTF-8 source); the C compiler accepts
 *  arbitrary bytes inside string literals. */
function formatStringLit(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x22) {
      out += '\\"';
    } else if (ch === 0x5c) {
      out += "\\\\";
    } else if (ch === 0x0a) {
      out += "\\n";
    } else if (ch === 0x0d) {
      out += "\\r";
    } else if (ch === 0x09) {
      out += "\\t";
    } else if (ch < 0x20 || ch === 0x7f) {
      // Octal escape so the next character is unambiguous (a hex
      // escape would chain into a following hex digit).
      out += `\\${(ch >>> 6).toString(8)}${((ch >>> 3) & 7).toString(8)}${(
        ch & 7
      ).toString(8)}`;
    } else {
      // Pass-through. JS strings are UTF-16; for code points >= 0x80
      // we emit each UTF-16 code unit's bytes via the source-level
      // encoding the file has on disk. `value` came in as a JS string
      // (UTF-16 code units), so charCodeAt(i) here is the actual code
      // unit. For ASCII-clean strings (the common case) this is fine.
      // Multi-byte UTF-8 inputs from the parser preserve their byte
      // sequence as JS chars when the source was decoded as UTF-8.
      out += value[i];
    }
  }
  out += '"';
  return out;
}

/** Byte length of a numbl string-literal value as it will end up at
 *  runtime. The lowerer's `value` field already holds the decoded
 *  string (quotes stripped, doubled-quote escapes collapsed). The
 *  byte length is the UTF-8 byte count; we approximate by computing
 *  the JS-side encoded byte count, which matches for well-formed
 *  UTF-16. */
function stringLitByteLen(value: string): number {
  // TextEncoder is available in Node and the browser. Emitter runs
  // in both via the bundled translator, so fall back to a manual
  // computation if it's missing (unlikely).
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    let n = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      if (ch < 0x80) n += 1;
      else if (ch < 0x800) n += 2;
      else n += 3;
    }
    return n;
  }
}

/** Format a single char code unit as a C char literal, e.g. `'a'`,
 *  `'\n'`, `'\''`. `ch` is a one-character string from the decoded
 *  numbl char literal value (quotes stripped, `''` collapsed). */
function formatCharLit(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code === 0x27) return "'\\''"; // single quote
  if (code === 0x5c) return "'\\\\'"; // backslash
  if (code === 0x0a) return "'\\n'";
  if (code === 0x0d) return "'\\r'";
  if (code === 0x09) return "'\\t'";
  if (code < 0x20 || code === 0x7f) {
    // Octal escape — unambiguous before a following digit.
    return `'\\${(code >>> 6).toString(8)}${((code >>> 3) & 7).toString(8)}${(code & 7).toString(8)}'`;
  }
  return `'${ch}'`;
}

function formatNumLit(n: number): string {
  if (Number.isNaN(n)) return "NAN";
  if (n === Infinity) return "INFINITY";
  if (n === -Infinity) return "(-INFINITY)";
  const s = String(n);
  // Force a `double` literal: append `.0` only when the JS string lacks
  // both a decimal point and an exponent (e.g. "12" → "12.0", but
  // "1.5" and "1e+308" stay as-is — adding ".0" to those is invalid C).
  if (!/[.eE]/.test(s)) {
    return `${s}.0`;
  }
  return s;
}

const BIN_OP_C: Partial<Record<BinaryOperation, string>> = {
  Add: "+",
  Sub: "-",
  Mul: "*",
  Div: "/",
  ElemMul: "*",
  ElemDiv: "/",
  Equal: "==",
  NotEqual: "!=",
  Less: "<",
  LessEqual: "<=",
  Greater: ">",
  GreaterEqual: ">=",
  AndAnd: "&&",
  OrOr: "||",
};

const UN_OP_C: Partial<Record<UnaryOperation, string>> = {
  Plus: "+",
  Minus: "-",
  Not: "!",
};

/** Higher number = tighter binding. parentPrec=0 means no parens by default. */
function precedence(op: BinaryOperation | UnaryOperation): number {
  switch (op) {
    case "OrOr":
      return 1;
    case "AndAnd":
      return 2;
    case "Equal":
    case "NotEqual":
      return 3;
    case "Less":
    case "LessEqual":
    case "Greater":
    case "GreaterEqual":
      return 4;
    case "Add":
    case "Sub":
      return 5;
    case "Mul":
    case "Div":
    case "ElemMul":
    case "ElemDiv":
      return 6;
    case "Pow":
    case "ElemPow":
      return 7;
    case "Plus":
    case "Minus":
    case "Not":
      return 8;
  }
  return 0;
}

interface EmitState {
  /** Boxed so the `BuiltinSig.emit` closure (which receives a small
   *  facade view, not the whole EmitState) can flip it. */
  needMath: { value: boolean };
  /** True when any complex value (literal, declaration, or operation)
   *  has been emitted — drives `<complex.h>` inclusion. Boxed for the
   *  same reason as `needMath`. */
  needComplex: { value: boolean };
  /** Runtime helpers used by the program, in stable order. */
  runtime: RuntimeSnippet[];
  /** Names of helpers already added to `runtime` (dedup). */
  runtimeNames: Set<string>;
  lines: string[];
  /** Stack of synthetic per-element loop-index C names. emit pushes
   *  one when it opens a per-element loop for a multi-element `Assign`
   *  RHS; the top of the stack is the innermost iter name. When the
   *  stack is non-empty, multi-element `Var`s render as
   *  `<cName>.real[<top>]` instead of `<cName>` (scalar `Var`s and
   *  `NumLit`s broadcast unchanged). Empty at the top level — scalar
   *  codegen contexts reject multi-element sub-exprs as before. */
  iterStack: string[];
  /** Counter for synthetic loop-index names so nested elementwise
   *  loops don't shadow each other. */
  elemwiseLoopCounter: number;
  /** assignedVars of the scope currently being emitted (main's vars
   *  while emitting `prog.stmts`, or the function's vars while
   *  emitting a function body). Used by the scope-exit cleanup helper
   *  to know which heap backings to free at `return` sites, and by
   *  `emitEarlyFrees` to look up an owned var's type so it can pick
   *  between `mtoc_tensor_free` and `mtoc_string_free`. */
  currentScopeVars: ReadonlyMap<string, VarBinding> | null;
  /** Per-statement future-touch sets for the scope currently being
   *  emitted. Drives the "early free" walk: an owned `v` whose last
   *  touch is statement `s` (i.e. `v` is in `(uses ∪ defs)(s)` but
   *  NOT in `futureTouchOut(s)`) gets a free call (tensor or string,
   *  picked from `v`'s type) immediately after the statement's C
   *  output. Null at the very top before any scope is entered. */
  futureTouches: FutureTouchMap | null;
  /** Owned C-names (tensors and strings; see `isOwned`) that have
   *  already been freed on the current linear emission path. Drives
   *  two things:
   *    - the scope-exit / `ReturnFromFunction` walk skips any var
   *      already in this set (avoids the redundant double-free emit),
   *    - branch merges in `If` take the intersection of the
   *      per-arm freed sets so a var freed only on some paths still
   *      gets the scope-exit safety-net free.
   *  Loop bodies snapshot-and-restore around themselves: vars freed
   *  inside the body don't graduate to the post-loop freed set,
   *  because the loop may have iterated zero times. */
  freedOwned: Set<string>;
  /** The outputs[] array of the user function currently being emitted,
   *  or null at script scope. Drives the codegen for
   *  `IRStmt.ReturnFromFunction`:
   *    - null   : script scope. (Lowering rejects `return` here, so a
   *               ReturnFromFunction reaching emit means a lowerer escape.)
   *    - length 0: zero-output function — emit a bare `return;` (no
   *               value).
   *    - length 1: classic single-output function — emit
   *               `return <cName>;` (return-by-value).
   *    - length ≥ 2: multi-output function — emit `*_mtoc_o<i> = <cName>;`
   *               for each output, then `return;`. */
  currentFunctionOutputs: ReadonlyArray<{
    name: string;
    cName: string;
    ty: MType;
  }> | null;
  /** Counter for synthetic discard-temp suffixes used at multi-output
   *  call sites (`_mtoc_discard_<N>_<slot>`). Each `MultiAssignCall`
   *  takes the next available index and bumps the counter, so two
   *  adjacent calls don't collide even though the temps are scoped
   *  inside per-call `{}` blocks. */
  multiAssignCallCounter: number;
}

/** Build the small facade view passed to `BuiltinSig.emit` closures.
 *  Hides the full `EmitState`; exposes only what the closures need
 *  (boxed needMath + a useRuntime function). */
function builtinEmitFacade(state: EmitState): BuiltinEmitState {
  return {
    needMath: state.needMath,
    useRuntime: name => useRuntimeByName(state, name),
  };
}

function emitExpr(state: EmitState, e: IRExpr, parentPrec: number): string {
  // Tensor-typed sub-expressions in scalar codegen contexts are caught
  // by the lowering-pass validator (lower.ts: `validateIR`). If one
  // reaches here, the lowerer let it through — that's an internal bug.
  // Inside an iter context, multi-element Binary/Unary nodes are
  // expected (each iteration consumes one element), so we only enforce
  // the check at the top level.
  // `CharLit` is excluded: a non-owning literal handle (char scalar or
  // char array) is safe in any expression position — no allocation.
  if (
    state.iterStack.length === 0 &&
    e.kind !== "Var" &&
    e.kind !== "TensorLit" &&
    e.kind !== "CharLit" &&
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

    case "StringLit": {
      // Build a non-owning `mtoc_string_t` whose `data` field points
      // straight at a C string literal in `.rodata`. Cheap — no
      // allocation. Activates the typedef + the helper.
      useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
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
        const iter = state.iterStack[state.iterStack.length - 1];
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
      // byte and widens to double for arithmetic.
      if (state.iterStack.length > 0 && isMultiElement(e.ty)) {
        const iter = state.iterStack[state.iterStack.length - 1];
        return `(double)(${formatStringLit(e.value)}[${iter}])`;
      }
      // Scalar char literal: render as a C char literal.
      if (isScalar(e.ty)) {
        return formatCharLit(e.value);
      }
      // Multi-element char in non-iter context: build a non-owning
      // `mtoc_char_tensor_t` pointing at the string literal in .rodata.
      useRuntime(state, "mtoc_char_tensor_t", MTOC_CHAR_TENSOR_STRUCT);
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
      // Copy-on-arg-pass: for user-function calls, every tensor-typed
      // argument is wrapped in `mtoc_tensor_copy(...)` so the callee
      // gets an owned tensor (which it may freely reassign or free at
      // scope exit). Builtins are known read-only and skip the wrap.
      const isUserCall = e.callee.kind === "userFunc";
      const argStrs = e.args.map(a => {
        const inner = emitExpr(state, a, 0);
        if (isUserCall && isMultiElement(a.ty)) {
          if (isCharArray(a.ty)) {
            // Char-array args: callee owns a copy (same as tensor args).
            useRuntimeByName(state, "mtoc_char_tensor_copy");
            return `mtoc_char_tensor_copy(${inner})`;
          }
          const helper =
            isNumeric(a.ty) && a.ty.isComplex
              ? "mtoc_tensor_copy_complex"
              : "mtoc_tensor_copy";
          useRuntimeByName(state, helper);
          return `${helper}(${inner})`;
        }
        return inner;
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
        useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
        useRuntimeByName(state, "mtoc_string_concat");
        const left = emitExpr(state, e.left, 0);
        const right = emitExpr(state, e.right, 0);
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
      const cOp = BIN_OP_C[e.op];
      if (cOp) {
        const p = precedence(e.op);
        // Left-associative: left at p, right at p+1 to force parens on
        // equal-precedence right-nested operators.
        const inner = `${emitExpr(state, e.left, p)} ${cOp} ${emitExpr(state, e.right, p + 1)}`;
        return p < parentPrec ? `(${inner})` : inner;
      }
      if (e.op === "Pow" || e.op === "ElemPow") {
        return `pow(${emitExpr(state, e.left, 0)}, ${emitExpr(state, e.right, 0)})`;
      }
      throw new Error(
        `codegen internal: unsupported binary op ${e.op}; ` +
          `should have been caught at lowering`
      );
    }

    case "Unary": {
      // Complex `~z` (Not) is the toBool negation: 1 iff re==0 && im==0.
      if (e.op === "Not" && isNumeric(e.operand.ty) && e.operand.ty.isComplex) {
        const s = emitExpr(state, e.operand, 0);
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

/** Binary ops that take the complex-aware branch in `emitExpr.Binary`
 *  whenever any operand is complex. (Arithmetic ops use C99's native
 *  complex operators, so they don't need this re-routing.) */
const CMP_OR_LOGICAL: ReadonlySet<BinaryOperation> = new Set<BinaryOperation>([
  BinaryOperation.Less,
  BinaryOperation.LessEqual,
  BinaryOperation.Greater,
  BinaryOperation.GreaterEqual,
  BinaryOperation.Equal,
  BinaryOperation.NotEqual,
  BinaryOperation.AndAnd,
  BinaryOperation.OrOr,
]);

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
  const left = emitExpr(state, e.left, 0);
  const right = emitExpr(state, e.right, 0);
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
    case "AndAnd": {
      inner = `${truthy(left, lc)} && ${truthy(right, rc)}`;
      break;
    }
    case "OrOr": {
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

function useRuntime(
  state: EmitState,
  name: string,
  snippet: RuntimeSnippet
): void {
  if (state.runtimeNames.has(name)) return;
  state.runtimeNames.add(name);
  // Pull in dependencies first so their definitions precede ours.
  for (const dep of snippet.deps) {
    const depSnippet = RUNTIME_HELPERS.get(dep);
    if (depSnippet) useRuntime(state, dep, depSnippet);
  }
  state.runtime.push(snippet);
}

/** Activate a snippet looked up from the registry by name. Throws if
 *  the name isn't registered — that means a codegen path is referring
 *  to a helper that doesn't exist. */
function useRuntimeByName(state: EmitState, name: string): void {
  const snippet = RUNTIME_HELPERS.get(name);
  if (!snippet) {
    throw new Error(`codegen: unknown runtime helper '${name}'`);
  }
  useRuntime(state, name, snippet);
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function pushStmt(state: EmitState, level: number, s: string): void {
  state.lines.push(`${indent(level)}${s}`);
}

/**
 * One-pass walker over an expression. Mutates `state.needMath`
 * whenever a node forces `<math.h>` (Call, Pow/ElemPow, infinite
 * NumLit) and activates any runtime snippet referenced by a Call.
 * Libm and user-function callees don't need a snippet; runtime
 * helpers do.
 */
function analyzeExpr(state: EmitState, e: IRExpr): void {
  // Any expression whose static type is complex forces <complex.h>:
  // its rendering touches `I`, `creal`, `cimag`, or a `double _Complex`
  // declaration somewhere downstream. Setting it on the way down keeps
  // the header activation centralized.
  if (isNumeric(e.ty) && e.ty.isComplex) {
    state.needComplex.value = true;
  }
  switch (e.kind) {
    case "NumLit":
      // INFINITY / NAN macros come from <math.h>.
      if (!Number.isFinite(e.value)) state.needMath.value = true;
      return;
    case "StringLit":
      // Renders to `mtoc_string_from_literal(...)` — no extra
      // standard-library header beyond what the runtime snippet
      // itself pulls in. The snippet activation happens at emit-time
      // when the literal renders.
      return;
    case "ImagLit":
      // The `I` macro and `double _Complex` type both come from
      // <complex.h>; the type-driven flag above handles activation.
      if (!Number.isFinite(e.value)) state.needMath.value = true;
      return;
    case "Var":
      return;
    case "TensorLit":
      for (const row of e.elements) for (const c of row) analyzeExpr(state, c);
      return;
    case "Call": {
      // Every builtin we currently emit lives in <math.h> (libm + the
      // mtoc runtime helpers all `#include <math.h>` themselves), so
      // any Call forces <math.h>. Runtime-helper activation happens
      // inside `BuiltinSig.emit` when the call renders — see emitExpr's
      // Call case. We don't pre-walk for activation here because emit
      // and analyze share the same traversal order, so the resulting
      // helper-list ordering matches.
      state.needMath.value = true;
      for (const a of e.args) analyzeExpr(state, a);
      return;
    }
    case "Binary":
      if (e.op === "Pow" || e.op === "ElemPow") state.needMath.value = true;
      analyzeExpr(state, e.left);
      analyzeExpr(state, e.right);
      return;
    case "Unary":
      analyzeExpr(state, e.operand);
      return;
  }
}

/**
 * Statement-level companion to `analyzeExpr`. Walks every expression
 * the statement transitively contains, plus sets `needMath` for stmts
 * whose codegen always emits a math.h call (currently only For — its
 * iteration-count formula uses floor()).
 */
function analyzeStmt(state: EmitState, s: IRStmt): void {
  switch (s.kind) {
    case "Assign":
      analyzeExpr(state, s.rhs);
      return;
    case "ExprStmt":
      analyzeExpr(state, s.expr);
      return;
    case "Disp":
      analyzeExpr(state, s.arg);
      return;
    case "Error":
      analyzeExpr(state, s.arg);
      return;
    case "If":
      analyzeExpr(state, s.cond);
      for (const t of s.thenBody) analyzeStmt(state, t);
      for (const eif of s.elseifs) {
        analyzeExpr(state, eif.cond);
        for (const t of eif.body) analyzeStmt(state, t);
      }
      if (s.elseBody) for (const t of s.elseBody) analyzeStmt(state, t);
      return;
    case "For":
      // The emitted iteration-count formula calls floor(), so any For
      // forces <math.h> regardless of what its bounds analyze to.
      state.needMath.value = true;
      analyzeExpr(state, s.start);
      analyzeExpr(state, s.step);
      analyzeExpr(state, s.end);
      for (const t of s.body) analyzeStmt(state, t);
      return;
    case "While":
      analyzeExpr(state, s.cond);
      for (const t of s.body) analyzeStmt(state, t);
      return;
    case "MultiAssignCall":
      // Mirrors the `Call` case in `analyzeExpr`: a user-function
      // call doesn't itself need <math.h>, but we set the flag for
      // structural symmetry with the analyzer's Call handling — the
      // arg pre-walk also activates any builtin runtime helpers a
      // sub-expression depends on.
      state.needMath.value = true;
      for (const a of s.args) analyzeExpr(state, a);
      return;
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return;
  }
}

/** Owned C-names (tensors and strings) that should be freed
 *  immediately after `s`, computed from the future-touch set produced
 *  by the dataflow pass. A name is "dead-after" iff it appears in
 *  `s`'s top-level uses or defs but is NOT touched (read or written)
 *  at any successor — i.e. `s` was its last touch on this level.
 *  Returns sorted (stable C output) and excludes names already freed
 *  on this linear path. */
function deadAfterStmt(state: EmitState, s: IRStmt): string[] {
  if (state.futureTouches === null) return [];
  const futureTouchOut = state.futureTouches.get(s);
  if (futureTouchOut === undefined) return [];
  const touched = topLevelOwnedUses(s);
  for (const d of topLevelOwnedDefs(s)) touched.add(d);
  const out: string[] = [];
  for (const v of touched) {
    if (futureTouchOut.has(v)) continue;
    if (state.freedOwned.has(v)) continue;
    out.push(v);
  }
  out.sort();
  return out;
}

/** Emit a free line for every name in `vars`, picking
 *  `mtoc_tensor_free` for multi-element double tensors,
 *  `mtoc_char_tensor_free` for char arrays, and `mtoc_string_free`
 *  for strings, mark them as freed on the current linear path, and
 *  activate the matching helper snippet on first use.
 *  The caller has already filtered against the current `freedOwned`
 *  set (see `deadAfterStmt`); this just emits and updates state. */
function emitEarlyFrees(
  state: EmitState,
  level: number,
  vars: ReadonlyArray<string>
): void {
  if (vars.length === 0) return;
  if (state.currentScopeVars === null) {
    throw new Error(
      "codegen internal: emitEarlyFrees called outside an emission scope"
    );
  }
  for (const v of vars) {
    const binding = state.currentScopeVars.get(v);
    if (binding === undefined) {
      throw new Error(
        `codegen internal: early-free for unknown var '${v}'; ` +
          `not in the current scope's free-on-exit set`
      );
    }
    const ty = binding.ty;
    if (isString(ty)) {
      useRuntimeByName(state, "mtoc_string_free");
      pushStmt(state, level, `mtoc_string_free(&${v});`);
    } else if (isCharArray(ty)) {
      useRuntimeByName(state, "mtoc_char_tensor_free");
      pushStmt(state, level, `mtoc_char_tensor_free(&${v});`);
    } else if (isNumeric(ty) && isMultiElement(ty)) {
      useRuntimeByName(state, "mtoc_tensor_free");
      pushStmt(state, level, `mtoc_tensor_free(&${v});`);
    } else {
      throw new Error(
        `codegen internal: early-free for non-owned var '${v}' ` +
          `(${typeToString(ty)})`
      );
    }
    state.freedOwned.add(v);
  }
}

function emitStmt(state: EmitState, level: number, s: IRStmt): void {
  switch (s.kind) {
    case "Assign": {
      // `state.needMath` and runtime activations were set up by the
      // analyzeStmt pre-pass; this function only generates lines.
      // Three RHS shapes:
      //   - TensorLit: codegen writes literal values directly into
      //     `<cName>.real[idx]` slots (no runtime loop).
      //   - scalar: a single `<cName> = <expr>;` assignment.
      //   - any other multi-element expression: emit a per-element
      //     loop that walks the RHS body once per slot, with multi-
      //     element `Var`s inside reading from `<varCName>.real[<iter>]`
      //     (see `emitExpr.Var`).
      // Assigning to an owned name re-installs its buffer via
      // `mtoc_tensor_assign` / `mtoc_string_assign`, so the new
      // lifetime starts here — drop the LHS from the freed set so a
      // subsequent dead-after pass can free it again on its own terms.
      if (isOwned(s.ty)) {
        state.freedOwned.delete(s.cName);
      }
      if (s.rhs.kind === "TensorLit") {
        emitTensorLitAssign(state, level, s.cName, s.rhs);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharScalar(s.ty)) {
        // Scalar char assigns directly — the RHS is always a CharLit
        // whose emitExpr renders as a C char literal (e.g. `'a'`).
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharArray(s.ty)) {
        // Char-array assignment goes through `mtoc_char_tensor_assign`,
        // which frees the prior owned buffer and installs the new value.
        // RHS forms:
        //   - CharLit (multi-element): non-owning literal handle from
        //     `mtoc_char_tensor_from_literal`; assign takes ownership.
        //   - Var (char array): deep-copy via `mtoc_char_tensor_copy`
        //     so the source stays usable.
        useRuntime(state, "mtoc_char_tensor_t", MTOC_CHAR_TENSOR_STRUCT);
        useRuntimeByName(state, "mtoc_char_tensor_assign");
        let rhsExpr: string;
        if (s.rhs.kind === "Var") {
          useRuntimeByName(state, "mtoc_char_tensor_copy");
          rhsExpr = `mtoc_char_tensor_copy(${s.rhs.cName})`;
        } else {
          rhsExpr = emitExpr(state, s.rhs, 0);
        }
        pushStmt(
          state,
          level,
          `mtoc_char_tensor_assign(&${s.cName}, ${rhsExpr});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarReal(s.ty) || isScalarComplex(s.ty)) {
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isString(s.ty)) {
        // Every string assignment goes through `mtoc_string_assign`,
        // which frees the prior owned buffer (or no-ops on a literal-
        // pointing handle) and installs the new value in one step.
        // The RHS shape we accept here mirrors what lowering admits:
        //   - StringLit: literal handle (zero allocation).
        //   - Var: deep-copy via `mtoc_string_copy` so the source
        //     stays usable for later reads.
        //   - Binary(Add, string, string): produces a fresh owned
        //     handle via `mtoc_string_concat`.
        useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
        useRuntimeByName(state, "mtoc_string_assign");
        let rhsExpr: string;
        if (s.rhs.kind === "Var") {
          useRuntimeByName(state, "mtoc_string_copy");
          rhsExpr = `mtoc_string_copy(${s.rhs.cName})`;
        } else {
          // StringLit and string Binary route through the standard
          // emitExpr path; both produce a stand-alone `mtoc_string_t`
          // value (literal handle or freshly-concat'd owned handle).
          rhsExpr = emitExpr(state, s.rhs, 0);
        }
        pushStmt(state, level, `mtoc_string_assign(&${s.cName}, ${rhsExpr});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isNumeric(s.ty) && isMultiElement(s.ty) && s.ty.elem === "double") {
        // Tensor-by-name: `y = x;` collapses to a single helper call
        // pair — `mtoc_tensor_assign(&y, mtoc_tensor_copy(x));`. The
        // RHS-is-a-Var case is the simplest manifestation of "every
        // manipulation copies"; non-trivial RHSs (Binary, Unary, …)
        // build a fresh tensor via the elementwise loop below.
        if (s.rhs.kind === "Var") {
          emitTensorVarCopyAssign(state, level, s.cName, s.rhs);
          emitEarlyFrees(state, level, deadAfterStmt(state, s));
          break;
        }
        emitTensorAssignFromExpr(state, level, s.cName, s.rhs);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      throw new Error(
        `codegen: assignment to '${s.name}' with type ${typeToString(s.ty)} ` +
          `is not yet supported`
      );
    }

    case "ExprStmt": {
      pushStmt(state, level, `(void)(${emitExpr(state, s.expr, 0)});`);
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "Disp": {
      const ty = s.arg.ty;
      if (isString(ty)) {
        // Handle is either `StringLit` (renders as
        // `mtoc_string_from_literal(...)`) or `Var` (renders as the
        // bare cName) — both produce an `mtoc_string_t` value to pass
        // straight to the helper. No allocation for the literal path.
        useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
        useRuntimeByName(state, "mtoc_disp_string");
        pushStmt(
          state,
          level,
          `mtoc_disp_string(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharScalar(ty)) {
        // Scalar char: print the single character + newline.
        useRuntimeByName(state, "mtoc_disp_char");
        pushStmt(state, level, `mtoc_disp_char(${emitExpr(state, s.arg, 0)});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharArray(ty)) {
        // Char array disp: accepts both Var (renders as cName) and
        // CharLit (renders as mtoc_char_tensor_from_literal(...)).
        // `mtoc_disp_char_tensor` takes its argument by value, so
        // either form is a valid C expression.
        useRuntimeByName(state, "mtoc_disp_char_tensor");
        pushStmt(
          state,
          level,
          `mtoc_disp_char_tensor(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarReal(ty)) {
        useRuntime(state, "mtoc_disp_double", MTOC_DISP_DOUBLE);
        // Non-variadic call — `int` operands auto-promote to `double`,
        // so no manual cast is needed (unlike `printf("%g", ...)`).
        pushStmt(
          state,
          level,
          `mtoc_disp_double(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarComplex(ty)) {
        useRuntime(state, "mtoc_disp_complex", MTOC_DISP_COMPLEX);
        pushStmt(
          state,
          level,
          `mtoc_disp_complex(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
        // The lowering pass requires tensor `disp` args to be a Var;
        // anything else would have thrown at lowering with a span.
        if (s.arg.kind !== "Var") {
          throw new Error(
            "codegen internal: non-Var tensor disp arg reached emit; " +
              "should have been rejected at lowering"
          );
        }
        const helper = ty.isComplex
          ? "mtoc_disp_tensor_complex"
          : "mtoc_disp_tensor";
        useRuntimeByName(state, helper);
        pushStmt(state, level, `${helper}(${s.arg.cName});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      throw new Error(
        `codegen: disp of ${typeToString(ty)} is not yet supported`
      );
    }

    case "If": {
      // Each arm is emitted with a snapshot of `freedOwned`; after
      // all arms finish, the post-If freed set is the intersection
      // (a var is "definitely freed" only if every arm freed it).
      // Implicit else (no `s.elseBody`) contributes the pre-If
      // snapshot — the implicit fall-through arm freed nothing — so
      // its intersection forces vars freed only in some arms back
      // out of the post-If freed set, and the scope-exit safety net
      // catches them.
      const preFreed = new Set(state.freedOwned);
      const armFreedSets: Set<string>[] = [];

      pushStmt(state, level, `if (${emitExpr(state, s.cond, 0)}) {`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.thenBody) emitStmt(state, level + 1, t);
      armFreedSets.push(state.freedOwned);

      for (const eif of s.elseifs) {
        pushStmt(state, level, `} else if (${emitExpr(state, eif.cond, 0)}) {`);
        state.freedOwned = new Set(preFreed);
        for (const t of eif.body) emitStmt(state, level + 1, t);
        armFreedSets.push(state.freedOwned);
      }

      if (s.elseBody) {
        pushStmt(state, level, `} else {`);
        state.freedOwned = new Set(preFreed);
        for (const t of s.elseBody) emitStmt(state, level + 1, t);
        armFreedSets.push(state.freedOwned);
      } else {
        // Implicit fall-through arm freed nothing on top of `preFreed`.
        armFreedSets.push(preFreed);
      }
      pushStmt(state, level, `}`);

      // Intersection of arm freed sets — the post-If linear path.
      const merged = new Set<string>(armFreedSets[0]);
      for (let i = 1; i < armFreedSets.length; i++) {
        const next = armFreedSets[i];
        for (const v of merged) if (!next.has(v)) merged.delete(v);
      }
      state.freedOwned = merged;

      // After the If, free anything in the cond that's now dead.
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "While": {
      // Snapshot: vars freed inside the loop body don't graduate to
      // the post-loop linear path because the loop may have iterated
      // zero times. The per-iteration frees still run at runtime —
      // mtoc_tensor_free is idempotent on a zeroed struct, so a
      // post-loop scope-exit free of the same var (via the safety
      // net) is sound.
      const preFreed = new Set(state.freedOwned);
      pushStmt(state, level, `while (${emitExpr(state, s.cond, 0)}) {`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.body) emitStmt(state, level + 1, t);
      pushStmt(state, level, `}`);
      state.freedOwned = preFreed;
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "Error": {
      // `error(s)` lowers to a direct call into the runtime helper.
      // The helper prints to stderr and `exit(1)`s, so any code after
      // this statement is unreachable at runtime. We don't try to
      // free heap-owned tensors / strings before the call: the OS
      // reclaims everything on `exit`, and matching numbl's behavior
      // is what we care about for cross-runner parity.
      useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
      useRuntimeByName(state, "mtoc_error_string");
      pushStmt(
        state,
        level,
        `mtoc_error_string(${emitExpr(state, s.arg, 0)});`
      );
      break;
    }

    case "Break":
      pushStmt(state, level, `break;`);
      break;

    case "Continue":
      pushStmt(state, level, `continue;`);
      break;

    case "ReturnFromFunction": {
      // Free every tensor backing in the enclosing function's scope
      // before we return — but skip ones already freed earlier on
      // this linear path so the same var doesn't get a redundant
      // free emit. `currentScopeVars` is set to `fn.assignedVars` (+
      // tensor params) by `emitFunctionBody`. Lowering only emits
      // this kind inside a function body, so the field is always
      // non-null here.
      if (
        state.currentScopeVars === null ||
        state.currentFunctionOutputs === null
      ) {
        throw new Error(
          "codegen internal: ReturnFromFunction reached emit outside a " +
            "function scope; should have been rejected at lowering"
        );
      }
      emitScopeExitFrees(
        state,
        level,
        state.currentScopeVars,
        state.freedOwned
      );
      const outputs = state.currentFunctionOutputs;
      if (outputs.length === 0) {
        // Zero-output function: no value to carry back, no out-pointer
        // writes. Emit a bare `return;` so the C control-flow path is
        // explicit. Falls through cleanly to the `void` return type
        // emitted by `emitFunction`.
        pushStmt(state, level, `return;`);
      } else if (outputs.length === 1) {
        // Classic single-output convention: return-by-value of the
        // local that holds the output's current value at this exit
        // point. The lowerer captured that live cName when it built
        // the IR node.
        pushStmt(state, level, `return ${s.outputCNames[0]};`);
      } else {
        // Multi-output convention: write each output's local into
        // the corresponding `_mtoc_o<i>` out-pointer (declared as a
        // C parameter by `emitFunction`), then `return;`.
        for (let i = 0; i < outputs.length; i++) {
          pushStmt(state, level, `*_mtoc_o${i} = ${s.outputCNames[i]};`);
        }
        pushStmt(state, level, `return;`);
      }
      break;
    }

    case "MultiAssignCall": {
      // Multi-output / 0-output user-function call. The invariant set
      // by `lowerMultiAssignCall`:
      //   - `outputs.length === 0`           → 0-output bare statement
      //   - `outputs.length >= 2`            → either an N-output
      //     `[a, b, ~] = foo(x);` or the drop-all bare form
      //     `foo(x);` (every slot.binding is null).
      // The call site never appears with `outputs.length === 1`
      // because that case routes to `Assign` / `ExprStmt(Call)` in
      // lowering (1-output is return-by-value).
      const argStrs = s.args.map(a => {
        const inner = emitExpr(state, a, 0);
        // Copy-on-arg-pass for tensor args, mirroring the regular
        // `Call` path in `emitExpr`.
        if (isMultiElement(a.ty)) {
          if (isCharArray(a.ty)) {
            useRuntimeByName(state, "mtoc_char_tensor_copy");
            return `mtoc_char_tensor_copy(${inner})`;
          }
          const helper =
            isNumeric(a.ty) && a.ty.isComplex
              ? "mtoc_tensor_copy_complex"
              : "mtoc_tensor_copy";
          useRuntimeByName(state, helper);
          return `${helper}(${inner})`;
        }
        return inner;
      });
      if (s.outputs.length === 0) {
        // Zero-output: simplest form — bare `<mangled>(args);`. No
        // discard temps, no surrounding block.
        pushStmt(state, level, `${s.mangled}(${argStrs.join(", ")});`);
        // An owned LHS reassigned via the call's outputs would have
        // been recorded already (see the freedOwned bookkeeping
        // below); 0-output calls have nothing to reset.
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      // N≥2-output: open a `{}` block so any discard temps stay
      // scoped to the call. For each ignored slot, declare a typed
      // `_mtoc_discard_<callIdx>_<slot>` local and pass its address;
      // for each named slot, pass the address of the lowered
      // binding's predeclared local. Per-call counter on the
      // EmitState gives each call a unique suffix for its temps,
      // even though they're structurally scoped — handy when reading
      // the emitted C diff for unrelated calls.
      const callIdx = state.multiAssignCallCounter++;
      pushStmt(state, level, `{`);
      const outArgs: string[] = [];
      for (let i = 0; i < s.outputs.length; i++) {
        const slot = s.outputs[i];
        const cTy = cTypeFor(slot.ty);
        if (cTy === null) {
          throw new Error(
            `codegen internal: MultiAssignCall slot ${i} of '${s.name}' ` +
              `has unsupported type ${typeToString(slot.ty)}`
          );
        }
        if (slot.binding === null) {
          const tmp = `_mtoc_discard_${callIdx}_${i}`;
          pushStmt(state, level + 1, `${cTy} ${tmp};`);
          outArgs.push(`&${tmp}`);
        } else {
          outArgs.push(`&${slot.binding.cName}`);
        }
      }
      pushStmt(
        state,
        level + 1,
        `${s.mangled}(${[...argStrs, ...outArgs].join(", ")});`
      );
      pushStmt(state, level, `}`);
      // Reassigning to an owned LHS via the call clears its freed
      // marker on the current linear path, mirroring `Assign` to an
      // owned LHS. Today user-function outputs must be scalars (so
      // never owned), but the bookkeeping stays consistent for the
      // day they can be.
      for (const slot of s.outputs) {
        if (slot.binding !== null && isOwned(slot.ty)) {
          state.freedOwned.delete(slot.binding.cName);
        }
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "For": {
      // Step is guaranteed to be a NumLit by lowering.
      if (s.step.kind !== "NumLit") {
        throw new Error(
          "codegen internal: for-loop step must be a NumLit; " +
            "should have been caught at lowering"
        );
      }
      const v = s.cVar;
      const startStr = emitExpr(state, s.start, 0);
      const endStr = emitExpr(state, s.end, 0);
      const stepStr = formatNumLit(s.step.value);

      // MATLAB semantics: after the loop, the loop variable holds the
      // LAST in-bounds value, not one step past it. We compute the
      // iteration count up front and derive `var = start + step * i`
      // each iteration so it never advances past that last value.
      // Wrapped in a block so `_mtoc_*` helpers are scoped per-loop;
      // nested for-loops shadow them without collision.
      // Linear-path freedOwned: snapshot/restore around the body
      // for the same reason as `While` — body may iterate zero
      // times, so frees inside don't graduate to the post-loop set.
      const preFreed = new Set(state.freedOwned);
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
      pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
      pushStmt(
        state,
        level + 1,
        `long _mtoc_n = (long)floor((_mtoc_end - _mtoc_start) / ${stepStr}) + 1;`
      );
      pushStmt(state, level + 1, `if (_mtoc_n < 0) _mtoc_n = 0;`);
      pushStmt(
        state,
        level + 1,
        `for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {`
      );
      pushStmt(state, level + 2, `${v} = _mtoc_start + ${stepStr} * _mtoc_i;`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.body) emitStmt(state, level + 2, t);
      pushStmt(state, level + 1, `}`);
      pushStmt(state, level, `}`);
      state.freedOwned = preFreed;
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }
  }
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
  switch (e.kind) {
    case "Var":
      return isMultiElement(e.ty) ? e : null;
    case "Binary": {
      const left = findShapeSourceVar(e.left);
      if (left) return left;
      return findShapeSourceVar(e.right);
    }
    case "Unary":
      return findShapeSourceVar(e.operand);
    case "Call":
      for (const a of e.args) {
        const v = findShapeSourceVar(a);
        if (v) return v;
      }
      return null;
    case "CharLit":
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "TensorLit":
      return null;
  }
}

/** Walk an IR expression and return the first multi-element CharLit
 *  encountered — the fallback shape-source for elementwise assigns
 *  where the RHS contains no multi-element Var (e.g. `'abc' + 1` or
 *  `'abc' == 'def'`). The CharLit's `.value.length` gives the static
 *  column count; rows are always 1 for char arrays. */
function findCharLitShapeSource(
  e: IRExpr
): Extract<IRExpr, { kind: "CharLit" }> | null {
  switch (e.kind) {
    case "CharLit":
      return isMultiElement(e.ty) ? e : null;
    case "Binary": {
      const left = findCharLitShapeSource(e.left);
      if (left) return left;
      return findCharLitShapeSource(e.right);
    }
    case "Unary":
      return findCharLitShapeSource(e.operand);
    case "Call":
      for (const a of e.args) {
        const v = findCharLitShapeSource(a);
        if (v) return v;
      }
      return null;
    case "Var":
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "TensorLit":
      return null;
  }
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
  switch (e.kind) {
    case "Var":
      if (isMultiElement(e.ty) && !out.has(e.cName)) out.set(e.cName, e);
      return;
    case "Binary":
      collectMultiElementVarsByCName(e.left, out);
      collectMultiElementVarsByCName(e.right, out);
      return;
    case "Unary":
      collectMultiElementVarsByCName(e.operand, out);
      return;
    case "Call":
      for (const a of e.args) collectMultiElementVarsByCName(a, out);
      return;
    case "CharLit":
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "TensorLit":
      return;
  }
}

/** Emit `<target> = <var>;` where `<var>` is a tensor variable. The
 *  cleanest manifestation of "copy on every manipulation": one helper
 *  call to copy the source, one helper call to consume-replace the
 *  target. Same shape regardless of real/complex (codegen picks the
 *  right `mtoc_tensor_copy{,_complex}` variant statically). */
function emitTensorVarCopyAssign(
  state: EmitState,
  level: number,
  cTarget: string,
  src: Extract<IRExpr, { kind: "Var" }>
): void {
  useRuntimeByName(state, "mtoc_tensor_assign");
  const isComplex = isNumeric(src.ty) && src.ty.isComplex;
  const copyHelper = isComplex
    ? "mtoc_tensor_copy_complex"
    : "mtoc_tensor_copy";
  useRuntimeByName(state, copyHelper);
  pushStmt(
    state,
    level,
    `mtoc_tensor_assign(&${cTarget}, ${copyHelper}(${src.cName}));`
  );
}

/** Emit an Assign whose multi-element RHS is NOT a TensorLit and not
 *  a bare Var. Pattern: read shape from a deterministic shape-source
 *  `Var`, allocate a fresh tensor via `mtoc_tensor_alloc{,_complex}`
 *  (so reads from the target inside the body see the OLD buffer —
 *  important when the RHS aliases the target, e.g. `M = M + 1`),
 *  evaluate the body into the staging tensor's slots, then
 *  `mtoc_tensor_assign(&target, _mtoc_t)` to consume-replace the
 *  target. Wrapped in `{}` so the staging local is scoped per
 *  Assign. */
function emitTensorAssignFromExpr(
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
  useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
  useRuntimeByName(state, "mtoc_tensor_assign");

  const isComplex = isNumeric(rhs.ty) && rhs.ty.isComplex;
  const allocHelper = isComplex
    ? "mtoc_tensor_alloc_complex"
    : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);

  const iterId = state.elemwiseLoopCounter++;
  const iterName = iterId === 0 ? "_mtoc_i" : `_mtoc_i${iterId}`;
  // Single-purpose name for the staging tensor — distinct from the
  // `_mtoc_t<n>` per-cell complex temp in `emitTensorLitAssign`, which
  // never appears in this function's emission.
  const stagingName = "_mtoc_t";

  // Collect every distinct multi-element Var in the RHS (keyed by
  // cName so duplicates like `v .* v` collapse). The shape source
  // already picked by `findShapeSourceVar` is the first entry; for
  // every other Var we emit one `mtoc_check_shape(<source>, <other>)`
  // before the staging-buffer alloc. Same-Var and scalar-broadcast
  // cases produce zero checks. The check is once-per-assign — once
  // the source is shape-compatible with every other operand, every
  // per-element read inside the loop is in bounds.
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

  // Shape args: either from a Var's runtime rows/cols, or from the
  // static length of a CharLit (always a 1×N row vector).
  const shapeArgs =
    src !== null
      ? `${src.cName}.rows, ${src.cName}.cols`
      : `1, ${charLitSrc!.value.length}`;

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
  pushStmt(
    state,
    level + 1,
    `long _mtoc_n = ${stagingName}.rows * ${stagingName}.cols;`
  );
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
function emitTensorLitAssign(
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
  useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
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

/** Emit predeclarations for a {cName → VarBinding} table. Scalars
 *  become `double <cName> = 0.0;` (real) or `double _Complex <cName> = 0.0;`
 *  (complex). Multi-element tensors are predeclared empty
 *  (`mtoc_tensor_t <cName> = mtoc_tensor_empty();`); the assignment
 *  site overwrites them via `mtoc_tensor_assign`, which frees the
 *  empty buffers (a no-op on NULL) and installs the new ones.
 *  Activates the `mtoc_tensor_t` typedef + `mtoc_tensor_empty` helper
 *  whenever any tensor is declared. Cleanup is paired in
 *  `emitScopeExitFrees`, invoked at every `return` site. */
function emitDeclarations(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>
): void {
  // Iteration order: by C identifier so the generated declaration order
  // is stable across runs.
  const cNames = [...vars.keys()].sort();
  for (const key of cNames) {
    const binding = vars.get(key)!;
    const { ty, cName } = binding;
    if (isCharScalar(ty)) {
      // Scalar char: bare C `char`, zero-initialized to NUL.
      pushStmt(state, level, `char ${cName} = '\\0';`);
      continue;
    }
    if (isCharArray(ty)) {
      // Char-array predecl mirrors the tensor/string pattern: a
      // known-empty handle that every assignment overwrites via
      // `mtoc_char_tensor_assign`. The empty handle has `owned=0`
      // so a scope-exit free of an uninitialized var is a safe no-op.
      useRuntime(state, "mtoc_char_tensor_t", MTOC_CHAR_TENSOR_STRUCT);
      useRuntimeByName(state, "mtoc_char_tensor_empty");
      pushStmt(
        state,
        level,
        `mtoc_char_tensor_t ${cName} = mtoc_char_tensor_empty();`
      );
      continue;
    }
    if (isScalarReal(ty)) {
      pushStmt(state, level, `double ${cName} = 0.0;`);
      continue;
    }
    if (isScalarComplex(ty)) {
      pushStmt(state, level, `double _Complex ${cName} = 0.0;`);
      continue;
    }
    if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
      useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
      useRuntimeByName(state, "mtoc_tensor_empty");
      pushStmt(state, level, `mtoc_tensor_t ${cName} = mtoc_tensor_empty();`);
      continue;
    }
    if (isString(ty)) {
      // String predecls mirror tensors: a known-empty handle that
      // every assignment overwrites via `mtoc_string_assign`. Since
      // `owned=0` on the empty handle, the scope-exit free / first
      // reassignment's free is a safe no-op.
      useRuntime(state, "mtoc_string_t", MTOC_STRING_STRUCT);
      useRuntimeByName(state, "mtoc_string_empty");
      pushStmt(state, level, `mtoc_string_t ${cName} = mtoc_string_empty();`);
      continue;
    }
    throw new Error(
      `codegen internal: unsupported declaration for '${cName}': ` +
        `${typeToString(ty)}; should have been caught at lowering`
    );
  }
}

/** Emit `mtoc_tensor_free(&<v>);` for every multi-element tensor
 *  binding in `vars` that has NOT already been freed earlier on the
 *  current linear path (`alreadyFreed`). Iteration order matches
 *  `emitDeclarations` (sorted by C identifier) so generated C stays
 *  deterministic. Called at every scope-exit site — end of `main`,
 *  end of each function body, and every `IRStmt.ReturnFromFunction`.
 *  The same helper handles real and complex (free(NULL) is
 *  well-defined and the imag-side free is a no-op for real tensors),
 *  so there is no per-call branch on `isComplex`. Vars added here
 *  are also recorded in `alreadyFreed` so callers chaining further
 *  emissions (e.g. multiple `ReturnFromFunction` paths) don't
 *  re-emit. */
function emitScopeExitFrees(
  state: EmitState,
  level: number,
  vars: ReadonlyMap<string, VarBinding>,
  alreadyFreed: Set<string>
): void {
  const cNames = [...vars.keys()].sort();
  let tensorActivated = false;
  let charTensorActivated = false;
  let stringActivated = false;
  for (const key of cNames) {
    const binding = vars.get(key)!;
    const { ty, cName } = binding;
    if (isCharArray(ty)) {
      if (alreadyFreed.has(cName)) continue;
      if (!charTensorActivated) {
        useRuntimeByName(state, "mtoc_char_tensor_free");
        charTensorActivated = true;
      }
      pushStmt(state, level, `mtoc_char_tensor_free(&${cName});`);
      alreadyFreed.add(cName);
      continue;
    }
    if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
      if (alreadyFreed.has(cName)) continue;
      if (!tensorActivated) {
        useRuntimeByName(state, "mtoc_tensor_free");
        tensorActivated = true;
      }
      pushStmt(state, level, `mtoc_tensor_free(&${cName});`);
      alreadyFreed.add(cName);
      continue;
    }
    if (isString(ty)) {
      if (alreadyFreed.has(cName)) continue;
      if (!stringActivated) {
        useRuntimeByName(state, "mtoc_string_free");
        stringActivated = true;
      }
      pushStmt(state, level, `mtoc_string_free(&${cName});`);
      alreadyFreed.add(cName);
      continue;
    }
  }
}

/** Build the per-function "free at scope exit" set: every entry in
 *  `assignedVars` plus every multi-element tensor parameter. Tensor
 *  params are owned by the callee under copy-on-arg-pass — the caller
 *  wraps each argument in `mtoc_tensor_copy(...)`, so the param's
 *  buffer is the callee's responsibility to release. Scalar params
 *  stay out of the set: they have no heap buffer. */
function functionFreeOnExitSet(
  fn: IRFunction
): ReadonlyMap<string, VarBinding> {
  const out = new Map<string, VarBinding>(fn.assignedVars);
  for (const p of fn.params) {
    if (isMultiElement(p.ty)) {
      out.set(p.cName, { ty: p.ty, cName: p.cName });
    }
  }
  return out;
}

/** Emit the body of a user-defined function (predeclarations + body
 *  stmts + scope-exit frees + final return) into a fresh local-line
 *  buffer. The frees pair with `emitDeclarations`'s heap allocations
 *  AND with the caller-side `mtoc_tensor_copy` for every tensor
 *  parameter: every tensor local AND every owned tensor param is
 *  freed before the implicit fall-through return, and every
 *  `IRStmt.ReturnFromFunction` early exit picks up the same free
 *  preamble (driven by `state.currentScopeVars`). */
function emitFunctionBody(
  state: EmitState,
  fn: IRFunction
): { lines: string[] } {
  // Swap in a fresh `lines` buffer so the function's body lines don't
  // intermix with main's. Other state (runtime / needMath) is shared.
  const outerLines = state.lines;
  const outerScopeVars = state.currentScopeVars;
  const outerLiveness = state.futureTouches;
  const outerFreed = state.freedOwned;
  const outerOutputs = state.currentFunctionOutputs;
  state.lines = [];
  // Predecls cover assignedVars only — params are declared by the C
  // signature. Scope-exit frees cover both: locals from the body and
  // owned tensor params from the call site.
  const freeOnExit = functionFreeOnExitSet(fn);
  state.currentScopeVars = freeOnExit;
  state.futureTouches = computeFutureTouches(fn.body);
  state.freedOwned = new Set();
  state.currentFunctionOutputs = fn.outputs;

  emitDeclarations(state, 1, fn.assignedVars);
  for (const s of fn.body) emitStmt(state, 1, s);
  // Implicit fall-through return at the end of the function: free every
  // tensor backing not already released earlier on the linear path,
  // then carry the output(s) back. Early-exit `return` paths emitted
  // by `IRStmt.ReturnFromFunction` carry their own copy of the free
  // preamble + output write (see `emitStmt`).
  emitScopeExitFrees(state, 1, freeOnExit, state.freedOwned);
  if (fn.outputs.length === 0) {
    // 0-output: C `void` function; no fall-through write or return
    // value is needed. Skip the trailing `return;` — falling off the
    // end of a `void` function is well-defined.
  } else if (fn.outputs.length === 1) {
    // Classic single-output convention: return-by-value of the
    // post-body live binding's C name.
    pushStmt(state, 1, `return ${fn.outputs[0].cName};`);
  } else {
    // Multi-output convention: write each output's local through the
    // matching `_mtoc_o<i>` out-pointer, then `return;`. Out-pointers
    // are declared as C parameters by `emitFunction`.
    for (let i = 0; i < fn.outputs.length; i++) {
      pushStmt(state, 1, `*_mtoc_o${i} = ${fn.outputs[i].cName};`);
    }
    pushStmt(state, 1, `return;`);
  }

  const bodyLines = state.lines;
  state.lines = outerLines;
  state.currentScopeVars = outerScopeVars;
  state.futureTouches = outerLiveness;
  state.freedOwned = outerFreed;
  state.currentFunctionOutputs = outerOutputs;
  return { lines: bodyLines };
}

/** Render the per-specialization header comment that goes above each
 *  emitted user function. Includes source location, mangled name, and
 *  the inferred type signature so the generated C is self-explanatory. */
function functionHeaderComment(fn: IRFunction): string[] {
  const labelWidth = Math.max(
    "returns".length,
    ...fn.params.map(p => p.name.length),
    ...fn.outputs.map(o => o.name.length)
  );
  const pad = (s: string) => s.padEnd(labelWidth);
  const argSummary = fn.params.map(p => p.name).join(", ");
  const loc = fn.sourceLocation;
  const lineRange =
    loc.startLine === loc.endLine
      ? `${loc.startLine}`
      : `${loc.startLine}-${loc.endLine}`;
  const lines: string[] = [];
  lines.push(
    `/* User function specialization: ${fn.matlabName}(${argSummary})`
  );
  lines.push(` *   defined : ${loc.file}:${lineRange}`);
  lines.push(` *   mangled : ${fn.mangledName}`);
  for (const p of fn.params) {
    lines.push(` *   ${pad(p.name)} : ${typeToString(p.ty)}`);
  }
  if (fn.outputs.length === 0) {
    lines.push(` *   ${pad("returns")} : (none)`);
  } else if (fn.outputs.length === 1) {
    lines.push(` *   ${pad("returns")} : ${typeToString(fn.outputs[0].ty)}`);
  } else {
    // Multi-output: render each output on its own line so the C ABI
    // (out-pointer per output) is readable.
    for (const o of fn.outputs) {
      lines.push(` *   ${pad(o.name)} : ${typeToString(o.ty)} (out)`);
    }
  }
  lines.push(` */`);
  return lines;
}

function emitFunction(state: EmitState, fn: IRFunction): string[] {
  // C return-type and outputs:
  //   - 0 outputs   : `void` return type, no out-pointer params.
  //   - 1 output    : classic return-by-value (scalar real → `double`,
  //                   scalar complex → `double _Complex`).
  //   - N outputs   : `void` return type plus one trailing
  //                   `T_i *_mtoc_o<i>` parameter per output.
  // Lowering rejects tensor outputs per-output (sret is a future
  // stage); any tensor shape reaching here is a lowerer escape.
  for (const o of fn.outputs) {
    if (isMultiElement(o.ty)) {
      throw new Error(
        `codegen: function '${fn.matlabName}' output '${o.name}' has ` +
          `unsupported type ${typeToString(o.ty)}`
      );
    }
  }
  let returnCTy: string;
  if (fn.outputs.length === 1) {
    const cTy = cTypeFor(fn.outputs[0].ty);
    if (cTy === null) {
      throw new Error(
        `codegen: function '${fn.matlabName}' has unsupported return type ` +
          `${typeToString(fn.outputs[0].ty)}`
      );
    }
    returnCTy = cTy;
    if (isNumeric(fn.outputs[0].ty) && fn.outputs[0].ty.isComplex) {
      state.needComplex.value = true;
    }
  } else {
    returnCTy = "void";
  }
  // Per param: `cTypeFor` picks the C representation — `double` for
  // real scalars, `double _Complex` for complex scalars, and the
  // `mtoc_tensor_t` struct for any multi-element tensor (real or
  // complex; the struct's `imag` buffer carries the complex half).
  // Tensor params are owned by the callee: the caller wraps each
  // tensor argument in `mtoc_tensor_copy(...)` (see emitExpr's Call
  // case), so the param's buffer is the callee's responsibility to
  // release. The scope-exit free walk in `emitFunctionBody` adds
  // every multi-element tensor param to the free set.
  const paramParts: string[] = [];
  let needsTensorTypedef = false;
  let needsCharTensorTypedef = false;
  for (const p of fn.params) {
    const cTy = cTypeFor(p.ty);
    if (cTy === null) {
      throw new Error(
        `codegen: function '${fn.matlabName}' parameter '${p.name}' has ` +
          `unsupported type ${typeToString(p.ty)}`
      );
    }
    if (isCharArray(p.ty)) needsCharTensorTypedef = true;
    else if (isMultiElement(p.ty)) needsTensorTypedef = true;
    if (isNumeric(p.ty) && p.ty.isComplex) state.needComplex.value = true;
    paramParts.push(`${cTy} ${p.cName}`);
  }
  // Multi-output convention: append `T_i *_mtoc_o<i>` per output
  // after the user params, in declaration order.
  if (fn.outputs.length >= 2) {
    for (let i = 0; i < fn.outputs.length; i++) {
      const o = fn.outputs[i];
      const cTy = cTypeFor(o.ty);
      if (cTy === null) {
        throw new Error(
          `codegen: function '${fn.matlabName}' output '${o.name}' has ` +
            `unsupported type ${typeToString(o.ty)}`
        );
      }
      if (isNumeric(o.ty) && o.ty.isComplex) state.needComplex.value = true;
      paramParts.push(`${cTy} *_mtoc_o${i}`);
    }
  }
  if (needsTensorTypedef) {
    useRuntime(state, "mtoc_tensor_t", MTOC_TENSOR_STRUCT);
  }
  if (needsCharTensorTypedef) {
    useRuntime(state, "mtoc_char_tensor_t", MTOC_CHAR_TENSOR_STRUCT);
  }
  const paramList = paramParts.join(", ");
  const sig = `static ${returnCTy} ${fn.mangledName}(${paramList || "void"}) {`;
  const { lines } = emitFunctionBody(state, fn);
  return [...functionHeaderComment(fn), sig, ...lines, "}"];
}

/** Options for `emitC`. */
export interface EmitOptions {
  /** When false, the runtime-helper bodies (`mtoc_format_double`,
   *  `mtoc_disp_double`, `mtoc_tensor_t` typedef, etc.) are omitted
   *  from the output. Headers contributed solely by those snippets
   *  are likewise omitted; standard headers needed by the user code
   *  itself (`<math.h>` for `floor()` in for-loops, `<complex.h>`
   *  when complex appears) stay. The caller is then responsible for
   *  providing `mtoc_*` symbols at link time — useful when embedding
   *  mtoc output into a project that supplies its own runtime.
   *  Default: true (full self-contained translation unit). */
  includeRuntime?: boolean;
}

export function emitC(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;

  const state: EmitState = {
    needMath: { value: false },
    needComplex: { value: false },
    runtime: [],
    runtimeNames: new Set(),
    lines: [],
    iterStack: [],
    elemwiseLoopCounter: 0,
    currentScopeVars: null,
    futureTouches: null,
    freedOwned: new Set(),
    currentFunctionOutputs: null,
    multiAssignCallCounter: 0,
  };

  // One-pass pre-walk: activates runtime helpers referenced by the
  // program (main + every function body) AND sets `state.needMath`
  // for every node that forces <math.h>. Walking everything before
  // emitting keeps the helper ordering stable.
  for (const fn of prog.functions) {
    for (const s of fn.body) analyzeStmt(state, s);
  }
  for (const s of prog.stmts) analyzeStmt(state, s);

  // Emit user-function bodies first into separate buffers; we paste
  // them into the output below, before main.
  const functionBlocks: string[][] = prog.functions.map(fn =>
    emitFunction(state, fn)
  );

  // Predeclare every assigned variable at the top of main. Hoisting
  // keeps the C valid even when an `if` branch introduces a new
  // variable that is read after the block.
  state.currentScopeVars = prog.assignedVars;
  state.futureTouches = computeFutureTouches(prog.stmts);
  state.freedOwned = new Set();
  emitDeclarations(state, 1, prog.assignedVars);
  for (const s of prog.stmts) emitStmt(state, 1, s);
  // Free every tensor backing allocated for top-level vars not
  // already released earlier on the linear path before `return 0;`.
  // (Process exit would reclaim it anyway, but the free keeps memory
  // tooling clean and matches the function-body pattern.)
  emitScopeExitFrees(state, 1, prog.assignedVars, state.freedOwned);
  state.currentScopeVars = null;
  state.futureTouches = null;

  // Headers: explicit needs from user code, plus runtime-snippet
  // headers when those snippets are part of the output. With
  // `includeRuntime: false`, only the user-code-level needs survive
  // — the caller's link environment supplies whatever the runtime
  // helpers would have brought in.
  const headerSet = new Set<string>(["<stdio.h>"]);
  if (state.needMath.value) headerSet.add("<math.h>");
  if (state.needComplex.value) headerSet.add("<complex.h>");
  if (includeRuntime) {
    for (const snippet of state.runtime) {
      for (const h of snippet.headers) headerSet.add(h);
    }
  }
  const headers = [...headerSet].map(h => `#include ${h}`);

  const runtimeBlocks = includeRuntime ? state.runtime.map(s => s.code) : [];

  const out: string[] = [...headers, ""];
  for (const block of runtimeBlocks) {
    out.push(block, "");
  }
  for (const fnLines of functionBlocks) {
    out.push(...fnLines, "");
  }
  out.push("int main(void) {", ...state.lines, "  return 0;", "}", "");
  return out.join("\n");
}
