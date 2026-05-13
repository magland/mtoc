/**
 * Builtin registry — typed signatures for every MATLAB function mtoc
 * knows how to translate.
 *
 * Each entry is a `BuiltinSig`: it owns its parameter constraints
 * (shape + sign-domain + element kind), a `result(argTys)` function
 * that computes the result MType, and an `emit(argStrs, state)`
 * closure that renders the call to C. This keeps every builtin's
 * lowering- and codegen-side knowledge in one place — adding a new
 * shape-polymorphic builtin or stmt-only builtin (`error`, `assert`)
 * means appending one entry and writing two short closures.
 *
 * The factories below (`libm`, `runtime`, `reduceTensor`) keep the
 * registry terse for the common cases. Shape-dispatched reductions
 * (`sum` / `min` / `max` over a tensor argument) drive their lowering
 * through the per-builtin `lowerExpr` hook + `oneArgReductionLowerExpr`
 * factory, since the result kind (scalar vs tensor) depends on the
 * argument's static shape.
 */

import type { Expr, Span } from "../parser/index.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import type { IRExpr, IRStmt } from "../lowering/ir.js";
import {
  arithResult,
  charArrayType,
  dimIsOne,
  isCharArray,
  isCharScalar,
  isHigherDim,
  isMultiElement,
  isNumeric,
  isScalar,
  isScalarComplex,
  isScalarReal,
  isString,
  isText,
  MTOC_MAX_NDIM,
  numericTypeND,
  rowVecDouble,
  scalarComplex,
  scalarDouble,
  signIsNonneg,
  signIsPositive,
  STRING,
  typeToString,
  type DimInfo,
  type MType,
  type NumericType,
  type Sign,
} from "../lowering/types.js";

/** Sign-domain constraint on an argument. `null` means no constraint. */
export type Domain = "nonnegative" | "positive" | null;

/**
 * Whether complex arguments are admissible at this parameter slot:
 *
 *   - "real-only"        — complex input is rejected at lowering with
 *                          a clear `TypeError` ("…cannot accept a
 *                          complex argument"). Default for everything
 *                          that maps to a libm-real-only function.
 *   - "real-or-complex"  — both real and complex are admissible. The
 *                          builtin's `result`/`emit` closures dispatch
 *                          on input type to produce the right C call.
 *   - "complex-only"     — only complex input. Rare; exists for forward
 *                          compat (e.g. a future `cabs` exposed under
 *                          a complex-only name).
 */
export type ComplexDomain = "real-only" | "real-or-complex" | "complex-only";

/**
 * Per-parameter constraint, used both for arg admissibility and for
 * driving sign-domain checks. Combine shape + sign-domain in one
 * place so adding a new constraint type touches one struct.
 */
export interface ParamConstraint {
  /** Acceptable argument shape:
   *    - "scalar"  – only 1×1 inputs (today's default)
   *    - "vector"  – row vector or column vector (rejects scalar + matrix)
   *    - "tensor"  – any multi-element tensor (rejects scalar)
   *    - "any"     – no shape check (used by `disp`, future stmt-only
   *                  builtins like `assert`).
   */
  shape: "scalar" | "vector" | "tensor" | "any";
  /** Signature-level sign domain. The lowerer converts a violation
   *  into a clear `TypeError` at the call site. Sign is meaningless
   *  on complex inputs; the lowerer's domain check skips when the
   *  arg is complex (the builtin still dispatches on type to choose
   *  a real-vs-complex implementation). */
  domain: Domain;
  /** Element-kind constraint. `null` means any. (Today only "double"
   *  exists; here for forward-compat with single/int/logical/char.) */
  elem: "double" | null;
  /** Whether complex inputs are admissible. Default "real-only" so
   *  legacy libm builtins keep their pre-complex behavior. */
  complexDomain: ComplexDomain;
}

/**
 * Builtin "category" — does this name appear at expression position
 * (a value-producing call like `sqrt(x)`) or only at statement
 * position (e.g. `disp(x)`, future `error(...)`, `assert(...)`)?
 *
 * Statement-only entries route through their dedicated lowering path
 * (today: `IRStmt.Disp`); the registry lookup just provides the
 * discovery + name + uniform rejection of mis-positioned uses.
 */
export type BuiltinCategory = "expr" | "stmt";

/**
 * Codegen state surface exposed to a builtin's `emit` closure. We
 * type it as a small interface here (rather than importing emit.ts'
 * `EmitState`) to avoid a circular import; emit.ts constructs an
 * adapter that satisfies this interface.
 */
export interface BuiltinEmitState {
  /** Boxed boolean so the closure can flip it. Today every Call
   *  forces <math.h>; future builtins (e.g. an integer-only helper)
   *  could leave it alone. */
  needMath: { value: boolean };
  /** Activate a snippet by name from the runtime registry. Idempotent
   *  (dedupe is in emit.ts); the closure can call this freely. */
  useRuntime: (name: string) => void;
}

/** Codegen hook. Returns the C expression that replaces the call.
 *  `argStrs` are already-emitted C expressions for each argument;
 *  `argTys` are the inferred MTypes of those arguments (the closure
 *  uses them to dispatch on `isComplex` for builtins with both real
 *  and complex implementations — e.g. `sqrt` → `csqrt`). */
export type BuiltinEmit = (
  argStrs: ReadonlyArray<string>,
  argTys: ReadonlyArray<MType>,
  state: BuiltinEmitState
) => string;

/**
 * Surface of the lowerer that builtin lowering hooks need. Defined as
 * an interface in this file (rather than importing the Lowerer class)
 * so the registry stays free of a runtime dependency on lowering. The
 * Lowerer class satisfies this structurally.
 */
export interface BuiltinLowerCtx {
  /** Lower a parser-level expression to an IRExpr. */
  lowerExpr(e: Expr): IRExpr;
}

/** Optional statement-position lowering for a builtin. Invoked from
 *  the lowerer's `ExprStmt(name(args))` arm BEFORE the default
 *  expression-call path. Return an `IRStmt` to use as the stmt's
 *  lowered form, or `null` to defer back to the default. Receives raw
 *  AST args so the hook can do its own shape validation alongside
 *  lowering. */
export type BuiltinLowerStmt = (
  ctx: BuiltinLowerCtx,
  args: ReadonlyArray<Expr>,
  span: Span
) => IRStmt | null;

/** Optional expression-position lowering override for a builtin.
 *  Invoked from `lowerFuncCall` AFTER args are lowered but BEFORE the
 *  default `IRExpr.Call` build, so the hook can inspect arg types
 *  (e.g. `length(s)` constant-folds to 1 for a string arg) and
 *  return a different IRExpr. Return `null` to defer back to the
 *  default. */
export type BuiltinLowerExpr = (
  ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
) => IRExpr | null;

/**
 * One MATLAB builtin's typed signature + codegen hook.
 *
 * The lowerer reads `params` for arg validation and calls `result`
 * to compute the call's MType. emit.ts invokes `emit` to render the
 * call to C; the closure activates any runtime helper it depends on
 * via `state.useRuntime`.
 */
export interface BuiltinSig {
  /** MATLAB function name. */
  name: string;
  /** Whether this builtin is callable at expression position
   *  ("expr") or only as a statement ("stmt"). */
  category: BuiltinCategory;
  /** Per-arg constraints. Length is the arity. */
  params: ReadonlyArray<ParamConstraint>;
  /** Compute the result MType from the lowered arg types. May throw
   *  `TypeError` (from `lowering/errors.js`) for type-domain
   *  violations the call site should see; the lowerer wraps the
   *  throw with the call's span when needed. */
  result: (argTys: ReadonlyArray<MType>) => MType;
  /** Render this call to C. The default for libm-mapped builtins is
   *  `(args) => `${cName}(${args.join(", ")})\``; runtime-helper
   *  builtins additionally `state.useRuntime(name)`. Statement-only
   *  builtins (today only `disp`) provide an emit that throws — they
   *  never reach the value-producing emit path. */
  emit: BuiltinEmit;
  /** Optional statement-position lowering. When present, the lowerer's
   *  `ExprStmt(name(args))` arm consults this hook before the default
   *  expression-call path. Statement-only builtins (`disp`, `error`)
   *  use this to produce dedicated IR nodes (`IRStmt.Disp`,
   *  `IRStmt.Error`). Returning `null` defers to the default. */
  lowerStmt?: BuiltinLowerStmt;
  /** Optional expression-position lowering override. Invoked after
   *  args are lowered; lets a builtin constant-fold or rewrite the
   *  call before the default `IRExpr.Call` build (e.g.
   *  `length(string)` → `NumLit(1)`, `length(charArray)` → struct
   *  field access). Returning `null` defers to the default. */
  lowerExpr?: BuiltinLowerExpr;
  /** True when this builtin's `emit` closure renders a single C
   *  expression that returns a freshly-owned tensor / string handle
   *  (e.g. `mtoc_zeros_nd(...)`, `mtoc_size_vec(...)`, a user-function
   *  call returning a struct-by-value tensor). Such Calls go straight
   *  into `mtoc_<kind>_assign(&lhs, foo(args))` at an owned-LHS
   *  Assign, and ANF / the IR validator recognize them as owned
   *  producers that need hoisting out of nested positions.
   *
   *  False / unset for the default elementwise-lift path, where the
   *  builtin's scalar sig is materialized over a tensor argument by
   *  the iter-loop codegen (`emitTensorAssignFromExpr`).
   *
   *  When you synthesize a one-shot sig in a `lowerExpr` hook that
   *  emits a tensor-returning runtime helper, set this flag — the
   *  scalar-input-scalar-output param shape is otherwise
   *  indistinguishable from an elementwise lift. */
  producesOwnedDirectly?: boolean;
  /** When true, a real argument whose static sign misses a param's
   *  `domain` is NOT rejected at lowering — the call is admitted and
   *  the result type is promoted to complex (so the complex sibling
   *  emits at codegen). Numbl's runtime falls back from `realFn` to
   *  `complexFn` on NaN, returning a complex value; mtoc commits at
   *  codegen to the complex type whenever it cannot prove the input
   *  meets the domain. Set on builtins whose complex extension is
   *  total: `sqrt`, `log`, `asin`, `acos`, `log2`, `log10`. Requires
   *  the builtin's `result`/`emit` to dispatch on input sign so the
   *  complex sibling fires whenever the domain isn't statically met. */
  promoteOnDomainMiss?: boolean;
}

// ── Factory helpers ─────────────────────────────────────────────────────

function scalarParams(
  arity: number,
  domains: ReadonlyArray<Domain> = [],
  complexDomain: ComplexDomain = "real-only"
): ParamConstraint[] {
  return Array.from({ length: arity }, (_, i) => ({
    shape: "scalar" as const,
    domain: domains[i] ?? null,
    elem: "double" as const,
    complexDomain,
  }));
}

/** True when at least one of the argument types is statically complex. */
function anyComplex(argTys: ReadonlyArray<MType>): boolean {
  return argTys.some(t => isNumeric(t) && t.isComplex);
}

/**
 * Behavior of a libm-style builtin on a complex input:
 *   - "propagates" — complex input → complex output. The complex
 *     C-side name (e.g. `csqrt`) is invoked. Sign on the complex
 *     result is "unknown" by the type-system invariant.
 *   - "real"       — input may be complex but the output is always
 *     real (e.g. `abs` → `cabs` returns a `double`).
 */
type ComplexResultKind = "propagates" | "real";

interface LibmComplexOpts {
  /** Optional complex C-side name (e.g. `"csqrt"`). When set, complex
   *  inputs are admitted; otherwise complex inputs are rejected at
   *  lowering with a clean error. */
  complexCName?: string;
  /** What complex-arg input does to the result type. Default
   *  "propagates" (sqrt, exp, log, sin, …). Set to "real" for `abs`,
   *  whose `cabs` returns a `double`. Ignored when `complexCName` is
   *  unset. */
  complexResult?: ComplexResultKind;
  /** Sign of the result when the input is complex. Defaults to
   *  "unknown"; `cabs`-style builtins set this to "nonnegative". */
  complexResultSign?: Sign;
  /** Promote the result to complex when a real arg's static sign
   *  misses the param's `domain` (instead of rejecting at lowering).
   *  Requires `complexCName` — the complex sibling is used to render
   *  the call. See `BuiltinSig.promoteOnDomainMiss` for context. */
  promoteOnDomainMiss?: boolean;
}

/** True iff the real arg in slot `i` has a static sign that fails
 *  `domains[i]`. Complex args and missing-domain slots return `false`
 *  unconditionally. Used to decide between the real C call and the
 *  complex sibling on a promote-on-domain-miss builtin. */
function realArgMissesDomain(
  argTys: ReadonlyArray<MType>,
  domains: ReadonlyArray<Domain>
): boolean {
  for (let i = 0; i < argTys.length; i++) {
    const ty = argTys[i];
    if (!isNumeric(ty)) continue;
    if (ty.isComplex) continue;
    const dom = domains[i];
    if (!dom) continue;
    if (dom === "nonnegative" && !signIsNonneg(ty.sign)) return true;
    if (dom === "positive" && !signIsPositive(ty.sign)) return true;
  }
  return false;
}

/** Builtin that maps directly to a libm function. Optionally also
 *  carries a complex sibling (e.g. `csqrt`) that takes over for
 *  complex inputs. */
function libm(
  name: string,
  arity: 1 | 2,
  cName: string,
  resultSign: Sign,
  domains: ReadonlyArray<Domain> = [],
  complexOpts: LibmComplexOpts = {}
): BuiltinSig {
  const {
    complexCName,
    complexResult = "propagates",
    complexResultSign = "nonnegative",
    promoteOnDomainMiss = false,
  } = complexOpts;
  const complexDomain: ComplexDomain = complexCName
    ? "real-or-complex"
    : "real-only";
  const useComplex = (argTys: ReadonlyArray<MType>): boolean =>
    !!complexCName &&
    (anyComplex(argTys) ||
      (promoteOnDomainMiss && realArgMissesDomain(argTys, domains)));
  return {
    name,
    category: "expr",
    params: scalarParams(arity, domains, complexDomain),
    promoteOnDomainMiss,
    result: argTys => {
      if (useComplex(argTys)) {
        return complexResult === "propagates"
          ? scalarComplex()
          : scalarDouble(complexResultSign);
      }
      return scalarDouble(resultSign);
    },
    emit: (args, argTys) => {
      const target = useComplex(argTys) ? complexCName! : cName;
      return `${target}(${args.join(", ")})`;
    },
  };
}

interface RuntimeComplexOpts {
  complexHelperName?: string;
  complexResult?: ComplexResultKind;
  complexResultSign?: Sign;
  /** When true, the *real-side* `helperName` is a libm function rather
   *  than a registered runtime helper — emit calls the libm name
   *  directly without `state.useRuntime`. Set when adding a complex
   *  sibling to a real-libm-backed builtin (e.g. `log2`/`log10`/`expm1`/
   *  `log1p`: real → libm, complex → mtoc_clog2 / etc.). */
  realIsLibm?: boolean;
}

/** Builtin that maps to a registered mtoc runtime helper. Optionally
 *  carries a complex sibling helper for complex inputs; the real-side
 *  target may be either a runtime helper or a libm function (see
 *  `realIsLibm`). */
function runtime(
  name: string,
  arity: 1 | 2,
  helperName: string,
  resultSign: Sign,
  domains: ReadonlyArray<Domain> = [],
  complexOpts: RuntimeComplexOpts = {}
): BuiltinSig {
  const {
    complexHelperName,
    complexResult = "propagates",
    complexResultSign = "unknown",
    realIsLibm = false,
  } = complexOpts;
  const complexDomain: ComplexDomain = complexHelperName
    ? "real-or-complex"
    : "real-only";
  return {
    name,
    category: "expr",
    params: scalarParams(arity, domains, complexDomain),
    result: argTys => {
      if (complexHelperName && anyComplex(argTys)) {
        return complexResult === "propagates"
          ? scalarComplex()
          : scalarDouble(complexResultSign);
      }
      return scalarDouble(resultSign);
    },
    emit: (args, argTys, state) => {
      const useComplex = complexHelperName !== undefined && anyComplex(argTys);
      const target = useComplex ? complexHelperName! : helperName;
      // Only activate a runtime helper when the chosen target is one;
      // libm fallbacks render bare.
      if (useComplex || !realIsLibm) {
        state.useRuntime(target);
      }
      return `${target}(${args.join(", ")})`;
    },
  };
}

/** 1-arg multi-element tensor reduction returning a scalar of fixed
 *  sign (e.g. `length`, `numel`). These are pure introspection — the
 *  result is rows/cols-derived and doesn't touch element values — so
 *  complex tensors are admissible. */
function reduceTensor(
  name: string,
  helperName: string,
  resultSign: Sign
): BuiltinSig {
  return {
    name,
    category: "expr",
    params: [
      {
        shape: "tensor",
        domain: null,
        elem: "double",
        complexDomain: "real-or-complex",
      },
    ],
    result: () => scalarDouble(resultSign),
    emit: (args, _argTys, state) => {
      state.useRuntime(helperName);
      return `${helperName}(${args.join(", ")})`;
    },
  };
}

/** Helper-name table for the four shape × element-kind reduction
 *  variants. `runtimeKey` is the name the codegen activates via
 *  `state.useRuntime(...)`; `cName` is the function the emit closure
 *  renders. The two differ for `min`/`max` (one umbrella .h file
 *  defines both the min and max C functions) but are identical for
 *  `sum` (one .h per C function). Used by `oneArgReductionLowerExpr`
 *  to pick the right helper based on the input's static shape and
 *  element kind. */
interface ReductionHelpers {
  realAll: { runtimeKey: string; cName: string };
  complexAll: { runtimeKey: string; cName: string };
  realDefault: { runtimeKey: string; cName: string };
  complexDefault: { runtimeKey: string; cName: string };
}

const SUM_REDUCTION: ReductionHelpers = {
  realAll: { runtimeKey: "mtoc_sum", cName: "mtoc_sum" },
  complexAll: { runtimeKey: "mtoc_sum_complex", cName: "mtoc_sum_complex" },
  realDefault: { runtimeKey: "mtoc_sum_default", cName: "mtoc_sum_default" },
  complexDefault: {
    runtimeKey: "mtoc_sum_complex_default",
    cName: "mtoc_sum_complex_default",
  },
};

const MIN_REDUCTION: ReductionHelpers = {
  realAll: { runtimeKey: "mtoc_minmax_real_all", cName: "mtoc_min_real_all" },
  complexAll: {
    runtimeKey: "mtoc_minmax_complex_all",
    cName: "mtoc_min_complex_all",
  },
  realDefault: {
    runtimeKey: "mtoc_minmax_real_default",
    cName: "mtoc_min_real_default",
  },
  complexDefault: {
    runtimeKey: "mtoc_minmax_complex_default",
    cName: "mtoc_min_complex_default",
  },
};

const MAX_REDUCTION: ReductionHelpers = {
  realAll: { runtimeKey: "mtoc_minmax_real_all", cName: "mtoc_max_real_all" },
  complexAll: {
    runtimeKey: "mtoc_minmax_complex_all",
    cName: "mtoc_max_complex_all",
  },
  realDefault: {
    runtimeKey: "mtoc_minmax_real_default",
    cName: "mtoc_max_real_default",
  },
  complexDefault: {
    runtimeKey: "mtoc_minmax_complex_default",
    cName: "mtoc_max_complex_default",
  },
};

// ── Registry ────────────────────────────────────────────────────────────

const BUILTINS: BuiltinSig[] = [
  // ── Statement-only ───────────────────────────────────────────────────
  // `disp(x)` and `error(s)` own their statement lowering via
  // `lowerStmt`. The lowerer's `ExprStmt(name(...))` arm consults the
  // hook before the default expression-call path; it produces a
  // dedicated IR node (`IRStmt.Disp` / `IRStmt.Error`) that codegen
  // recognizes for kind-specific output (e.g. `mtoc_disp_double`,
  // `mtoc_disp_tensor`, `mtoc_error_text`). The expression-position
  // emit closures throw — `category === "stmt"` ensures the lowerer
  // never reaches them.
  {
    name: "disp",
    category: "stmt",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Void" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'disp'.emit should not be called — disp lowers to IRStmt.Disp"
      );
    },
    lowerStmt: (ctx, args, span) => {
      if (args.length !== 1) return null;
      const arg = ctx.lowerExpr(args[0]);
      // The post-lowering ANF pass hoists any multi-element non-Var
      // expression at this consume site into a synthetic
      // `_mtoc_anf_<N>` Assign, so codegen ultimately sees a Var or
      // literal regardless of what shape the user wrote here.
      return { kind: "Disp", arg, span };
    },
  },

  // `assert(cond)` — verify a scalar real condition at runtime.
  // numbl's `assert` throws on a falsy or NaN value; mtoc lowers it
  // to `IRStmt.Assert`, which codegen emits as a call into the
  // `mtoc_assert_double` runtime helper (prints "Assertion failed"
  // to stderr and exit(1)s on failure, no-op on success). The
  // 2-arg `assert(cond, msg)` and tensor-condition forms are
  // deferred — rejected at lowering with a span. Numbl rejects
  // a genuinely-complex `cond` (its assert has no complex branch),
  // so we do too.
  {
    name: "assert",
    category: "stmt",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-only",
      },
    ],
    result: () => ({ kind: "Void" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'assert'.emit should not be called — assert lowers to IRStmt.Assert"
      );
    },
    lowerStmt: (ctx, args, span) => {
      if (args.length !== 1 && args.length !== 2) {
        throw new UnsupportedConstruct(
          `'assert' takes 1 or 2 arguments (got ${args.length})`,
          span
        );
      }
      const cond = ctx.lowerExpr(args[0]);
      if (!isScalarReal(cond.ty)) {
        throw new UnsupportedConstruct(
          `'assert' currently requires a scalar real ` +
            `condition (got ${typeToString(cond.ty)})`,
          args[0].span
        );
      }
      let msg: IRExpr | null = null;
      if (args.length === 2) {
        msg = ctx.lowerExpr(args[1]);
        if (!isText(msg.ty)) {
          throw new UnsupportedConstruct(
            `'assert' message must be a string or char array ` +
              `(got ${typeToString(msg.ty)})`,
            args[1].span
          );
        }
        // Codegen wraps `msg` in a text view (`mtoc_text_from_string`
        // / `mtoc_text_from_char_tensor`). The ANF pass hoists any
        // non-Var multi-element / owned-producer msg into a synthetic
        // Assign so codegen sees a Var or literal.
      }
      return { kind: "Assert", cond, msg, span };
    },
  },

  // `error(msg)` raises a numbl RuntimeError; codegen emits
  // `mtoc_error_text(view);`. Accepts either a string or a char-array
  // message (numbl treats them interchangeably here); the codegen
  // bridges via the text view. `error(id, fmt, …)` shapes are deferred.
  {
    name: "error",
    category: "stmt",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Void" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'error'.emit should not be called — error lowers to IRStmt.Error"
      );
    },
    lowerStmt: (ctx, args, span) => {
      if (args.length !== 1) return null;
      const arg = ctx.lowerExpr(args[0]);
      if (!isText(arg.ty)) {
        throw new UnsupportedConstruct(
          `'error' currently requires a single string or char-array argument ` +
            `(got ${typeToString(arg.ty)})`,
          args[0].span
        );
      }
      // The ANF pass hoists any non-Var multi-element / owned-
      // producer arg into a synthetic Assign so codegen sees a Var
      // or literal at the call site.
      return { kind: "Error", arg, span };
    },
  },

  // `fprintf(fmt, args...)` / `fprintf(fid, fmt, args...)` — formatted
  // output to stdout. Statement-only in v1; the value-returning form
  // `n = fprintf(...)` is deferred (no test corpus consumes the byte
  // count, and the expression-position shape would need a separate
  // owned-call path). Lowering restricts the fid to a literal 1 or 2:
  // numbl's runtime routes both to its single `output` stream, and
  // mtoc matches by emitting both to stdout. Other fids surface as
  // UnsupportedConstruct until file-I/O lands.
  {
    name: "fprintf",
    category: "stmt",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Void" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'fprintf'.emit should not be called — " +
          "fprintf lowers to IRStmt.Fprintf"
      );
    },
    lowerStmt: (ctx, args, span) => fprintfLowerStmt(ctx, args, span),
  },

  // `sprintf(fmt, args...)` — return formatted text as an owned value.
  // The return *type* tracks numbl: a char-typed format ('single-quoted')
  // returns a char-array (`mtoc_char_tensor_t`); a string-typed format
  // ("double-quoted") returns a string (`mtoc_string_t`). Both routes
  // share the same C engine — `mtoc_sprintf_char` and `mtoc_sprintf_str`
  // are thin wrappers in `sprintf.h`. The synthetic sig built by
  // `sprintfLowerExpr` carries `producesOwnedDirectly: true` so the
  // ANF pass hoists the call into its own Assign at non-top-level
  // positions.
  {
    name: "sprintf",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'sprintf'.emit should not be called — " +
          "sprintf is lowered through its lowerExpr hook"
      );
    },
    lowerExpr: (_ctx, args, span) => sprintfLowerExpr(args, span),
  },

  // ── 1-arg rounding family — real → libm; complex → componentwise ─────
  // numbl's `floor` / `ceil` / `round` / `fix` apply componentwise on
  // complex (numbl/src/numbl-core/interpreter/builtins/math.ts):
  //   floor(z) = floor(creal(z)) + floor(cimag(z)) * I    (and similarly)
  // C99 doesn't ship `cfloor`/`cceil`/`cround`/`ctrunc`, so each complex
  // sibling is a small runtime helper. Real inputs keep the bare libm
  // emit (`realIsLibm: true` — no `useRuntime` activation).
  // `mod`/`rem` are real-only by numbl semantics (their sign-of-divisor
  // / truncate-to-zero rules don't have a sensible complex extension).
  runtime("floor", 1, "floor", "unknown", [], {
    complexHelperName: "mtoc_floor_complex",
    realIsLibm: true,
  }),
  runtime("ceil", 1, "ceil", "unknown", [], {
    complexHelperName: "mtoc_ceil_complex",
    realIsLibm: true,
  }),
  runtime("round", 1, "round", "unknown", [], {
    complexHelperName: "mtoc_round_complex",
    realIsLibm: true,
  }),
  runtime("fix", 1, "trunc", "unknown", [], {
    complexHelperName: "mtoc_trunc_complex",
    realIsLibm: true,
  }),

  // ── String / char comparison ─────────────────────────────────────────
  // `strcmp(a, b)` returns 1.0 if the two text values match
  // byte-for-byte, 0.0 otherwise. Accepts strings and char arrays in
  // any combination — both arms get wrapped in a text view at the
  // call site and dispatched through a single `mtoc_strcmp_text`
  // helper. Scalar chars (bare `char`) are still rejected today
  // since the test corpus doesn't need them; numbl returns 0 for
  // type-mismatched inputs (e.g. number vs string), but we'd rather
  // raise a span at lowering than silently always-return-0.
  {
    name: "strcmp",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => scalarDouble("nonnegative"),
    emit: (args, argTys, state) => {
      state.useRuntime("mtoc_strcmp_text");
      state.useRuntime("mtoc_text_view_t");
      const view = (i: number): string => {
        if (isString(argTys[i])) return `mtoc_text_from_string(${args[i]})`;
        return `mtoc_text_from_char_tensor(${args[i]})`;
      };
      return `mtoc_strcmp_text(${view(0)}, ${view(1)})`;
    },
    lowerExpr: (_ctx, args, span) => {
      if (args.length !== 2) return null;
      const a = args[0].ty;
      const b = args[1].ty;
      if (!isText(a) || !isText(b)) {
        throw new UnsupportedConstruct(
          `'strcmp' currently requires both arguments to be ` +
            `char arrays or strings (got ${typeToString(a)} ` +
            `and ${typeToString(b)})`,
          span
        );
      }
      return null;
    },
  },

  // ── 1-arg numeric predicates — return 0.0/1.0 ────────────────────────
  // `isnan` / `isinf` / `isfinite` map to C99 macros (in <math.h>)
  // which return int; an explicit `(double)` cast makes the result
  // type unambiguous at every call site. Complex inputs are admitted
  // through small runtime helpers that expand componentwise (numbl
  // semantics):
  //   isnan(z)    true iff EITHER creal(z) or cimag(z) is NaN
  //   isinf(z)    true iff EITHER lane is infinite
  //   isfinite(z) true iff BOTH lanes are finite
  // A helper (rather than an inline expansion) keeps a single
  // evaluation of the operand: an argument that's itself a Call
  // (e.g. `isnan(csqrt(z))`) would otherwise be evaluated twice in
  // the rendered C — the parameter binding inside the helper does
  // the hoisting for us.
  // `logical(x)` is the numeric→logical coercion: nonzero → 1.0,
  // else 0.0. Matches numbl's `toBool` (`x !== 0`), so NaN and ±Inf
  // both round to 1.0 (NaN ≠ 0 is true in IEEE 754). Numbl rejects
  // `logical` on a complex argument, so we do too.
  {
    name: "isnan",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    result: () => scalarDouble("nonnegative"),
    emit: (args, argTys, state) => {
      if (anyComplex(argTys)) {
        state.useRuntime("mtoc_isnan_complex");
        return `mtoc_isnan_complex(${args[0]})`;
      }
      return `((double)(isnan(${args[0]}) ? 1 : 0))`;
    },
  },
  {
    name: "isinf",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    result: () => scalarDouble("nonnegative"),
    emit: (args, argTys, state) => {
      if (anyComplex(argTys)) {
        state.useRuntime("mtoc_isinf_complex");
        return `mtoc_isinf_complex(${args[0]})`;
      }
      return `((double)(isinf(${args[0]}) ? 1 : 0))`;
    },
  },
  {
    name: "isfinite",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    result: () => scalarDouble("nonnegative"),
    emit: (args, argTys, state) => {
      if (anyComplex(argTys)) {
        state.useRuntime("mtoc_isfinite_complex");
        return `mtoc_isfinite_complex(${args[0]})`;
      }
      return `((double)(isfinite(${args[0]}) ? 1 : 0))`;
    },
  },
  {
    name: "logical",
    category: "expr",
    params: scalarParams(1),
    result: () => scalarDouble("nonnegative"),
    emit: args => `(((${args[0]}) != 0.0) ? 1.0 : 0.0)`,
  },

  // ── 1-arg libm — real-or-complex propagating ─────────────────────────
  // For builtins with a complex sibling, the real-side domain check
  // (e.g. `sqrt` requires `nonnegative`) only fires on real inputs.
  // Complex `csqrt` / `clog` / `clog2` / `clog10` are total, so the
  // numeric-value-domain question is moot there.
  libm("sqrt", 1, "sqrt", "nonnegative", ["nonnegative"], {
    complexCName: "csqrt",
    // `sqrt` of a real arg whose sign we can't prove nonnegative
    // promotes to `csqrt` and a complex result, matching numbl's
    // `realFn → NaN → complexFn` fallback. The numeric-domain check
    // doesn't fire for opted-in builtins; see `validateDomain`.
    promoteOnDomainMiss: true,
  }),
  libm("exp", 1, "exp", "positive", [], { complexCName: "cexp" }),
  libm("log", 1, "log", "unknown", ["nonnegative"], { complexCName: "clog" }),
  libm("sin", 1, "sin", "unknown", [], { complexCName: "csin" }),
  libm("cos", 1, "cos", "unknown", [], { complexCName: "ccos" }),
  libm("tan", 1, "tan", "unknown", [], { complexCName: "ctan" }),
  libm("asin", 1, "asin", "unknown", [], { complexCName: "casin" }),
  libm("acos", 1, "acos", "unknown", [], { complexCName: "cacos" }),
  libm("atan", 1, "atan", "unknown", [], { complexCName: "catan" }),
  libm("sinh", 1, "sinh", "unknown", [], { complexCName: "csinh" }),
  libm("cosh", 1, "cosh", "positive", [], { complexCName: "ccosh" }),
  libm("tanh", 1, "tanh", "unknown", [], { complexCName: "ctanh" }),

  // ── 1-arg libm — `cabs` returns a real scalar ────────────────────────
  libm("abs", 1, "fabs", "nonnegative", [], {
    complexCName: "cabs",
    complexResult: "real",
    complexResultSign: "nonnegative",
  }),

  // ── 1-arg runtime — wrappers around libm with extra logic ────────────
  // C99 lacks `clog2`/`clog10`/`clog1p`/`cexpm1`; the runtime helpers
  // express them via `clog(z) / log(2)` etc. so complex `log2(z)` /
  // `log10(z)` / `log1p(z)` / `expm1(z)` work in mtoc identically to
  // numbl. Real inputs go straight to libm.
  runtime("log2", 1, "log2", "unknown", ["nonnegative"], {
    complexHelperName: "mtoc_clog2",
    realIsLibm: true,
  }),
  runtime("log10", 1, "log10", "unknown", ["nonnegative"], {
    complexHelperName: "mtoc_clog10",
    realIsLibm: true,
  }),
  runtime("expm1", 1, "expm1", "unknown", [], {
    complexHelperName: "mtoc_cexpm1",
    realIsLibm: true,
  }),
  // log1p's true domain is x >= -1, but the sign lattice can't represent
  // bounded intervals — `nonnegative` is the closest expressible bound.
  runtime("log1p", 1, "log1p", "unknown", ["nonnegative"], {
    complexHelperName: "mtoc_clog1p",
    realIsLibm: true,
  }),

  // ── Complex-only / dispatched: real / imag / conj / angle ────────────
  // `real(z)` / `imag(z)` / `angle(z)` always return real scalars;
  // `conj(z)` returns whatever its input was (complex stays complex).
  // Real inputs are also valid for all four — `real(x) == x`, etc.
  {
    name: "real",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    // real(x) = x for real x — preserve sign. For complex, sign-unknown.
    result: argTys => {
      const a = argTys[0];
      if (isNumeric(a) && !a.isComplex) return scalarDouble(a.sign);
      return scalarDouble("unknown");
    },
    emit: (args, argTys) =>
      anyComplex(argTys) ? `creal(${args[0]})` : args[0],
  },
  {
    name: "imag",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    // imag(real) is provably 0; imag(complex) is sign-unknown.
    result: argTys =>
      anyComplex(argTys) ? scalarDouble("unknown") : scalarDouble("zero"),
    emit: (args, argTys) => (anyComplex(argTys) ? `cimag(${args[0]})` : "0.0"),
  },
  {
    name: "conj",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    // conj(x) = x for real x; preserve sign. conj(z) for complex stays
    // complex (sign is forced "unknown" by the type-system invariant).
    result: argTys => {
      if (anyComplex(argTys)) return scalarComplex();
      const a = argTys[0];
      return isNumeric(a) ? scalarDouble(a.sign) : scalarDouble();
    },
    emit: (args, argTys) => (anyComplex(argTys) ? `conj(${args[0]})` : args[0]),
  },
  {
    name: "angle",
    category: "expr",
    params: scalarParams(1, [], "real-or-complex"),
    result: () => scalarDouble("unknown"),
    emit: (args, argTys, state) => {
      if (anyComplex(argTys)) return `carg(${args[0]})`;
      // Real-input angle: numbl returns 0 for nonneg, π for negative.
      // Wrap in a runtime helper so the NaN/sign branch doesn't have
      // to be inlined per call site.
      state.useRuntime("mtoc_angle_real");
      return `mtoc_angle_real(${args[0]})`;
    },
  },

  // `complex(...)` — the only path in numbl from a real-typed value to
  // a complex-typed one. 1-arg `complex(a)` promotes real → complex
  // (imag plane = 0); a complex `a` passes through unchanged. 2-arg
  // `complex(a, b)` builds `a + b*i`; numbl rejects a complex arg in
  // the 2-arg form (its `apply` calls `isRuntimeNumber` which is
  // false for complex), so we do too. Scalar and tensor inputs both
  // work — tensor inputs ride the standard elementwise lift, with
  // shape from `arithResult` broadcast. See `lowerComplexCtor` below.
  {
    name: "complex",
    category: "expr",
    params: [],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "internal: 'complex' must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: lowerComplexCtor,
  },

  // ── 1-arg runtime — `sign` propagates complexity ─────────────────────
  // For complex `z`, numbl returns `z / |z|` (with a 0-result branch).
  runtime("sign", 1, "mtoc_sign", "unknown", [], {
    complexHelperName: "mtoc_sign_complex",
  }),

  // ── 2-arg libm ───────────────────────────────────────────────────────
  // `rem(a,b)` matches C's fmod (truncate-toward-zero) and stays real-only.
  libm("rem", 2, "fmod", "unknown"),
  libm("atan2", 2, "atan2", "unknown"),
  libm("hypot", 2, "hypot", "nonnegative"),
  libm("power", 2, "pow", "unknown"),

  // ── `min`/`max` — overloaded across arity ───────────────────────────
  // The default 2-arg sigs handle elementwise `min(a, b)` / `max(a, b)`
  // (real → libm `fmin`/`fmax`; complex → `mtoc_min_complex` /
  // `mtoc_max_complex`; mixed real-complex promotes to complex). The
  // `lowerExpr` hook intercepts the 1-arg form and synthesizes a
  // reduction sig (vector-like input → scalar result via `_all` helper;
  // matrix input → tensor result via `_default` helper). 2-arg calls
  // fall through to the elementwise path; 3-arg `(v, [], dim)` is
  // deferred (requires empty-tensor-literal support — see Phase B).
  {
    ...runtime("min", 2, "fmin", "unknown", [], {
      complexHelperName: "mtoc_min_complex",
      realIsLibm: true,
    }),
    lowerExpr: oneArgReductionLowerExpr("min", MIN_REDUCTION, s => s),
  },
  {
    ...runtime("max", 2, "fmax", "unknown", [], {
      complexHelperName: "mtoc_max_complex",
      realIsLibm: true,
    }),
    lowerExpr: oneArgReductionLowerExpr("max", MAX_REDUCTION, s => s),
  },

  // ── 2-arg runtime ────────────────────────────────────────────────────
  // `mod(a,b)` follows MATLAB convention (sign of result follows divisor).
  // Real-only by numbl semantics.
  runtime("mod", 2, "mtoc_mod", "unknown"),

  // ── Tensor reductions / introspection ────────────────────────────────
  // `sum` accepts any numeric value:
  //   - scalar           → identity (the value, unchanged).
  //   - vector-like      → scalar result via `mtoc_sum` (real) or
  //                        `mtoc_sum_complex` (complex). "Vector-like"
  //                        means at most one non-singleton axis.
  //   - statically a matrix (≥2 axes are `notOne`) → tensor result via
  //                        `mtoc_sum_default` (real) or `_complex_default`.
  //   - statically ambiguous shape → rejected at lowering with a clear
  //                        diagnostic (deferred until explicit-dim or
  //                        runtime-shape dispatch lands).
  // The result sign tracks the input's sign — summing nonneg elements
  // stays nonneg, etc. The default-path entries below are unreachable;
  // every call routes through `lowerExpr`.
  {
    name: "sum",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: "double",
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "codegen internal: sum must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: oneArgReductionLowerExpr("sum", SUM_REDUCTION, s => s),
  },

  // `length` and `numel` accept any non-scalar tensor and return a
  // nonneg scalar (the count includes 0 for an empty tensor). They
  // also override `lowerExpr` to fold over a string handle (always 1
  // per numbl semantics) and a char-array (CharLit folds to its
  // static length; a `Var` reads `.cols` off the runtime struct via
  // a synthetic single-use builtin sig). Other arg shapes fall
  // through to the default `reduceTensor` path, which validates
  // shape: "tensor" and routes through `mtoc_length` / `mtoc_numel`.
  {
    ...reduceTensor("length", "mtoc_length", "nonnegative"),
    lowerExpr: lengthLikeLowerExpr("length"),
  },
  {
    ...reduceTensor("numel", "mtoc_numel", "nonnegative"),
    lowerExpr: lengthLikeLowerExpr("numel"),
  },

  // ── Shape builtins (size, ndims, reshape) ─────────────────────────────
  //
  // These accept any value (scalar through N-D tensor) and produce
  // either a scalar (`ndims`, `size(A, dim)`) or a fresh tensor
  // (`size(A)`, `reshape`). They are the only path today by which a
  // numbl program can construct a tensor with `ndim > 2`.
  //
  // Scalar inputs are constant-folded at lowering: `size(s)` →
  // `[1 1]`, `ndims(s)` → `2`. Char arrays / strings are
  // currently rejected (numbl returns `[1 N]` / `2` for those; the
  // path is open but unused by the test scripts mtoc has).
  {
    name: "size",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    // Default 1-arg path: produces a 1×N row vector via runtime helper.
    result: () => rowVecDouble("nonnegative"),
    emit: (args, _argTys, state) => {
      state.useRuntime("mtoc_size_vec");
      return `mtoc_size_vec(${args[0]})`;
    },
    lowerExpr: sizeLowerExpr,
    producesOwnedDirectly: true,
  },
  {
    name: "ndims",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
    ],
    result: () => scalarDouble("positive"),
    emit: (args, argTys) => {
      // Scalar input folds at lowering; reaching here means a tensor.
      // ndims(t) = max(2, t.ndim) — matching numbl.
      if (argTys.length !== 1 || !isNumeric(argTys[0])) {
        throw new Error(`codegen internal: ndims expects one numeric arg`);
      }
      return `(double)(${args[0]}.ndim > 2 ? ${args[0]}.ndim : 2)`;
    },
    lowerExpr: ndimsLowerExpr,
  },
  {
    name: "reshape",
    category: "expr",
    // Placeholder one-arg shape — `lowerExpr` intercepts and builds a
    // call with the actual arity. The default emit path is never used.
    params: [
      {
        shape: "tensor",
        domain: null,
        elem: "double",
        complexDomain: "real-or-complex",
      },
    ],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "codegen internal: reshape must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: reshapeLowerExpr,
    producesOwnedDirectly: true,
  },

  // ── Tensor constructors (zeros, ones, nan, inf, eye) ──────────────────
  //
  // All variadic over scalar real dim args:
  //   - 0 args → scalar (zeros() → 0, ones()/eye() → 1, nan() → NaN,
  //              inf() → +Inf), folded at lowering.
  //   - 1 arg N → 2-D N×N (numbl's "square" convention).
  //   - 2+ args → N-D tensor with the given shape (eye is 2-D-only
  //               and rejects N > 2).
  //
  // Dim arg validation (NaN, non-integer, etc.) is left to numbl
  // compatibility: mtoc passes whatever the user wrote, so an invalid
  // dim leads to a runtime trap inside the helper or a buffer of
  // garbage. The happy path (positive integer dims) matches numbl
  // byte-for-byte.
  variadicTensorCtor("zeros", "mtoc_zeros_nd", 0, "zero"),
  variadicTensorCtor("ones", "mtoc_ones_nd", 1, "positive"),
  variadicTensorCtor("nan", "mtoc_nan_nd", NaN, "unknown"),
  variadicTensorCtor("NaN", "mtoc_nan_nd", NaN, "unknown"),
  variadicTensorCtor("inf", "mtoc_inf_nd", Infinity, "positive"),
  variadicTensorCtor("Inf", "mtoc_inf_nd", Infinity, "positive"),
  {
    name: "eye",
    category: "expr",
    params: [],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "codegen internal: eye must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: eyeLowerExpr,
  },

  // ── PRNG (rng, rand, randn) ───────────────────────────────────────────
  //
  // mtoc reproduces numbl's seeded RNG (xoshiro128** + splitmix32) so
  // a program that calls `rng(seed)` before `rand` / `randn` gets
  // byte-identical output from numbl and mtoc. Without a `rng()` call
  // mtoc seeds with 0 (numbl falls back to `Math.random()`); the two
  // are NOT compatible in that case.
  //
  // `rng(seed)` is a side-effecting call returning Void; mtoc accepts
  // it at the statement position via `ExprStmt(Call(rng, seed))`.
  {
    name: "rng",
    category: "expr",
    params: [
      {
        shape: "scalar",
        domain: null,
        elem: "double",
        complexDomain: "real-only",
      },
    ],
    result: () => ({ kind: "Void" }),
    emit: (argStrs, _argTys, state) => {
      state.useRuntime("mtoc_rng");
      return `mtoc_rng_seed(${argStrs[0]})`;
    },
  },
  {
    name: "rand",
    category: "expr",
    params: [],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "codegen internal: rand must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: (_ctx, args, span) =>
      randLowerExpr(
        "rand",
        "mtoc_rng_random",
        "mtoc_rand_nd",
        "nonnegative",
        args,
        span
      ),
  },
  {
    name: "randn",
    category: "expr",
    params: [],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        "codegen internal: randn must be lowered through its lowerExpr hook"
      );
    },
    lowerExpr: (_ctx, args, span) =>
      randLowerExpr(
        "randn",
        "mtoc_rng_randn",
        "mtoc_randn_nd",
        "unknown",
        args,
        span
      ),
  },

  // ── tic / toc ─────────────────────────────────────────────────────────
  //
  // numbl semantics (numbl/src/numbl-core/interpreter/builtins/time-system.ts
  // and runtime/specialBuiltins.ts):
  //   - `tic` records `performance.now()` into a static and returns the
  //     same value (seconds since the monotonic origin). Statement form
  //     discards the return.
  //   - `toc` (0 args) returns elapsed since the last tic. When invoked
  //     at statement position (nargout=0) it ALSO prints
  //     `Elapsed time is X.XXXXXX seconds.` — at expression position
  //     (`t = toc;` / `disp(toc)`) it just returns the value silently.
  //   - `toc(h)` uses the handle returned by `tic` as the start; same
  //     print-on-statement-position rule applies.
  //
  // mtoc mirrors this by registering two helper variants per form
  // (value-returning and print-side-effect) and routing the statement
  // case through a `lowerStmt` hook that swaps the value-returning
  // emit for the print one. The two forms share `mtoc_tic` (the
  // runtime snippet defines all entry points together).
  {
    name: "tic",
    category: "expr",
    params: [],
    result: () => scalarDouble("nonnegative"),
    emit: (_args, _argTys, state) => {
      state.useRuntime("mtoc_tic");
      return `mtoc_tic()`;
    },
  },
  {
    name: "toc",
    category: "expr",
    params: [],
    result: () => scalarDouble("nonnegative"),
    emit: () => {
      throw new Error(
        "codegen internal: toc must be lowered through its lowerExpr / lowerStmt hook"
      );
    },
    lowerExpr: (_ctx, args, span) => tocLowerExpr(args, span),
    lowerStmt: (ctx, args, span) => tocLowerStmt(ctx, args, span),
  },
];

/** Expression-position lowering for `toc` / `toc(h)`. Synthesizes a
 *  one-shot `BuiltinSig` whose emit renders `mtoc_toc()` (no-arg) or
 *  `mtoc_toc_h(h)` (handle form). Both return a real-scalar elapsed
 *  in seconds without printing. */
function tocLowerExpr(args: ReadonlyArray<IRExpr>, span: Span): IRExpr | null {
  if (args.length > 1) {
    throw new UnsupportedConstruct(
      `toc takes 0 or 1 arguments (got ${args.length})`,
      span
    );
  }
  if (args.length === 1) {
    const h = args[0];
    if (!isScalarReal(h.ty)) {
      throw new UnsupportedConstruct(
        `toc(handle) requires a real scalar (got ${typeToString(h.ty)})`,
        span
      );
    }
    const sig: BuiltinSig = {
      name: "toc",
      category: "expr",
      params: [
        {
          shape: "scalar",
          domain: null,
          elem: "double",
          complexDomain: "real-only",
        },
      ],
      result: () => scalarDouble("nonnegative"),
      emit: (argStrs, _argTys, state) => {
        state.useRuntime("mtoc_tic");
        return `mtoc_toc_h(${argStrs[0]})`;
      },
    };
    return {
      kind: "Call",
      name: "toc",
      callee: { kind: "builtin", sig },
      args: [h],
      ty: scalarDouble("nonnegative"),
      span,
    };
  }
  const sig: BuiltinSig = {
    name: "toc",
    category: "expr",
    params: [],
    result: () => scalarDouble("nonnegative"),
    emit: (_argStrs, _argTys, state) => {
      state.useRuntime("mtoc_tic");
      return `mtoc_toc()`;
    },
  };
  return {
    kind: "Call",
    name: "toc",
    callee: { kind: "builtin", sig },
    args: [],
    ty: scalarDouble("nonnegative"),
    span,
  };
}

/** Statement-position lowering for `toc;` / `toc(h);`. numbl prints
 *  `Elapsed time is X.XXXXXX seconds.` when toc is invoked at stmt
 *  position; mtoc routes the same shape through a void-returning
 *  runtime helper (`mtoc_toc_print` / `mtoc_toc_print_h`) so codegen
 *  emits a clean `(void)(mtoc_toc_print(...));` at the call site. */
function tocLowerStmt(
  ctx: BuiltinLowerCtx,
  args: ReadonlyArray<Expr>,
  span: Span
): IRStmt | null {
  if (args.length > 1) {
    throw new UnsupportedConstruct(
      `toc takes 0 or 1 arguments (got ${args.length})`,
      span
    );
  }
  if (args.length === 1) {
    const h = ctx.lowerExpr(args[0]);
    if (!isScalarReal(h.ty)) {
      throw new UnsupportedConstruct(
        `toc(handle) requires a real scalar (got ${typeToString(h.ty)})`,
        args[0].span
      );
    }
    const sig: BuiltinSig = {
      name: "toc",
      category: "expr",
      params: [
        {
          shape: "scalar",
          domain: null,
          elem: "double",
          complexDomain: "real-only",
        },
      ],
      result: () => ({ kind: "Void" }),
      emit: (argStrs, _argTys, state) => {
        state.useRuntime("mtoc_tic");
        return `mtoc_toc_print_h(${argStrs[0]})`;
      },
    };
    return {
      kind: "ExprStmt",
      expr: {
        kind: "Call",
        name: "toc",
        callee: { kind: "builtin", sig },
        args: [h],
        ty: { kind: "Void" },
        span,
      },
      span,
    };
  }
  const sig: BuiltinSig = {
    name: "toc",
    category: "expr",
    params: [],
    result: () => ({ kind: "Void" }),
    emit: (_argStrs, _argTys, state) => {
      state.useRuntime("mtoc_tic");
      return `mtoc_toc_print()`;
    },
  };
  return {
    kind: "ExprStmt",
    expr: {
      kind: "Call",
      name: "toc",
      callee: { kind: "builtin", sig },
      args: [],
      ty: { kind: "Void" },
      span,
    },
    span,
  };
}

/** Build a `lowerExpr` hook for a 1-arg tensor reduction that dispatches
 *  on the static shape of its argument:
 *
 *  - **Scalar input**     → return the arg unchanged (identity fold,
 *                           matching numbl's `min(x) === x` /
 *                           `sum(x) === x` for runtime numbers).
 *  - **Vector-like input** (≤1 axis is not statically `one`) → emit a
 *                           call to the `_all` helper; result type is
 *                           `scalarDouble` / `scalarComplex`.
 *  - **Matrix input** (≥2 axes are `notOne`, with no `unknown` mixed in)
 *                         → emit a call to the `_default` helper; result
 *                           type is computed by collapsing the first
 *                           `notOne` axis to `one` and trailing-stripping.
 *  - **Statically ambiguous** (≥2 non-`one` axes with at least one
 *                              `unknown`) → reject at lowering. The user
 *                              can `reshape` to a known shape or wait
 *                              for the explicit-dim form.
 *
 *  When the call's arity isn't 1, returns `null` to defer to the default
 *  sig — for `min`/`max` that means falling through to the 2-arg
 *  elementwise path; for `sum` the default sig is throw-only, so a
 *  non-1 arity will raise the registry's standard "expects 1 argument(s),
 *  got N" message via the default validation. */
function oneArgReductionLowerExpr(
  name: string,
  helpers: ReductionHelpers,
  signFromArg: (s: Sign) => Sign
): BuiltinLowerExpr {
  return (_ctx, args, span) => {
    if (args.length !== 1) return null;
    const arg = args[0];
    if (!isNumeric(arg.ty)) {
      throw new UnsupportedConstruct(
        `${name}: argument must be numeric (got ${typeToString(arg.ty)})`,
        span
      );
    }
    if (arg.ty.elem !== "double") {
      throw new UnsupportedConstruct(
        `${name}: char-array argument is not yet supported`,
        span
      );
    }
    if (isScalar(arg.ty)) {
      // numbl's `sum(x) === x`, `min(x) === x`, `max(x) === x` for a
      // scalar `x`. Skip the call entirely — the arg's value flows up.
      return arg;
    }
    const isComplex = arg.ty.isComplex;
    const argSign: Sign = arg.ty.sign;
    const resultSign: Sign = signFromArg(argSign);
    const nonOneAxes = arg.ty.dims.filter(d => !dimIsOne(d));
    if (nonOneAxes.length <= 1) {
      // Result is a scalar regardless of the runtime sizes of the
      // unknown / notOne axis (sum of N elements → scalar; min/max of
      // N elements → scalar). Use the `_all` helper.
      const variant = isComplex ? helpers.complexAll : helpers.realAll;
      const resultTy = isComplex ? scalarComplex() : scalarDouble(resultSign);
      const sig: BuiltinSig = {
        name,
        category: "expr",
        params: [
          {
            shape: "tensor",
            domain: null,
            elem: "double",
            complexDomain: "real-or-complex",
          },
        ],
        result: () => resultTy,
        emit: (argStrs, _argTys, state) => {
          state.useRuntime(variant.runtimeKey);
          return `${variant.cName}(${argStrs[0]})`;
        },
      };
      return {
        kind: "Call",
        name,
        callee: { kind: "builtin", sig },
        args,
        ty: resultTy,
        span,
      };
    }
    // ≥2 non-`one` axes. We need every non-`one` axis to be definitely
    // `notOne` (not `unknown`) to pick the result kind statically. With
    // an `unknown` mixed in, the input could be a vector (collapsing
    // to a scalar) or a matrix (giving a tensor) at runtime — the
    // static return type can't unify those two shapes.
    const hasUnknown = arg.ty.dims.some(d => d.kind === "unknown");
    if (hasUnknown) {
      throw new UnsupportedConstruct(
        `${name}: input shape ${typeToString(arg.ty)} is statically ` +
          `ambiguous (it might be a vector or a matrix at runtime, which ` +
          `produce a scalar vs tensor result respectively); reshape to ` +
          `a known shape first, or pass an explicit dim argument once ` +
          `that form is supported`,
        span
      );
    }
    // Statically a matrix (every non-`one` axis is `notOne`). Compute
    // the result shape: collapse the first `notOne` axis to `one`,
    // leave the rest. `numericTypeND` does the trailing-singleton strip.
    const resultDims: DimInfo[] = arg.ty.dims.slice();
    let firstNotOne = -1;
    for (let i = 0; i < resultDims.length; i++) {
      if (resultDims[i].kind === "notOne") {
        firstNotOne = i;
        break;
      }
    }
    if (firstNotOne === -1) {
      throw new Error(
        `internal: ${name}: expected ≥1 notOne axis after passing the ` +
          `nonOneAxes.length >= 2 + no-unknown checks`
      );
    }
    resultDims[firstNotOne] = { kind: "one" };
    const resultTy: NumericType = numericTypeND(
      resultDims,
      isComplex,
      resultSign
    );
    const variant = isComplex ? helpers.complexDefault : helpers.realDefault;
    const sig: BuiltinSig = {
      name,
      category: "expr",
      params: [
        {
          shape: "tensor",
          domain: null,
          elem: "double",
          complexDomain: "real-or-complex",
        },
      ],
      result: () => resultTy,
      emit: (argStrs, _argTys, state) => {
        state.useRuntime(variant.runtimeKey);
        return `${variant.cName}(${argStrs[0]})`;
      },
      producesOwnedDirectly: true,
    };
    return {
      kind: "Call",
      name,
      callee: { kind: "builtin", sig },
      args,
      ty: resultTy,
      span,
    };
  };
}

function lengthLikeLowerExpr(name: string): BuiltinLowerExpr {
  return (_ctx, args, span) => {
    if (args.length !== 1) return null;
    const arg = args[0];
    if (isString(arg.ty)) {
      return {
        kind: "NumLit",
        value: 1,
        ty: scalarDouble("positive"),
        span,
      };
    }
    if (isCharArray(arg.ty)) {
      if (arg.kind === "CharLit") {
        return {
          kind: "NumLit",
          value: arg.value.length,
          ty: scalarDouble("positive"),
          span,
        };
      }
      if (arg.kind === "Var") {
        // Synthesize a one-shot BuiltinSig whose emit closure renders
        // the `<v>.cols` struct-field access. No runtime helper needed
        // — `cols` is always present on `mtoc_char_tensor_t`.
        const charLenSig: BuiltinSig = {
          name,
          category: "expr",
          params: [
            {
              shape: "tensor",
              domain: null,
              elem: null,
              complexDomain: "real-or-complex",
            },
          ],
          result: () => scalarDouble("nonnegative"),
          emit: argStrs => `${argStrs[0]}.cols`,
        };
        return {
          kind: "Call",
          name,
          callee: { kind: "builtin", sig: charLenSig },
          args: [arg],
          ty: scalarDouble("nonnegative"),
          span,
        };
      }
      throw new UnsupportedConstruct(
        `${name} on a char-array expression is not yet supported ` +
          `(assign the char to a variable first)`,
        span
      );
    }
    return null;
  };
}

/** Expression-position lowering for `size(...)`. Handles both
 *  `size(A)` (returns row vector of dim sizes) and `size(A, dim)`
 *  (returns scalar). Scalar arg folds: `size(s)` → `[1 1]`,
 *  `size(s, _)` → `1`. */
function sizeLowerExpr(
  _ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length === 0 || args.length > 2) {
    throw new UnsupportedConstruct(
      `size(...) takes 1 or 2 args (got ${args.length})`,
      span
    );
  }
  const a = args[0];
  if (!isNumeric(a.ty)) {
    throw new UnsupportedConstruct(
      `size(${typeToString(a.ty)}) is not yet supported ` +
        `(only numeric values today)`,
      span
    );
  }
  // 1-arg form
  if (args.length === 1) {
    if (isScalar(a.ty)) {
      // size(scalar) → [1 1] — fold to a tensor literal.
      const one: IRExpr = {
        kind: "NumLit",
        value: 1,
        ty: scalarDouble("positive"),
        span,
      };
      return {
        kind: "TensorLit",
        elements: [[one, one]],
        ty: rowVecDouble("positive"),
        span,
      };
    }
    // Tensor input: defer to the default Call path (which uses
    // mtoc_size_vec).
    return null;
  }
  // 2-arg form: size(A, dim). dim must be a real scalar.
  const dim = args[1];
  if (!isScalarReal(dim.ty)) {
    throw new UnsupportedConstruct(
      `size(_, dim) requires a real scalar dim (got ` +
        `${typeToString(dim.ty)})`,
      span
    );
  }
  // Scalar tensor: size(s, _) is always 1.
  if (isScalar(a.ty)) {
    return {
      kind: "NumLit",
      value: 1,
      ty: scalarDouble("positive"),
      span,
    };
  }
  // Synthesize a one-shot 2-arg sig for codegen.
  const sig: BuiltinSig = {
    name: "size",
    category: "expr",
    params: [
      {
        shape: "any",
        domain: null,
        elem: null,
        complexDomain: "real-or-complex",
      },
      {
        shape: "scalar",
        domain: null,
        elem: "double",
        complexDomain: "real-only",
      },
    ],
    result: () => scalarDouble("nonnegative"),
    emit: (argStrs, _argTys, state) => {
      state.useRuntime("mtoc_size_dim");
      return `mtoc_size_dim(${argStrs[0]}, ${argStrs[1]})`;
    },
    // 2-arg `size(t, dim)` returns a scalar; no producesOwnedDirectly.
  };
  return {
    kind: "Call",
    name: "size",
    callee: { kind: "builtin", sig },
    args: [a, dim],
    ty: scalarDouble("nonnegative"),
    span,
  };
}

/** Expression-position lowering for `ndims(A)`. Scalar / 2-D inputs
 *  fold to a NumLit(2); higher-D tensors defer to the default Call
 *  path so codegen can emit `max(2, t.ndim)` at runtime. */
function ndimsLowerExpr(
  _ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length !== 1) {
    throw new UnsupportedConstruct(
      `ndims(...) takes exactly 1 arg (got ${args.length})`,
      span
    );
  }
  const a = args[0];
  if (!isNumeric(a.ty)) {
    throw new UnsupportedConstruct(
      `ndims(${typeToString(a.ty)}) is not yet supported`,
      span
    );
  }
  // Static ndim is `a.ty.dims.length` (always ≥ 2). If it's exactly 2
  // we can fold; if it's > 2 we know ndim statically too and could
  // fold, but a runtime read keeps the emitted C readable.
  if (a.ty.dims.length === 2) {
    return {
      kind: "NumLit",
      value: 2,
      ty: scalarDouble("positive"),
      span,
    };
  }
  return null;
}

/** Expression-position lowering for `reshape(A, d1, d2, ...)`. Takes
 *  N >= 2 dim args and emits a runtime call to `mtoc_tensor_reshape`
 *  (or its complex sibling). The result type carries
 *  `dims = [unknown, unknown, ...]` of length N, normalized (trailing
 *  ones above index 1 stripped) by `numericTypeND`. */
function reshapeLowerExpr(
  _ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length < 3) {
    throw new UnsupportedConstruct(
      `reshape(...) requires at least 3 args ` +
        `(tensor + at least 2 dim sizes, got ${args.length})`,
      span
    );
  }
  const a = args[0];
  if (!isNumeric(a.ty) || a.ty.elem !== "double") {
    throw new UnsupportedConstruct(
      `reshape: first arg must be a double-elem tensor ` +
        `(got ${typeToString(a.ty)})`,
      span
    );
  }
  if (!isMultiElement(a.ty)) {
    throw new UnsupportedConstruct(
      `reshape: first arg must be a multi-element tensor today ` +
        `(scalar reshape is not yet implemented)`,
      span
    );
  }
  const dimArgs = args.slice(1);
  for (let i = 0; i < dimArgs.length; i++) {
    if (!isScalarReal(dimArgs[i].ty)) {
      throw new UnsupportedConstruct(
        `reshape: dim arg #${i + 1} must be a real scalar ` +
          `(got ${typeToString(dimArgs[i].ty)})`,
        span
      );
    }
  }
  const ndim = dimArgs.length;
  if (ndim > MTOC_MAX_NDIM) {
    throw new UnsupportedConstruct(
      `reshape: requested ${ndim} dimensions, but mtoc tensors are ` +
        `limited to ${MTOC_MAX_NDIM} (MTOC_MAX_NDIM in runtime/tensor.h). ` +
        `Raise the cap and rebuild if you genuinely need higher-dimensional ` +
        `tensors.`,
      span
    );
  }
  // Refine the result-dim lattice when the dim arg is a positive-int
  // NumLit: literal `1` → `one`, literal integer > 1 → `notOne`, else
  // `unknown`. Lets downstream lowering (sum/min/max reductions on a
  // statically-known matrix; codegen elementwise on a known N-D shape)
  // see useful shape info when the user passes constant dims.
  const resultDims: DimInfo[] = [];
  for (let i = 0; i < ndim; i++) {
    const d = dimArgs[i];
    if (d.kind === "NumLit" && Number.isInteger(d.value) && d.value >= 1) {
      resultDims.push(d.value === 1 ? { kind: "one" } : { kind: "notOne" });
    } else {
      resultDims.push({ kind: "unknown" });
    }
  }
  const isComplex = a.ty.isComplex;
  const resultTy = numericTypeND(resultDims, isComplex, "unknown");
  const helper = isComplex
    ? "mtoc_tensor_reshape_complex"
    : "mtoc_tensor_reshape";
  const params: ParamConstraint[] = [
    {
      shape: "tensor",
      domain: null,
      elem: "double",
      complexDomain: "real-or-complex",
    },
    ...dimArgs.map(
      (): ParamConstraint => ({
        shape: "scalar",
        domain: null,
        elem: "double",
        complexDomain: "real-only",
      })
    ),
  ];
  const sig: BuiltinSig = {
    name: "reshape",
    category: "expr",
    params,
    result: () => resultTy,
    emit: (argStrs, _argTys, state) => {
      state.useRuntime(helper);
      const dimsList = argStrs
        .slice(1)
        .map(s => `(long)(${s})`)
        .join(", ");
      return `${helper}(${argStrs[0]}, ${ndim}, (long[]){${dimsList}})`;
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name: "reshape",
    callee: { kind: "builtin", sig },
    args: [...args],
    ty: resultTy,
    span,
  };
}

/** Factory for variadic tensor constructors with the shape API
 *  `f()` / `f(N)` / `f(d1, d2, …, dN)`:
 *   - 0 args folds to a scalar literal with the given fill value.
 *   - 1 arg N folds to a 2-D N×N call (square convention).
 *   - 2+ args emits a call to `mtoc_<helper>_nd(ndim, dims)`.
 *  Used for `zeros`, `ones`, `nan`/`NaN`, `inf`/`Inf`. */
function variadicTensorCtor(
  name: string,
  ndHelper: string,
  scalarValue: number,
  scalarSign: Sign
): BuiltinSig {
  return {
    name,
    category: "expr",
    params: [],
    result: () => ({ kind: "Unknown" }),
    emit: () => {
      throw new Error(
        `codegen internal: ${name} must be lowered through its lowerExpr hook`
      );
    },
    lowerExpr: (_ctx, args, span) =>
      lowerVariadicTensorCtor(
        name,
        ndHelper,
        scalarValue,
        scalarSign,
        args,
        span
      ),
  };
}

function lowerVariadicTensorCtor(
  name: string,
  ndHelper: string,
  scalarValue: number,
  scalarSign: Sign,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr {
  for (let i = 0; i < args.length; i++) {
    if (!isScalarReal(args[i].ty)) {
      throw new UnsupportedConstruct(
        `${name}: dim arg #${i + 1} must be a real scalar ` +
          `(got ${typeToString(args[i].ty)})`,
        span
      );
    }
  }
  if (args.length === 0) {
    // Scalar fold: `zeros()` → 0, `ones()` → 1, `nan()` → NaN, etc.
    return {
      kind: "NumLit",
      value: scalarValue,
      ty: scalarDouble(scalarSign),
      span,
    };
  }
  // 1-arg form means N×N; 2+ means N-D with the given shape.
  const ndim = args.length === 1 ? 2 : args.length;
  const dimArgs = args.length === 1 ? [args[0], args[0]] : args;
  const resultDims: DimInfo[] = [];
  for (let i = 0; i < ndim; i++) resultDims.push({ kind: "unknown" });
  const resultTy = numericTypeND(resultDims, false, scalarSign);
  const params: ParamConstraint[] = args.map(
    (): ParamConstraint => ({
      shape: "scalar",
      domain: null,
      elem: "double",
      complexDomain: "real-only",
    })
  );
  const sig: BuiltinSig = {
    name,
    category: "expr",
    params,
    result: () => resultTy,
    emit: (argStrs, _argTys, state) => {
      state.useRuntime(ndHelper);
      // For the 1-arg form, duplicate the user-supplied dim — codegen
      // can't share the resulting `(long)(...)` cast across both slots
      // without a stash, so the dim expression is rendered twice.
      // numbl's dim args are constrained to scalar real, and any
      // tensor-typed sub-expr would have been ANF-hoisted out of the
      // call's args, so this duplication has no nontrivial side
      // effects (just a redundant `(long)(<scalar>)`).
      const dimExprs = args.length === 1 ? [argStrs[0], argStrs[0]] : argStrs;
      const dimsList = dimExprs.map(s => `(long)(${s})`).join(", ");
      return `${ndHelper}(${ndim}, (long[]){${dimsList}})`;
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name,
    callee: { kind: "builtin", sig },
    args: [...dimArgs],
    ty: resultTy,
    span,
  };
}

/** Expression-position lowering for `complex(...)`. 1-arg form
 *  promotes a real value to complex (and passes a complex value
 *  through unchanged); 2-arg form `complex(a, b)` builds `a + b*i`
 *  and rejects complex args (numbl semantics). Tensor inputs ride
 *  the standard elementwise lift via a synthesized scalar-emit
 *  BuiltinSig: the codegen iter-loop allocates a complex result
 *  tensor at the broadcast shape and stamps the per-slot expression
 *  `(a + 0*I)` (1-arg) or `(a + b*I)` (2-arg) into each cell. */
function lowerComplexCtor(
  _ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length < 1 || args.length > 2) {
    throw new UnsupportedConstruct(
      `'complex' takes 1 or 2 arguments (got ${args.length})`,
      span
    );
  }
  for (let i = 0; i < args.length; i++) {
    if (!isNumeric(args[i].ty)) {
      throw new UnsupportedConstruct(
        `'complex' requires numeric arguments ` +
          `(got ${typeToString(args[i].ty)})`,
        args[i].span ?? span
      );
    }
  }
  // 1-arg passthrough: complex(z) where z is already complex returns z
  // (assignment / disp do the deep copy where needed).
  if (args.length === 1 && (args[0].ty as NumericType).isComplex) {
    return args[0];
  }
  // 2-arg: numbl rejects a complex arg in either slot.
  if (args.length === 2) {
    for (let i = 0; i < 2; i++) {
      if ((args[i].ty as NumericType).isComplex) {
        throw new UnsupportedConstruct(
          `'complex' requires real arguments in the 2-arg form ` +
            `(got ${typeToString(args[i].ty)})`,
          args[i].span ?? span
        );
      }
    }
  }
  // Result type: complex with the broadcast shape of the args. Reuse
  // `arithResult` for the 2-arg broadcast (Add is sign/elem-preserving
  // so the dims it produces are what we want).
  let resultTy: NumericType;
  if (args.length === 1) {
    const a = args[0].ty as NumericType;
    resultTy = numericTypeND(a.dims, true, "unknown", a.elem);
  } else {
    const broadcasted = arithResult("Add", args[0].ty, args[1].ty);
    if (!isNumeric(broadcasted)) {
      throw new UnsupportedConstruct(
        `'complex': cannot broadcast arguments with incompatible shapes ` +
          `(${typeToString(args[0].ty)}, ${typeToString(args[1].ty)})`,
        span
      );
    }
    resultTy = numericTypeND(broadcasted.dims, true, "unknown", "double");
  }
  const params: ParamConstraint[] = args.map(() => ({
    shape: "scalar" as const,
    domain: null,
    elem: "double" as const,
    complexDomain: "real-only" as const,
  }));
  const emit: BuiltinEmit =
    args.length === 1
      ? argStrs => `((${argStrs[0]}) + 0.0 * I)`
      : argStrs => `((${argStrs[0]}) + (${argStrs[1]}) * I)`;
  const sig: BuiltinSig = {
    name: "complex",
    category: "expr",
    params,
    result: () => resultTy,
    emit,
  };
  return {
    kind: "Call",
    name: "complex",
    callee: { kind: "builtin", sig },
    args: [...args],
    ty: resultTy,
    span,
  };
}

/** Expression-position lowering for `eye(...)`. `eye()` folds to
 *  the scalar literal 1, `eye(n)` lowers as `eye(n, n)`, `eye(n, m)`
 *  emits `mtoc_eye_2d(n, m)`. Rejects 3+ args — N-D identity has no
 *  natural meaning. */
function eyeLowerExpr(
  _ctx: BuiltinLowerCtx,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length > 2) {
    throw new UnsupportedConstruct(
      `eye(...) takes 0, 1, or 2 args (got ${args.length})`,
      span
    );
  }
  for (let i = 0; i < args.length; i++) {
    if (!isScalarReal(args[i].ty)) {
      throw new UnsupportedConstruct(
        `eye: dim arg #${i + 1} must be a real scalar ` +
          `(got ${typeToString(args[i].ty)})`,
        span
      );
    }
  }
  if (args.length === 0) {
    return {
      kind: "NumLit",
      value: 1,
      ty: scalarDouble("positive"),
      span,
    };
  }
  const dimArgs = args.length === 1 ? [args[0], args[0]] : args;
  const resultTy = numericTypeND(
    [{ kind: "unknown" }, { kind: "unknown" }],
    false,
    "nonnegative"
  );
  const params: ParamConstraint[] = args.map(
    (): ParamConstraint => ({
      shape: "scalar",
      domain: null,
      elem: "double",
      complexDomain: "real-only",
    })
  );
  const sig: BuiltinSig = {
    name: "eye",
    category: "expr",
    params,
    result: () => resultTy,
    emit: (argStrs, _argTys, state) => {
      state.useRuntime("mtoc_eye_2d");
      const rStr = argStrs[0];
      const cStr = args.length === 1 ? argStrs[0] : argStrs[1];
      return `mtoc_eye_2d((long)(${rStr}), (long)(${cStr}))`;
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name: "eye",
    callee: { kind: "builtin", sig },
    args: [...dimArgs],
    ty: resultTy,
    span,
  };
}

/** Expression-position lowering for `rand` / `randn`. The 0-arg form
 *  emits the scalar runtime helper (a single PRNG draw); the
 *  variadic forms allocate an N-D tensor and loop-fill with PRNG
 *  draws. The 1-arg form `rand(N)` is lowered as `rand(N, N)` per
 *  numbl's square convention. */
function randLowerExpr(
  name: string,
  scalarHelper: string,
  ndHelper: string,
  scalarSign: Sign,
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  for (let i = 0; i < args.length; i++) {
    if (!isScalarReal(args[i].ty)) {
      throw new UnsupportedConstruct(
        `${name}: dim arg #${i + 1} must be a real scalar ` +
          `(got ${typeToString(args[i].ty)})`,
        span
      );
    }
  }
  if (args.length === 0) {
    // Scalar draw: emit a Call that renders to `<scalarHelper>()`.
    const sig: BuiltinSig = {
      name,
      category: "expr",
      params: [],
      result: () => scalarDouble(scalarSign),
      emit: (_argStrs, _argTys, state) => {
        state.useRuntime("mtoc_rng");
        return `${scalarHelper}()`;
      },
    };
    return {
      kind: "Call",
      name,
      callee: { kind: "builtin", sig },
      args: [],
      ty: scalarDouble(scalarSign),
      span,
    };
  }
  const ndim = args.length === 1 ? 2 : args.length;
  const dimArgs = args.length === 1 ? [args[0], args[0]] : args;
  const resultDims: DimInfo[] = [];
  for (let i = 0; i < ndim; i++) resultDims.push({ kind: "unknown" });
  const resultTy = numericTypeND(resultDims, false, scalarSign);
  const params: ParamConstraint[] = args.map(
    (): ParamConstraint => ({
      shape: "scalar",
      domain: null,
      elem: "double",
      complexDomain: "real-only",
    })
  );
  const sig: BuiltinSig = {
    name,
    category: "expr",
    params,
    result: () => resultTy,
    emit: (argStrs, _argTys, state) => {
      state.useRuntime(ndHelper);
      const dimExprs = args.length === 1 ? [argStrs[0], argStrs[0]] : argStrs;
      const dimsList = dimExprs.map(s => `(long)(${s})`).join(", ");
      return `${ndHelper}(${ndim}, (long[]){${dimsList}})`;
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name,
    callee: { kind: "builtin", sig },
    args: [...dimArgs],
    ty: resultTy,
    span,
  };
}

// ── fprintf / sprintf helpers ──────────────────────────────────────────
//
// Format engine is shared with the C runtime (`runtime/format_engine.h`);
// the lowering split is:
//   - `fprintf` builds an `IRStmt.Fprintf` with the resolved format
//     and value-args. The codegen renders one `mtoc_fprintf` call
//     wrapping a C99 compound-literal `mtoc_fprintf_arg_t[]`.
//   - `sprintf` synthesizes a fresh one-shot `BuiltinSig` (mirroring
//     `variadicTensorCtor`'s pattern) whose `emit` renders the same
//     compound-literal form against `mtoc_sprintf_str` /
//     `mtoc_sprintf_char` (chosen on the format's static text type).
//     `producesOwnedDirectly: true` so ANF hoists the call out of
//     nested positions into its own Assign.

/** Lower a `fprintf(...)` statement. Validates the format string and
 *  value args, resolves the optional leading numeric `fid`, and
 *  returns an `IRStmt.Fprintf`. */
function fprintfLowerStmt(
  ctx: BuiltinLowerCtx,
  args: ReadonlyArray<Expr>,
  span: Span
): IRStmt | null {
  if (args.length === 0) {
    throw new UnsupportedConstruct(
      `'fprintf' requires at least 1 argument (format string)`,
      span
    );
  }
  const lowered = args.map(a => ctx.lowerExpr(a));
  let fmtIdx = 0;
  // numbl's `fprintf` resolves the optional fid as "first arg is
  // numeric AND there are ≥ 2 args". mtoc keeps the same rule but
  // restricts the fid to a literal 1 or 2 — both route to stdout.
  if (lowered.length >= 2 && isScalarReal(lowered[0].ty)) {
    const fid = lowered[0];
    if (fid.kind !== "NumLit" || (fid.value !== 1 && fid.value !== 2)) {
      throw new UnsupportedConstruct(
        `'fprintf' with a file descriptor other than 1 or 2 is not yet ` +
          `supported (file I/O is deferred); use fid=1 (stdout) or ` +
          `fid=2 (numbl routes both to stdout)`,
        args[0].span
      );
    }
    fmtIdx = 1;
  }
  const fmt = lowered[fmtIdx];
  validateFormatArg("fprintf", fmt, args[fmtIdx].span);
  const valArgs = lowered.slice(fmtIdx + 1);
  for (let i = 0; i < valArgs.length; i++) {
    validateFprintfValueArg(
      "fprintf",
      valArgs[i],
      i + 1,
      args[fmtIdx + 1 + i].span
    );
  }
  return { kind: "Fprintf", fmt, args: valArgs, span };
}

/** Lower a `sprintf(...)` expression. Validates the format string and
 *  value args, then synthesizes a one-shot `BuiltinSig` whose `emit`
 *  closure renders `mtoc_sprintf_str(...)` or `mtoc_sprintf_char(...)`
 *  depending on the format arg's static text type. */
function sprintfLowerExpr(
  args: ReadonlyArray<IRExpr>,
  span: Span
): IRExpr | null {
  if (args.length === 0) {
    throw new UnsupportedConstruct(
      `'sprintf' requires at least 1 argument (format string)`,
      span
    );
  }
  const fmt = args[0];
  validateFormatArg("sprintf", fmt, fmt.span);
  const valArgs = args.slice(1);
  for (let i = 0; i < valArgs.length; i++) {
    validateFprintfValueArg("sprintf", valArgs[i], i + 1, valArgs[i].span);
  }
  // Format-arg type drives the result type. A scalar char format
  // (`sprintf('hello')` with a 1-char literal) is still text and
  // produces a char-array result (numbl's `RuntimeChar` doesn't
  // distinguish length; mtoc's static type does, so we widen the
  // scalar-char case here to char-array).
  const fmtTy = fmt.ty;
  const isStrFormat = isString(fmtTy);
  const resultTy: MType = isStrFormat
    ? STRING
    : charArrayType({ kind: "notOne" });
  const helperName = isStrFormat ? "mtoc_sprintf_str" : "mtoc_sprintf_char";
  const params: ParamConstraint[] = args.map(
    (): ParamConstraint => ({
      shape: "any",
      domain: null,
      elem: null,
      complexDomain: "real-or-complex",
    })
  );
  const sig: BuiltinSig = {
    name: "sprintf",
    category: "expr",
    params,
    result: () => resultTy,
    emit: (argStrs, argTys, state) => {
      // The runtime helper umbrella registration; deps pull in the
      // format engine, text view, string + char-tensor structs, and
      // complex formatter.
      state.useRuntime("mtoc_sprintf");
      state.useRuntime("mtoc_text_view_t");
      state.useRuntime("mtoc_format_engine");
      const fmtTyHere = argTys[0];
      const fmtView = isString(fmtTyHere)
        ? `mtoc_text_from_string(${argStrs[0]})`
        : `mtoc_text_from_char_tensor(${argStrs[0]})`;
      const nVal = argTys.length - 1;
      if (nVal === 0) {
        return (
          `${helperName}(${fmtView}, 0, ` + `(const mtoc_fprintf_arg_t *)0)`
        );
      }
      const initList: string[] = [];
      for (let i = 1; i < argTys.length; i++) {
        initList.push(renderFprintfArgInit(state, argTys[i], argStrs[i]));
      }
      return (
        `${helperName}(${fmtView}, ${nVal}, ` +
        `(mtoc_fprintf_arg_t[]){${initList.join(", ")}})`
      );
    },
    producesOwnedDirectly: true,
  };
  return {
    kind: "Call",
    name: "sprintf",
    callee: { kind: "builtin", sig },
    args: [...args],
    ty: resultTy,
    span,
  };
}

/** Reject ill-typed format-string args. The format must be text
 *  (string or char array) OR a scalar char (we route the latter
 *  through a synthetic 1-byte text view at codegen time). The ANF
 *  pass hoists any non-Var multi-element / owned-producer format
 *  expression into a synthetic Assign so codegen sees a Var or
 *  literal. */
function validateFormatArg(name: string, fmt: IRExpr, span: Span): void {
  if (!isText(fmt.ty) && !isCharScalar(fmt.ty)) {
    throw new UnsupportedConstruct(
      `'${name}' format must be a string or char value ` +
        `(got ${typeToString(fmt.ty)})`,
      span
    );
  }
}

/** Reject ill-typed value args to fprintf/sprintf. Accepts numeric
 *  scalars (real / complex / char) and multi-element numeric tensors
 *  (real or complex, including N-D), and text values (string or
 *  char array) which route through %s as a single value. Owned
 *  producers in arg position must be ANF-hoistable. */
function validateFprintfValueArg(
  name: string,
  e: IRExpr,
  position: number,
  span: Span
): void {
  const ty = e.ty;
  const okText = isText(ty);
  const okNumeric =
    isNumeric(ty) &&
    (isScalarReal(ty) ||
      isScalarComplex(ty) ||
      isCharScalar(ty) ||
      (isMultiElement(ty) && ty.elem === "double"));
  if (!okText && !okNumeric) {
    throw new UnsupportedConstruct(
      `'${name}' argument ${position} has unsupported type ${typeToString(ty)}`,
      span
    );
  }
  if (isHigherDim(ty)) {
    // N-D tensors are supported by the engine (it walks .ndim/.dims
    // for the flatten count); the lowering accepts them too.
    void position;
  }
  // The ANF pass hoists any non-Var multi-element / owned-producer
  // value arg into a synthetic Assign so codegen sees a Var or
  // literal at the call site.
  void e;
  void name;
}

/** Render a single fprintf / sprintf value arg as a `mtoc_fprintf_arg_t`
 *  designated-initializer expression. Single source of truth for the
 *  format-arg ABI; consumed by:
 *    - the `sprintf` one-shot builtin sig's emit closure (this file),
 *    - the `Fprintf` IRStmt codegen arm via emitAnalysis.formatArgInit.
 *  Dispatches on the arg's static type — text views go through the
 *  `mtoc_text_from_*` adapters; scalar numerics promote to double
 *  (scalar char widens via its code-unit value); complex scalars pass
 *  through; multi-element double tensors travel by pointer to the
 *  caller's predeclared `mtoc_tensor_t` local. `c` is the already-
 *  rendered C expression for the arg; `ty` is its IR type. */
export function renderFprintfArgInit(
  state: BuiltinEmitState,
  ty: MType,
  c: string
): string {
  state.useRuntime("mtoc_format_engine");
  if (isText(ty)) {
    state.useRuntime("mtoc_text_view_t");
    const view = isString(ty)
      ? `mtoc_text_from_string(${c})`
      : `mtoc_text_from_char_tensor(${c})`;
    return `{.kind=MTOC_FA_TEXT, .u.t=${view}}`;
  }
  if (isScalarComplex(ty)) {
    return `{.kind=MTOC_FA_COMPLEX, .u.z=${c}}`;
  }
  if (isCharScalar(ty)) {
    return `{.kind=MTOC_FA_DOUBLE, .u.d=(double)(unsigned char)(${c})}`;
  }
  if (isScalarReal(ty)) {
    return `{.kind=MTOC_FA_DOUBLE, .u.d=${c}}`;
  }
  if (isNumeric(ty) && isMultiElement(ty) && ty.elem === "double") {
    state.useRuntime("mtoc_tensor_t");
    return `{.kind=MTOC_FA_TENSOR, .u.tensor=&${c}}`;
  }
  throw new Error(
    `codegen internal: fprintf/sprintf arg with unsupported type ` +
      `${typeToString(ty)} reached renderFprintfArgInit (should have ` +
      `been rejected at lowering)`
  );
}

const BY_NAME = new Map<string, BuiltinSig>(BUILTINS.map(b => [b.name, b]));

/** Look up a builtin by MATLAB name; returns undefined if unknown. */
export function getBuiltin(name: string): BuiltinSig | undefined {
  return BY_NAME.get(name);
}

/** Names of every registered builtin, in registry-declaration order. */
export function allBuiltinNames(): readonly string[] {
  return BUILTINS.map(b => b.name);
}
