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
 * The factories below (`libm`, `runtime`, `reduceVector`,
 * `reduceTensor`) keep the registry terse for the common cases.
 */

import type { Expr, Span } from "../parser/index.js";
import { UnsupportedConstruct } from "../lowering/errors.js";
import type { IRExpr, IRStmt } from "../lowering/ir.js";
import {
  isCharArray,
  isMultiElement,
  isNumeric,
  isScalarReal,
  isString,
  scalarComplex,
  scalarDouble,
  typeToString,
  type MType,
  type Sign,
} from "../lowering/types.js";
import { isOwnedProducer } from "../lowering/anf.js";

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
  } = complexOpts;
  const complexDomain: ComplexDomain = complexCName
    ? "real-or-complex"
    : "real-only";
  return {
    name,
    category: "expr",
    params: scalarParams(arity, domains, complexDomain),
    result: argTys => {
      if (complexCName && anyComplex(argTys)) {
        return complexResult === "propagates"
          ? scalarComplex()
          : scalarDouble(complexResultSign);
      }
      return scalarDouble(resultSign);
    },
    emit: (args, argTys) => {
      const target = complexCName && anyComplex(argTys) ? complexCName : cName;
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

interface ReduceVectorComplexOpts {
  /** When set, complex-vector inputs are admitted and dispatched to
   *  this runtime helper, which returns `double _Complex`. The result
   *  type tracks the input — real → real, complex → complex. */
  complexHelperName?: string;
}

/** 1-arg vector reduction (e.g. `sum(v)`). The result sign is derived
 *  from the argument's sign — summing nonneg elements is nonneg, etc.
 *  Optionally accepts a complex sibling helper for complex-vector
 *  inputs (`sum` over a complex vector returns a complex scalar). */
function reduceVector(
  name: string,
  helperName: string,
  signFromArg: (s: Sign) => Sign,
  complexOpts: ReduceVectorComplexOpts = {}
): BuiltinSig {
  const { complexHelperName } = complexOpts;
  const complexDomain: ComplexDomain = complexHelperName
    ? "real-or-complex"
    : "real-only";
  return {
    name,
    category: "expr",
    params: [
      {
        shape: "vector",
        domain: null,
        elem: "double",
        complexDomain,
      },
    ],
    result: argTys => {
      const argTy = argTys[0];
      if (complexHelperName && isNumeric(argTy) && argTy.isComplex) {
        return scalarComplex();
      }
      const argSign: Sign = isNumeric(argTy) ? argTy.sign : "unknown";
      return scalarDouble(signFromArg(argSign));
    },
    emit: (args, argTys, state) => {
      const useComplex = complexHelperName !== undefined && anyComplex(argTys);
      const target = useComplex ? complexHelperName! : helperName;
      state.useRuntime(target);
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

// ── Registry ────────────────────────────────────────────────────────────

const BUILTINS: BuiltinSig[] = [
  // ── Statement-only ───────────────────────────────────────────────────
  // `disp(x)` and `error(s)` own their statement lowering via
  // `lowerStmt`. The lowerer's `ExprStmt(name(...))` arm consults the
  // hook before the default expression-call path; it produces a
  // dedicated IR node (`IRStmt.Disp` / `IRStmt.Error`) that codegen
  // recognizes for kind-specific output (e.g. `mtoc_disp_double`,
  // `mtoc_disp_tensor`, `mtoc_error_string`). The expression-position
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
      // Codegen needs a named addressable handle (`Var`) or a non-owning
      // literal (`CharLit` / `StringLit`) to pass to the runtime disp
      // helper. Owned-producing expressions (TensorLit / IndexSlice /
      // user-func owned Call / string concat) are accepted here because
      // the post-lowering ANF pass hoists each one into its own
      // `_mtoc_anf_<N>` Assign, so codegen ultimately sees a `Var`.
      // Other multi-element expressions (Binary / Unary / elementwise
      // builtin Call on tensors) still reject — auto-materializing
      // those would need a separate pass.
      if (
        isMultiElement(arg.ty) &&
        arg.kind !== "Var" &&
        arg.kind !== "CharLit" &&
        !isOwnedProducer(arg)
      ) {
        throw new UnsupportedConstruct(
          `'disp' of a tensor expression is only supported for ` +
            `variable references; assign the value to a name first`,
          args[0].span
        );
      }
      if (
        isString(arg.ty) &&
        arg.kind !== "Var" &&
        arg.kind !== "StringLit" &&
        !isOwnedProducer(arg)
      ) {
        throw new UnsupportedConstruct(
          `'disp' of a string expression is only supported for string ` +
            `literals or variables; assign the value to a name first`,
          args[0].span
        );
      }
      return { kind: "Disp", arg, span };
    },
  },

  // `assert(cond)` — verify a scalar real condition at runtime.
  // numbl's `assert` throws on a falsy or NaN value; mtoc lowers it
  // to `IRStmt.Assert`, which codegen emits as a call into the
  // `mtoc_assert_double` runtime helper (prints "Assertion failed"
  // to stderr and exit(1)s on failure, no-op on success). The
  // 2-arg `assert(cond, msg)` and tensor-condition forms are
  // deferred — rejected at lowering with a span.
  {
    name: "assert",
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
          `'assert' currently requires a scalar real condition ` +
            `(got ${typeToString(cond.ty)})`,
          args[0].span
        );
      }
      let msg: IRExpr | null = null;
      if (args.length === 2) {
        msg = ctx.lowerExpr(args[1]);
        const isText = isString(msg.ty) || isCharArray(msg.ty);
        if (!isText) {
          throw new UnsupportedConstruct(
            `'assert' message must be a string or char array ` +
              `(got ${typeToString(msg.ty)})`,
            args[1].span
          );
        }
        const isStr = isString(msg.ty);
        const allowedKinds = isStr
          ? new Set(["Var", "StringLit"])
          : new Set(["Var", "CharLit"]);
        // Owned-producing msg expressions (e.g. string concat,
        // user-func string return) are admitted here because the
        // post-lowering ANF pass hoists them into their own
        // `_mtoc_anf_<N>` Assigns, leaving a `Var` for codegen.
        if (!allowedKinds.has(msg.kind) && !isOwnedProducer(msg)) {
          throw new UnsupportedConstruct(
            `'assert' message must be a literal or variable; ` +
              `assign the value to a name first`,
            args[1].span
          );
        }
      }
      return { kind: "Assert", cond, msg, span };
    },
  },

  // `error(s)` raises a numbl RuntimeError; codegen emits
  // `mtoc_error_string(arg);`. Today only the single-string-argument
  // form is accepted; `error(id, fmt, …)` shapes are deferred.
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
      if (!isString(arg.ty)) {
        throw new UnsupportedConstruct(
          `'error' currently requires a single string argument ` +
            `(got ${typeToString(arg.ty)})`,
          args[0].span
        );
      }
      // Owned-producing string args (concat / user-func string return)
      // are admitted here because the post-lowering ANF pass hoists
      // them into their own `_mtoc_anf_<N>` Assigns, so codegen sees a
      // `Var`.
      if (
        arg.kind !== "Var" &&
        arg.kind !== "StringLit" &&
        !isOwnedProducer(arg)
      ) {
        throw new UnsupportedConstruct(
          `'error' of a string expression is only supported for string ` +
            `literals or variables; assign the value to a name first`,
          args[0].span
        );
      }
      return { kind: "Error", arg, span };
    },
  },

  // ── 1-arg libm — real-only legacy ────────────────────────────────────
  // `mod`/`rem` are real-only by numbl semantics (their sign-of-divisor
  // / truncate-to-zero rules don't have a sensible complex extension).
  // `floor`/`ceil`/`round`/`fix` need a componentwise runtime helper
  // for complex; defining those as real-only here means complex inputs
  // are rejected with a clean message until that helper lands.
  libm("floor", 1, "floor", "unknown"),
  libm("ceil", 1, "ceil", "unknown"),
  libm("round", 1, "round", "unknown"),
  libm("fix", 1, "trunc", "unknown"),

  // ── String / char comparison ─────────────────────────────────────────
  // `strcmp(a, b)` returns 1.0 if the two text values match
  // byte-for-byte, 0.0 otherwise. Accepts (char-array, char-array),
  // (string, string), or any mix of the two — both arms get
  // normalized to a (data*, len) view inside their helper. Scalar
  // chars (bare `char`) are still rejected today since the test
  // corpus doesn't need them; numbl returns 0 for type-mismatched
  // inputs (e.g. number vs string), but we'd rather raise a span at
  // lowering than silently always-return-0.
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
      const aS = isString(argTys[0]);
      const bS = isString(argTys[1]);
      const aC = isCharArray(argTys[0]);
      const bC = isCharArray(argTys[1]);
      if (aS && bS) {
        state.useRuntime("mtoc_strcmp_string");
        return `mtoc_strcmp_string(${args[0]}, ${args[1]})`;
      }
      if (aC && bC) {
        state.useRuntime("mtoc_strcmp_char_tensor");
        return `mtoc_strcmp_char_tensor(${args[0]}, ${args[1]})`;
      }
      // Mixed char-array × string — promote the char-array view into
      // the string helper's (data, len, owned=0) shape inline.
      state.useRuntime("mtoc_strcmp_string");
      const aExpr = aS
        ? args[0]
        : `mtoc_string_from_literal(${args[0]}.data, ${args[0]}.cols)`;
      const bExpr = bS
        ? args[1]
        : `mtoc_string_from_literal(${args[1]}.data, ${args[1]}.cols)`;
      if (!aS) state.useRuntime("mtoc_string_from_literal");
      if (!bS) state.useRuntime("mtoc_string_from_literal");
      return `mtoc_strcmp_string(${aExpr}, ${bExpr})`;
    },
    lowerExpr: (_ctx, args, span) => {
      if (args.length !== 2) return null;
      const a = args[0].ty;
      const b = args[1].ty;
      const okA = isString(a) || isCharArray(a);
      const okB = isString(b) || isCharArray(b);
      if (!okA || !okB) {
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
  // type unambiguous at every call site. Real-only for now; numbl's
  // complex semantics (true if EITHER lane satisfies the predicate
  // for `isnan`/`isinf`, BOTH lanes for `isfinite`) needs a small
  // runtime helper that we'll add when complex coverage matters.
  // `logical(x)` is the numeric→logical coercion: nonzero → 1.0,
  // else 0.0. Matches numbl's `toBool` (`x !== 0`), so NaN and ±Inf
  // both round to 1.0 (NaN ≠ 0 is true in IEEE 754).
  {
    name: "isnan",
    category: "expr",
    params: scalarParams(1),
    result: () => scalarDouble("nonnegative"),
    emit: args => `((double)(isnan(${args[0]}) ? 1 : 0))`,
  },
  {
    name: "isinf",
    category: "expr",
    params: scalarParams(1),
    result: () => scalarDouble("nonnegative"),
    emit: args => `((double)(isinf(${args[0]}) ? 1 : 0))`,
  },
  {
    name: "isfinite",
    category: "expr",
    params: scalarParams(1),
    result: () => scalarDouble("nonnegative"),
    emit: args => `((double)(isfinite(${args[0]}) ? 1 : 0))`,
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
  }),
  libm("exp", 1, "exp", "positive", [], { complexCName: "cexp" }),
  libm("log", 1, "log", "unknown", ["positive"], { complexCName: "clog" }),
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
  runtime("log2", 1, "log2", "unknown", ["positive"], {
    complexHelperName: "mtoc_clog2",
    realIsLibm: true,
  }),
  runtime("log10", 1, "log10", "unknown", ["positive"], {
    complexHelperName: "mtoc_clog10",
    realIsLibm: true,
  }),
  runtime("expm1", 1, "expm1", "unknown", [], {
    complexHelperName: "mtoc_cexpm1",
    realIsLibm: true,
  }),
  runtime("log1p", 1, "log1p", "unknown", ["positive"], {
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

  // ── 2-arg runtime — `min`/`max` accept complex ───────────────────────
  // For real, libm `fmin`/`fmax` are correct. For complex, numbl orders
  // by magnitude with ties broken by angle — we wrap that in a runtime
  // helper. Mixing real and complex promotes the real to complex.
  runtime("min", 2, "fmin", "unknown", [], {
    complexHelperName: "mtoc_min_complex",
    realIsLibm: true,
  }),
  runtime("max", 2, "fmax", "unknown", [], {
    complexHelperName: "mtoc_max_complex",
    realIsLibm: true,
  }),

  // ── 2-arg runtime ────────────────────────────────────────────────────
  // `mod(a,b)` follows MATLAB convention (sign of result follows divisor).
  // Real-only by numbl semantics.
  runtime("mod", 2, "mtoc_mod", "unknown"),

  // ── Tensor reductions / introspection ────────────────────────────────
  // `sum` is restricted to vectors for now; matrix sums (which return a
  // row vector of column sums) need a tensor-returning builtin path
  // we'll add later. The result sign tracks the input's sign — sum of
  // nonneg elements is nonneg, sum of positive is positive, etc.
  reduceVector("sum", "mtoc_sum", s => s, {
    complexHelperName: "mtoc_sum_complex",
  }),

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
];

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

const BY_NAME = new Map<string, BuiltinSig>(BUILTINS.map(b => [b.name, b]));

/** Look up a builtin by MATLAB name; returns undefined if unknown. */
export function getBuiltin(name: string): BuiltinSig | undefined {
  return BY_NAME.get(name);
}

/** Names of every registered builtin, in registry-declaration order. */
export function allBuiltinNames(): readonly string[] {
  return BUILTINS.map(b => b.name);
}
