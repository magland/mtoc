/**
 * Scalar builtin registry.
 *
 * Each entry describes a MATLAB function we know how to translate to C.
 * For now they're all 1-arg real-scalar functions that map directly onto
 * a C function from <math.h>. A `domain` constraint guards translation:
 * `sqrt(x)` and `log(x)` only translate when the lowering pass can prove
 * the argument lies in the function's domain.
 *
 * The design point: emit an error at translate time (not at runtime) when
 * the domain isn't provably met. That's the static-codegen contract.
 */

import type { Sign } from "../lowering/types.js";

export type Domain = "nonnegative" | "positive" | null;

/** Per-argument shape constraint. Determines which inputs the lowerer
 *  accepts for each parameter of a builtin.
 *    - "scalar"  – only 1×1 inputs (today's default)
 *    - "vector"  – row vector or column vector (rejects scalar + matrix)
 *    - "tensor"  – any multi-element tensor (rejects scalar)
 */
export type ArgShape = "scalar" | "vector" | "tensor";

/**
 * The shape of the C value returned by a builtin call.
 *   - "scalar"  – plain `double`
 *   - "tensor"  – an `mtoc_tensor_t` (used by future tensor-returning
 *                 builtins; not exercised yet)
 *
 * Today every builtin is "scalar"; the field is here so adding new
 * tensor-returning ones doesn't require another field-shape change.
 */
export type ResultShape = "scalar";

/**
 * Builtin "category" — does this name appear at expression position
 * (a value-producing call like `sqrt(x)`) or only at statement position
 * (e.g. `disp(x)`, the future `error(...)`, `assert(...)`)?
 *
 * Defaults to `"expr"` when omitted so existing entries don't need
 * updating. Statement-only builtins are routed through their own
 * lowering path (today: `IRStmt.Disp`); the registry lookup just
 * provides the discovery + name.
 */
export type BuiltinCategory = "expr" | "stmt";

export interface ScalarBuiltin {
  /** MATLAB function name. */
  name: string;
  /** Whether this builtin is callable at expression position
   *  ("expr", default) or only as a statement ("stmt", e.g. `disp`).
   *  Statement-only entries route through a dedicated lowering path
   *  rather than producing an `IRExpr.Call`. */
  category?: BuiltinCategory;
  /** Number of arguments mtoc accepts for this builtin. */
  arity: 1 | 2;
  /** Per-argument shape constraint. Length matches `arity`. Defaults
   *  to all-scalar when omitted (every legacy entry keeps that). */
  argShapes?: ReadonlyArray<ArgShape>;
  /** Per-argument domain constraint. Length matches `arity`. */
  argDomains: ReadonlyArray<Domain>;
  /** Shape the result lowers to. */
  resultShape?: ResultShape;
  /** Sign known statically about the result. Conservative — refined
   *  later. The string `"preserve"` means "result sign equals arg 0's
   *  sign" (used for reductions like `sum` where summing nonneg
   *  elements is nonneg). */
  resultSign: Sign | "preserve";
  /**
   * C function the codegen emits. May be a libm name (e.g. "sqrt") or
   * a mtoc runtime helper (e.g. "mtoc_mod"); helpers in `runtime.ts`
   * are activated automatically when their name appears here.
   *
   * For statement-only entries whose codegen branches on argument
   * shape (today only `disp`, which picks `mtoc_disp_double` vs
   * `mtoc_disp_tensor` at emit time), this field is empty — codegen
   * special-cases the dispatch.
   */
  cFunc: string;
}

/** Returns the category, defaulting to "expr". */
export function categoryOf(b: ScalarBuiltin): BuiltinCategory {
  return b.category ?? "expr";
}

/** Returns the per-arg shape constraint, defaulting to "scalar" when
 *  the entry doesn't override it. */
export function argShapeOf(b: ScalarBuiltin, i: number): ArgShape {
  return b.argShapes?.[i] ?? "scalar";
}

const BUILTINS: ScalarBuiltin[] = [
  // ── Statement-only ───────────────────────────────────────────────────
  // `disp(x)` is special-cased at codegen: it picks `mtoc_disp_double`
  // for scalar args and `mtoc_disp_tensor` for tensor Vars (see
  // emit.ts → `IRStmt.Disp`). The registry entry exists so
  // `Workspace.resolve("disp")` returns from the same path as every
  // other builtin lookup; lowering still routes ExprStmt(disp(...))
  // into `IRStmt.Disp` rather than producing an `IRExpr.Call`.
  {
    name: "disp",
    category: "stmt",
    arity: 1,
    argShapes: ["scalar"], // Not actually enforced — see lowering of Disp.
    argDomains: [null],
    resultSign: "unknown",
    cFunc: "",
  },

  // ── 1-arg ────────────────────────────────────────────────────────────
  { name: "abs", arity: 1, argDomains: [null], resultSign: "nonnegative", cFunc: "fabs" },
  { name: "sqrt", arity: 1, argDomains: ["nonnegative"], resultSign: "nonnegative", cFunc: "sqrt" },
  { name: "exp", arity: 1, argDomains: [null], resultSign: "positive", cFunc: "exp" },
  { name: "log", arity: 1, argDomains: ["positive"], resultSign: "unknown", cFunc: "log" },
  { name: "log2", arity: 1, argDomains: ["positive"], resultSign: "unknown", cFunc: "log2" },
  { name: "log10", arity: 1, argDomains: ["positive"], resultSign: "unknown", cFunc: "log10" },
  { name: "sin", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "sin" },
  { name: "cos", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "cos" },
  { name: "tan", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "tan" },
  { name: "asin", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "asin" },
  { name: "acos", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "acos" },
  { name: "atan", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "atan" },
  { name: "sinh", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "sinh" },
  { name: "cosh", arity: 1, argDomains: [null], resultSign: "positive", cFunc: "cosh" },
  { name: "tanh", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "tanh" },
  { name: "floor", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "floor" },
  { name: "ceil", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "ceil" },
  { name: "round", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "round" },
  { name: "fix", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "trunc" },
  { name: "sign", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "mtoc_sign" },
  { name: "expm1", arity: 1, argDomains: [null], resultSign: "unknown", cFunc: "expm1" },
  { name: "log1p", arity: 1, argDomains: ["positive"], resultSign: "unknown", cFunc: "log1p" },

  // ── 2-arg ────────────────────────────────────────────────────────────
  // `rem(a,b)` matches C's fmod (truncate-toward-zero).
  { name: "rem", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "fmod" },
  // `mod(a,b)` follows MATLAB convention (sign of result follows divisor).
  { name: "mod", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "mtoc_mod" },
  { name: "min", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "fmin" },
  { name: "max", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "fmax" },
  { name: "atan2", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "atan2" },
  { name: "hypot", arity: 2, argDomains: [null, null], resultSign: "nonnegative", cFunc: "hypot" },
  { name: "power", arity: 2, argDomains: [null, null], resultSign: "unknown", cFunc: "pow" },

  // ── Tensor reductions / introspection ────────────────────────────────
  // sum / length / numel today accept a non-scalar tensor and return a
  // scalar. sum is restricted to vectors for now; matrix sums (which
  // return a row vector of column sums) need a tensor-returning builtin
  // path which we'll add later.
  {
    name: "sum",
    arity: 1,
    argShapes: ["vector"],
    argDomains: [null],
    // sum of nonneg elements is nonneg, sum of positive is positive,
    // etc. — propagate the input's sign to the result.
    resultSign: "preserve",
    cFunc: "mtoc_sum",
  },
  {
    name: "length",
    arity: 1,
    argShapes: ["tensor"],
    argDomains: [null],
    resultSign: "nonnegative",
    cFunc: "mtoc_length",
  },
  {
    name: "numel",
    arity: 1,
    argShapes: ["tensor"],
    argDomains: [null],
    resultSign: "nonnegative",
    cFunc: "mtoc_numel",
  },
];

const BY_NAME = new Map<string, ScalarBuiltin>(BUILTINS.map(b => [b.name, b]));

export function getScalarBuiltin(name: string): ScalarBuiltin | undefined {
  return BY_NAME.get(name);
}

export function allScalarBuiltinNames(): readonly string[] {
  return BUILTINS.map(b => b.name);
}
