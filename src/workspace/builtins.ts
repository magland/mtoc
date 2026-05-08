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

import { isNumeric, scalarDouble, type MType, type Sign } from "../lowering/types.js";

/** Sign-domain constraint on an argument. `null` means no constraint. */
export type Domain = "nonnegative" | "positive" | null;

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
   *  into a clear `TypeError` at the call site. */
  domain: Domain;
  /** Element-kind constraint. `null` means any. (Today only "double"
   *  exists; here for forward-compat with single/int/logical/char.) */
  elem: "double" | null;
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
 *  `argStrs` are already-emitted C expressions for each argument. */
export type BuiltinEmit = (
  argStrs: ReadonlyArray<string>,
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
  domains: ReadonlyArray<Domain> = []
): ParamConstraint[] {
  return Array.from({ length: arity }, (_, i) => ({
    shape: "scalar" as const,
    domain: domains[i] ?? null,
    elem: "double" as const,
  }));
}

/** Builtin that maps directly to a libm function (no runtime helper). */
function libm(
  name: string,
  arity: 1 | 2,
  cName: string,
  resultSign: Sign,
  domains: ReadonlyArray<Domain> = []
): BuiltinSig {
  return {
    name,
    category: "expr",
    params: scalarParams(arity, domains),
    result: () => scalarDouble(resultSign),
    emit: args => `${cName}(${args.join(", ")})`,
  };
}

/** Builtin that maps to a registered mtoc runtime helper. The helper
 *  is activated lazily when emit runs. */
function runtime(
  name: string,
  arity: 1 | 2,
  helperName: string,
  resultSign: Sign,
  domains: ReadonlyArray<Domain> = []
): BuiltinSig {
  return {
    name,
    category: "expr",
    params: scalarParams(arity, domains),
    result: () => scalarDouble(resultSign),
    emit: (args, state) => {
      state.useRuntime(helperName);
      return `${helperName}(${args.join(", ")})`;
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
    params: [{ shape: "vector", domain: null, elem: "double" }],
    result: argTys => {
      const argTy = argTys[0];
      const argSign: Sign = isNumeric(argTy) ? argTy.sign : "unknown";
      return scalarDouble(signFromArg(argSign));
    },
    emit: (args, state) => {
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
    params: [{ shape: "tensor", domain: null, elem: "double" }],
    result: () => scalarDouble(resultSign),
    emit: (args, state) => {
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
    params: [{ shape: "any", domain: null, elem: null }],
    result: () => ({ kind: "Void" }),
    emit: () => {
      throw new Error(
        "internal: BuiltinSig 'disp'.emit should not be called — disp lowers to IRStmt.Disp"
      );
    },
  },

  // ── 1-arg libm ───────────────────────────────────────────────────────
  libm("abs", 1, "fabs", "nonnegative"),
  libm("sqrt", 1, "sqrt", "nonnegative", ["nonnegative"]),
  libm("exp", 1, "exp", "positive"),
  libm("log", 1, "log", "unknown", ["positive"]),
  libm("log2", 1, "log2", "unknown", ["positive"]),
  libm("log10", 1, "log10", "unknown", ["positive"]),
  libm("sin", 1, "sin", "unknown"),
  libm("cos", 1, "cos", "unknown"),
  libm("tan", 1, "tan", "unknown"),
  libm("asin", 1, "asin", "unknown"),
  libm("acos", 1, "acos", "unknown"),
  libm("atan", 1, "atan", "unknown"),
  libm("sinh", 1, "sinh", "unknown"),
  libm("cosh", 1, "cosh", "positive"),
  libm("tanh", 1, "tanh", "unknown"),
  libm("floor", 1, "floor", "unknown"),
  libm("ceil", 1, "ceil", "unknown"),
  libm("round", 1, "round", "unknown"),
  libm("fix", 1, "trunc", "unknown"),
  libm("expm1", 1, "expm1", "unknown"),
  libm("log1p", 1, "log1p", "unknown", ["positive"]),

  // ── 1-arg runtime ────────────────────────────────────────────────────
  runtime("sign", 1, "mtoc_sign", "unknown"),

  // ── 2-arg libm ───────────────────────────────────────────────────────
  // `rem(a,b)` matches C's fmod (truncate-toward-zero).
  libm("rem", 2, "fmod", "unknown"),
  libm("min", 2, "fmin", "unknown"),
  libm("max", 2, "fmax", "unknown"),
  libm("atan2", 2, "atan2", "unknown"),
  libm("hypot", 2, "hypot", "nonnegative"),
  libm("power", 2, "pow", "unknown"),

  // ── 2-arg runtime ────────────────────────────────────────────────────
  // `mod(a,b)` follows MATLAB convention (sign of result follows divisor).
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
