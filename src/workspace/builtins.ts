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

import {
  isNumeric,
  scalarComplex,
  scalarDouble,
  type MType,
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

/** 1-arg vector reduction (e.g. `sum(v)`). The result sign is derived
 *  from the argument's sign — summing nonneg elements is nonneg, etc. */
function reduceVector(
  name: string,
  helperName: string,
  signFromArg: (s: Sign) => Sign
): BuiltinSig {
  return {
    name,
    category: "expr",
    params: [
      {
        shape: "vector",
        domain: null,
        elem: "double",
        complexDomain: "real-only",
      },
    ],
    result: argTys => {
      const argTy = argTys[0];
      const argSign: Sign = isNumeric(argTy) ? argTy.sign : "unknown";
      return scalarDouble(signFromArg(argSign));
    },
    emit: (args, _argTys, state) => {
      state.useRuntime(helperName);
      return `${helperName}(${args.join(", ")})`;
    },
  };
}

/** 1-arg multi-element tensor reduction returning a scalar of fixed
 *  sign (e.g. `length`, `numel`). */
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
        complexDomain: "real-only",
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
  // `disp(x)` is special-cased at lowering: ExprStmt(disp(...)) routes
  // into `IRStmt.Disp` and codegen picks `mtoc_disp_double` vs
  // `mtoc_disp_tensor` at emit time. The registry entry exists so
  // `Workspace.resolve("disp")` returns from the same path as every
  // other builtin lookup; lowering rejects `disp(...)` at expression
  // position via `category === "stmt"`.
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
  reduceVector("sum", "mtoc_sum", s => s),

  // `length` and `numel` accept any non-scalar tensor and return a
  // nonneg scalar (the count includes 0 for an empty tensor).
  reduceTensor("length", "mtoc_length", "nonnegative"),
  reduceTensor("numel", "mtoc_numel", "nonnegative"),
];

const BY_NAME = new Map<string, BuiltinSig>(BUILTINS.map(b => [b.name, b]));

/** Look up a builtin by MATLAB name; returns undefined if unknown. */
export function getBuiltin(name: string): BuiltinSig | undefined {
  return BY_NAME.get(name);
}

/** Names of every registered builtin, in registry-declaration order. */
export function allBuiltinNames(): readonly string[] {
  return BUILTINS.map(b => b.name);
}
