/**
 * Lowering pass — AST (from parser) → typed IR.
 *
 * Walks the AST, infers types, and rejects any construct outside the
 * currently supported subset by raising `UnsupportedConstruct`.
 *
 * The `Lowerer` class owns the per-scope state (env / assignedVars /
 * params / output var). The bulk of the logic lives in focused
 * sibling files (`lowerIf.ts`, `lowerFor.ts`, `lowerWhile.ts`,
 * `lowerBinary.ts`, `lowerUnary.ts`, `lowerFuncCall.ts`,
 * `lowerTensorLiteral.ts`); each is a `this`-typed helper that
 * `lowerStmt` / `lowerExpr` dispatch to.
 *
 * Supported subset:
 *   - script body of plain assignments to scalar `double` variables
 *   - arithmetic / comparison / logical ops
 *   - if / elseif / else, while, for-with-range, break, continue
 *   - disp(expr), scalar math builtins (sqrt, abs, sin, …)
 *   - user-defined scalar functions with one output, specialized lazily
 *     on the (shape, elem) of the call-site argument types
 */

import type { AbstractSyntaxTree, Expr, Span, Stmt } from "../parser/index.js";
import { Workspace } from "../workspace/workspace.js";
import { getConstant } from "../workspace/constants.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type {
  IRExpr,
  IRFunction,
  IRProgram,
  IRStmt,
  VarBinding,
} from "./ir.js";
import {
  isMultiElement,
  isScalar,
  isScalarReal,
  isString,
  MType,
  scalarComplex,
  scalarDouble,
  signFromValue,
  STRING,
  typeToString,
  unify,
} from "./types.js";

import { lowerIf } from "./lowerIf.js";
import { lowerFor } from "./lowerFor.js";
import { lowerWhile } from "./lowerWhile.js";
import { lowerBinary } from "./lowerBinary.js";
import { lowerUnary } from "./lowerUnary.js";
import { lowerFuncCall } from "./lowerFuncCall.js";
import { lowerTensorLiteral } from "./lowerTensorLiteral.js";

// Reserved C identifiers that need mangling. Mirrors numbl's
// cJit/codegen.ts list. Centralized here so emit.ts never has to
// mangle a name itself.
const C_RESERVED: ReadonlySet<string> = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "main",
]);

/** Map a MATLAB identifier to the C identifier the codegen will emit.
 *  Reserved C keywords get a `v_` prefix; everything else passes
 *  through. Exported so helper files can reuse the same mapping. */
export function cNameFor(matlabName: string): string {
  return C_RESERVED.has(matlabName) ? `v_${matlabName}` : matlabName;
}

/** Defensive: reject any user MATLAB name starting with `_mtoc_`. The
 *  codegen synthesizes helpers with that prefix (e.g. `_mtoc_i`,
 *  `_mtoc_n`, `_mtoc_<name>_data`); a user var with the same prefix
 *  could shadow them. MATLAB syntax already disallows leading `_` so
 *  this is mostly belt-and-suspenders, but it's a clear error if a
 *  weird parser path lets one through. */
export function assertNotMtocReserved(name: string, span: Span): void {
  if (name.startsWith("_mtoc_")) {
    throw new UnsupportedConstruct(
      `identifier '${name}' starts with the reserved prefix '_mtoc_' ` +
        `(used by mtoc's generated C helpers)`,
      span
    );
  }
}

/** Module-level shared state: the function-specialization cache + ordered
 *  list, plus a stack of names currently being lowered (for cycle/recursion
 *  detection). Threaded into every `Lowerer` so script-scope and
 *  function-scope lowerers share specializations. */
export interface SharedSpecState {
  workspace: Workspace;
  /** name → IRFunction. Names are mangled (see `mangleSpecName`). */
  cache: Map<string, IRFunction>;
  /** Specializations in the order they were first registered. */
  order: IRFunction[];
  /** Mangled names currently being lowered, used to reject recursion. */
  inFlight: Set<string>;
}

export class Lowerer {
  /** Type lookup for in-scope identifiers. Includes params (function
   *  scope) and assigned vars (any scope). Helpers in sibling files
   *  read/write this directly. */
  env = new Map<string, MType>();
  /** Vars assigned inside the current scope. EXCLUDES params — they are
   *  declared via the C function signature, not predeclared. Keyed by
   *  the emitted C identifier — one entry per emitted C variable. A
   *  single MATLAB name can produce multiple entries when an
   *  incompatible reassignment is split into a fresh binding (see
   *  `recordAssignment`). */
  private assignedVars = new Map<string, VarBinding>();
  /** MATLAB name → current C identifier. Tracks both params and
   *  assigned vars; updated when an incompatible reassignment splits a
   *  variable. Reads of an Ident consult this so they see the current
   *  binding's cName. */
  private currentBindingCName = new Map<string, string>();
  /** Counter for the synthetic suffix used when splitting an
   *  incompatible reassignment. Per-scope so different functions don't
   *  share numbering. */
  private splitCounter = 0;
  /** Names of params for the current scope (function scope only). */
  private params: ReadonlySet<string>;
  /** Output variable for the current function scope, or null at script
   *  scope. Used to lower MATLAB `return` into `return <outputCName>;`. */
  private outputVar: string | null;
  /** Nesting depth inside control-flow constructs. Bumped by
   *  `lowerIf` / `lowerWhile` / `lowerFor` via `withControlDepth`.
   *  Splitting an incompatible reassignment is only allowed at depth
   *  0 — inside a branch or loop the merge would have to reconcile
   *  bindings across arms / iterations, which Phase 1 doesn't attempt. */
  controlDepth = 0;

  /** Function-specialization cache + workspace handle. Helpers in
   *  sibling files reach through this for user-call dispatch. */
  readonly shared: SharedSpecState;

  constructor(
    shared: SharedSpecState,
    paramBindings: Array<{ name: string; cName: string; ty: MType }> = [],
    outputVar: string | null = null
  ) {
    this.shared = shared;
    this.params = new Set(paramBindings.map(p => p.name));
    for (const p of paramBindings) {
      this.env.set(p.name, p.ty);
      this.currentBindingCName.set(p.name, p.cName);
    }
    this.outputVar = outputVar;
  }

  /** Run `fn` with `controlDepth` incremented; restored on exit. Used by
   *  the control-flow lowering helpers to mark "we're inside a branch
   *  or loop body" so an incompatible reassignment falls into the throw
   *  path rather than the split path. */
  withControlDepth<T>(fn: () => T): T {
    this.controlDepth++;
    try {
      return fn();
    } finally {
      this.controlDepth--;
    }
  }

  /** Current C identifier bound to `name` in this scope, falling back
   *  to the static cNameFor mapping when the name isn't tracked (e.g.
   *  a fresh assignment whose cName is being computed at the call
   *  site). Helpers lowering Ident reads / Return targets call this so
   *  references see the post-split cName. */
  currentCNameFor(name: string): string {
    return this.currentBindingCName.get(name) ?? cNameFor(name);
  }

  /** Determine whether `prev` and `next` can share a single predeclared
   *  C variable. The C representation is determined by category:
   *  scalar real (`double`), scalar complex (`double _Complex`), or
   *  multi-element (`mtoc_tensor_t`). Two types share storage only if
   *  they fall in the same category and agree on `isComplex` — codegen
   *  picks ONE C type per binding, and a real-tensor predecl can't
   *  hold a complex-tensor value. Specific size is no longer part of
   *  the type; tensor reassignments at the same coarse shape free and
   *  realloc the backing buffer at runtime. */
  private static canShareStorage(prev: MType, next: MType): boolean {
    // Two strings always share a single `mtoc_string_t` slot —
    // reassignment goes through `mtoc_string_assign` which frees the
    // prior buffer (or no-ops on a literal-pointing handle) and
    // installs the new one.
    if (prev.kind === "String" && next.kind === "String") return true;
    if (prev.kind !== "Numeric" || next.kind !== "Numeric") return false;
    if (prev.elem !== next.elem) return false;
    if (prev.isComplex !== next.isComplex) return false;
    const prevScalar = isScalar(prev);
    const nextScalar = isScalar(next);
    const prevMulti = isMultiElement(prev);
    const nextMulti = isMultiElement(next);
    // Both must classify into the same category. A type whose dims
    // include `unknown` may be neither scalar nor multi-element here;
    // such "could be either" types are forced to split (the C variable
    // would be ambiguous between `double` and `mtoc_tensor_t`).
    if (prevScalar && nextScalar) return true;
    if (prevMulti && nextMulti) return true;
    return false;
  }

  // ── Statements ────────────────────────────────────────────────────────

  lowerStmts(stmts: Stmt[]): IRStmt[] {
    const out: IRStmt[] = [];
    for (const s of stmts) {
      const lowered = this.lowerStmt(s);
      if (lowered) out.push(lowered);
    }
    return out;
  }

  getAssignedVars(): Map<string, VarBinding> {
    return this.assignedVars;
  }

  envLookup(name: string): MType | undefined {
    return this.env.get(name);
  }

  /** Record `<name> = <expr-of-type ty>` in the current scope and
   *  return the C identifier the lowered IR Assign should target.
   *
   *  Three cases:
   *  - Param reassignment — env updates, no `assignedVars` entry, returns
   *    the param's existing cName (params are declared via the function
   *    signature).
   *  - Compatible reassignment / first assignment — env updates,
   *    `assignedVars` updated under the existing cName (or a fresh one
   *    for the first write), returns that cName. After dim coarsening,
   *    a tensor variable that gets reassigned at a different runtime
   *    shape stays compatible (same coarse category) — codegen handles
   *    the shape change via a free + realloc at the assignment site.
   *  - Incompatible reassignment — the prev and new types can't live
   *    in a single C variable (different category, e.g. scalar↔tensor
   *    or real↔complex). At `controlDepth === 0` we split: a fresh
   *    cName is allocated and a new `assignedVars` entry created; the
   *    old binding stays for earlier reads. Inside control flow we
   *    throw — Phase 2 will lift that with liveness analysis. */
  recordAssignment(name: string, ty: MType, span: Span): string {
    assertNotMtocReserved(name, span);
    // env tracks the LATEST type at the current program point —
    // sequential assignment replaces, it does not unify with prior types.
    this.env.set(name, ty);

    if (this.params.has(name)) {
      // Params keep their fixed cName (declared by the C function
      // signature). Tensor params are owned by the callee under
      // copy-on-arg-pass — the caller wrapped the argument in
      // `mtoc_tensor_copy(...)`, so the body is free to reassign
      // through `mtoc_tensor_assign(&v, ...)` and the scope-exit free
      // releases the final buffer. Scalar params keep the same shape
      // they always had: assign-in-place at the param's C name.
      // Category-changing reassignments (scalar↔tensor, real↔complex)
      // remain a known gap and are not split today.
      return this.currentBindingCName.get(name) ?? cNameFor(name);
    }

    const prevCName = this.currentBindingCName.get(name);
    const prevBinding = prevCName
      ? this.assignedVars.get(prevCName)
      : undefined;

    if (!prevBinding) {
      // First assignment in this scope.
      const cName = cNameFor(name);
      this.assignedVars.set(cName, { ty, cName });
      this.currentBindingCName.set(name, cName);
      return cName;
    }

    const merged = unify(prevBinding.ty, ty);
    if (Lowerer.canShareStorage(prevBinding.ty, ty)) {
      // Compatible — widen the existing binding's type in place. The
      // merged type stays consistent with the predeclared C variable's
      // category (scalar/tensor, real/complex); shape-level coarsening
      // (e.g. notOne ∨ unknown → unknown) doesn't change the C type.
      this.assignedVars.set(prevBinding.cName, {
        ty: merged,
        cName: prevBinding.cName,
      });
      return prevBinding.cName;
    }

    // Incompatible. Either split (depth 0) or throw.
    if (this.controlDepth === 0) {
      this.splitCounter++;
      const splitCName = `_mtoc_${cNameFor(name)}__v${this.splitCounter}`;
      this.assignedVars.set(splitCName, { ty, cName: splitCName });
      this.currentBindingCName.set(name, splitCName);
      return splitCName;
    }

    // The merged-type Unknown branch and the category-mismatch branch
    // report different errors. `Unknown` from `unify` means an
    // incompatibility the type system can't bridge (different elem
    // kinds, etc.); the category-mismatch branch is for scalar↔tensor
    // and real↔complex changes, where the C representation differs.
    if (merged.kind === "Unknown") {
      throw new TypeError(
        `'${name}' was previously ${typeToString(prevBinding.ty)} and is now ` +
          `being reassigned to ${typeToString(ty)}; mtoc cannot represent ` +
          `both in one C variable. Use a different name for the new value, ` +
          `or hoist the reassignment outside the surrounding control-flow.`,
        span
      );
    }
    throw new UnsupportedConstruct(
      `'${name}' was previously ${typeToString(prevBinding.ty)} and is now ` +
        `being assigned ${typeToString(ty)}; mtoc requires a single C ` +
        `category (scalar/tensor, real/complex) for a variable inside ` +
        `control flow. Use a different name for the new value, or hoist the ` +
        `reassignment outside the surrounding if/while/for.`,
      span
    );
  }

  /**
   * Merge the post-arm envs of a control-flow construct into a single
   * env representing the program point after the construct.
   *
   * For each variable that appears in ANY arm's env, we unify its type
   * across every arm. If an arm doesn't have the variable, that arm
   * fell through without assigning it — the runtime sees the codegen-
   * predeclared default for that variable's category: `0.0` (sign zero)
   * for numeric, `mtoc_string_empty()` for string. We pick the absent
   * default to match: if every arm that *did* assign the variable made
   * it a string, the absent default is `STRING`; otherwise it's
   * `scalarDouble("zero")`. This keeps the merge well-typed for non-
   * numeric values while preserving the existing zero-default behavior
   * for numerics. Mixed-kind merges (some string, some numeric) still
   * fall through to the unify→Unknown error path below.
   *
   * Used for if/elseif/else and as the "ran-once-or-never" merge for
   * while/for loops. Single-pass: doesn't iterate to fixpoint, so loops
   * whose body's sign-flow oscillates may keep a sound but imprecise
   * post-loop type. (Sufficient for the scalar lattice we have today.)
   */
  mergeBranchEnvs(
    envs: ReadonlyArray<ReadonlyMap<string, MType>>,
    span: Span,
    construct: string
  ): Map<string, MType> {
    const result = new Map<string, MType>();
    const allKeys = new Set<string>();
    for (const e of envs) for (const k of e.keys()) allKeys.add(k);

    for (const k of allKeys) {
      const present: MType[] = [];
      for (const e of envs) {
        const t = e.get(k);
        if (t !== undefined) present.push(t);
      }
      const absentDefault: MType = present.every(isString)
        ? STRING
        : scalarDouble("zero");

      let unified: MType | undefined;
      for (const e of envs) {
        const t = e.get(k) ?? absentDefault;
        unified = unified ? unify(unified, t) : t;
      }
      if (unified?.kind === "Unknown") {
        // Different arms of the construct gave incompatible types for
        // this var. Report the distinct concrete types so the user can
        // see what conflicted.
        const distinct = [
          ...new Set(
            envs
              .map(e => e.get(k))
              .filter(
                (t): t is MType => t !== undefined && t.kind !== "Unknown"
              )
              .map(typeToString)
          ),
        ];
        throw new TypeError(
          `'${k}' is assigned incompatible types across the arms of this ` +
            `${construct}: ${distinct.join(" vs ")}.`,
          span
        );
      }
      if (unified) result.set(k, unified);
    }
    return result;
  }

  requireScalarReal(ty: MType, role: string, span: Span): void {
    if (!isScalarReal(ty)) {
      throw new UnsupportedConstruct(
        `${role} must be a real scalar (got ${typeToString(ty)})`,
        span
      );
    }
  }

  private lowerStmt(s: Stmt): IRStmt | null {
    switch (s.type) {
      case "Function":
        // Function declarations are pulled out of the script body before
        // statement-level lowering runs (see `lower()` below). Reaching
        // one here means it was nested somewhere we don't yet handle.
        throw new UnsupportedConstruct(
          `nested or non-top-level function definitions are not yet supported`,
          s.span
        );

      case "Assign": {
        const rhs = this.lowerExpr(s.expr);
        const cName = this.recordAssignment(s.name, rhs.ty, s.span);
        return {
          kind: "Assign",
          name: s.name,
          cName,
          rhs,
          ty: rhs.ty,
          span: s.span,
        };
      }

      case "ExprStmt": {
        // Special-case `disp(arg)` at statement level so codegen can emit
        // a direct call to the runtime helper instead of a value-bearing
        // call.
        if (
          s.expr.type === "FuncCall" &&
          s.expr.name === "disp" &&
          s.expr.args.length === 1
        ) {
          const arg = this.lowerExpr(s.expr.args[0]);
          // Codegen can only print scalars or named tensor variables; a
          // tensor expression has no addressable storage to hand to the
          // runtime helper, so reject it with a span before codegen.
          if (isMultiElement(arg.ty) && arg.kind !== "Var") {
            throw new UnsupportedConstruct(
              `'disp' of a tensor expression is only supported for ` +
                `variable references; assign the value to a name first`,
              s.expr.args[0].span
            );
          }
          // Same restriction for strings: a bare concat expression has
          // no named buffer to hand to the runtime helper, and the
          // owned result would leak. Allow `StringLit` (cheap, points
          // at .rodata) and `Var`; reject otherwise.
          if (
            isString(arg.ty) &&
            arg.kind !== "Var" &&
            arg.kind !== "StringLit"
          ) {
            throw new UnsupportedConstruct(
              `'disp' of a string expression is only supported for string ` +
                `literals or variables; assign the value to a name first`,
              s.expr.args[0].span
            );
          }
          return { kind: "Disp", arg, span: s.span };
        }
        // Special-case `error(arg)` at statement level. `error` is a
        // statement-only builtin that never returns; we lower it to a
        // dedicated IRStmt so codegen can emit a direct
        // `mtoc_error_string(arg);` call. Only single-arg string form
        // is supported today; numbl's `error(id, fmt, ...)` shapes are
        // deferred.
        if (
          s.expr.type === "FuncCall" &&
          s.expr.name === "error" &&
          s.expr.args.length === 1
        ) {
          const arg = this.lowerExpr(s.expr.args[0]);
          if (!isString(arg.ty)) {
            throw new UnsupportedConstruct(
              `'error' currently requires a single string argument ` +
                `(got ${typeToString(arg.ty)})`,
              s.expr.args[0].span
            );
          }
          if (arg.kind !== "Var" && arg.kind !== "StringLit") {
            throw new UnsupportedConstruct(
              `'error' of a string expression is only supported for string ` +
                `literals or variables; assign the value to a name first`,
              s.expr.args[0].span
            );
          }
          return { kind: "Error", arg, span: s.span };
        }
        const expr = this.lowerExpr(s.expr);
        // A bare tensor-valued expression at statement scope can't be
        // emitted today — there's no target buffer to write into. Reject
        // here so the user sees a span instead of a codegen stack trace.
        if (isMultiElement(expr.ty)) {
          throw new UnsupportedConstruct(
            `tensor-valued expression at statement scope is not yet ` +
              `supported (assign it to a variable first)`,
            s.span
          );
        }
        // String-valued bare expressions at statement scope have the
        // same problem — the owned result has no name to be released
        // through. Reject with a span; the user can drop the value
        // into a variable to take ownership.
        if (isString(expr.ty)) {
          throw new UnsupportedConstruct(
            `string-valued expression at statement scope is not yet ` +
              `supported (assign it to a variable first)`,
            s.span
          );
        }
        return { kind: "ExprStmt", expr, span: s.span };
      }

      case "If":
        return lowerIf.call(this, s);

      case "While":
        return lowerWhile.call(this, s);

      case "Break":
        return { kind: "Break", span: s.span };

      case "Continue":
        return { kind: "Continue", span: s.span };

      case "Return": {
        if (this.outputVar === null) {
          throw new UnsupportedConstruct(
            `'return' at script scope is not supported (only inside functions)`,
            s.span
          );
        }
        return {
          kind: "ReturnFromFunction",
          outputCName: this.currentCNameFor(this.outputVar),
          span: s.span,
        };
      }

      case "For":
        return lowerFor.call(this, s);

      default:
        throw new UnsupportedConstruct(
          `unsupported statement: ${s.type}`,
          "span" in s ? s.span : null
        );
    }
  }

  // ── Expressions ───────────────────────────────────────────────────────

  lowerExpr(e: Expr): IRExpr {
    switch (e.type) {
      case "Number": {
        const n = Number(e.value);
        if (Number.isNaN(n)) {
          throw new UnsupportedConstruct(
            `cannot parse numeric literal '${e.value}'`,
            e.span
          );
        }
        return {
          kind: "NumLit",
          value: n,
          ty: scalarDouble(signFromValue(n)),
          span: e.span,
        };
      }

      case "String": {
        // Double-quoted string literal `"..."`. The lexer's lexeme
        // includes the surrounding quotes; numbl's escape rule for
        // double-quoted strings is doubled `""` → a single `"`.
        // Anything else (backslash escapes, etc.) is left as-is to
        // match numbl's permissive lexer behavior.
        const raw = e.value;
        if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
          throw new UnsupportedConstruct(
            `internal: malformed string literal lexeme '${raw}'`,
            e.span
          );
        }
        const inner = raw.slice(1, -1).replace(/""/g, '"');
        return {
          kind: "StringLit",
          value: inner,
          ty: STRING,
          span: e.span,
        };
      }

      case "Char": {
        // numbl's char (single-quoted) is a row-vector of code units —
        // semantics diverge from `string` (e.g. `length('hi') == 2`
        // vs `length("hi") == 1`, `'a' + 1 == 98` vs `"a" + 1 == "a1"`).
        // mtoc doesn't yet have a char codegen path; defer with a
        // clear error pointing the user at double-quoted strings.
        throw new UnsupportedConstruct(
          `char literals (single-quoted) are not yet supported; ` +
            `use a double-quoted string ("...") instead`,
          e.span
        );
      }

      case "ImagUnit": {
        // Bare `ImagUnit` represents the implicit `1i`. The numbl parser
        // only emits a standalone `ImagUnit` as the right operand of
        // `Binary(Mul, NumLit, ImagUnit)`; the binary lowerer folds that
        // pair into a single `ImagLit { value: numLit.value }`. Lowering
        // the bare form here as `ImagLit { value: 1 }` keeps the IR
        // uniform if a future parser path delivers a standalone unit.
        return {
          kind: "ImagLit",
          value: 1,
          ty: scalarComplex(),
          span: e.span,
        };
      }

      case "Ident": {
        const ty = this.env.get(e.name);
        if (ty) {
          return {
            kind: "Var",
            name: e.name,
            cName: this.currentCNameFor(e.name),
            ty,
            span: e.span,
          };
        }
        const k = getConstant(e.name);
        if (k) {
          return {
            kind: "NumLit",
            value: k.value,
            ty: scalarDouble(k.sign),
            span: e.span,
          };
        }
        throw new TypeError(`use of undefined variable '${e.name}'`, e.span);
      }

      case "Binary":
        return lowerBinary.call(this, e);

      case "Unary":
        return lowerUnary.call(this, e);

      case "Tensor":
        return lowerTensorLiteral.call(this, e);

      case "FuncCall":
        return lowerFuncCall.call(this, e);

      default:
        throw new UnsupportedConstruct(
          `unsupported expression: ${e.type}`,
          "span" in e ? e.span : null
        );
    }
  }
}

/**
 * Owned-allocating expression kinds: expressions that produce a fresh
 * heap-owned value at runtime and therefore can only appear at the
 * top of `Assign.rhs`, where the surrounding `mtoc_*_assign` takes
 * ownership. Anywhere nested would leak the temporary buffer.
 *
 * - `tensor-lit`: every TensorLit allocates a fresh tensor.
 * - `string-concat`: a string-typed `Binary` (`+`) calls
 *   `mtoc_string_concat`, which returns an owned handle.
 *
 * `Var` is never an owned-allocating expression — it just reads an
 * already-owned heap value; the read doesn't transfer ownership.
 * Similarly `StringLit` points at `.rodata` (zero allocation) and
 * is fine anywhere.
 */
type OwnedExprKind = "tensor-lit" | "string-concat";

function classifyOwnedExpr(e: IRExpr): OwnedExprKind | null {
  if (e.kind === "TensorLit") return "tensor-lit";
  if (e.kind === "Binary" && isString(e.ty)) return "string-concat";
  return null;
}

function ownedExprMessage(kind: OwnedExprKind): string {
  switch (kind) {
    case "tensor-lit":
      return (
        "tensor literals are only supported as the right-hand side of an " +
        "assignment (not inside a larger expression)"
      );
    case "string-concat":
      return (
        "string concatenation (`+`) is only supported as the top-level " +
        "right-hand side of an assignment; assign intermediate " +
        "concatenations to a variable first"
      );
  }
}

/**
 * Reject any owned-allocating sub-expression — a TensorLit anywhere,
 * or a string-typed `Binary` (concat) anywhere. The expression
 * passed in is itself checked, so call sites that *do* permit a
 * top-level owned producer (the supported `Assign.rhs` shapes)
 * recurse into the operands directly instead of calling this helper
 * on the whole RHS. Recurses through every other expression kind.
 */
function rejectNestedOwnedExpr(e: IRExpr): void {
  const kind = classifyOwnedExpr(e);
  if (kind !== null) {
    throw new UnsupportedConstruct(ownedExprMessage(kind), e.span);
  }
  switch (e.kind) {
    case "Var":
    case "NumLit":
    case "ImagLit":
    case "StringLit":
      return;
    case "Binary":
      rejectNestedOwnedExpr(e.left);
      rejectNestedOwnedExpr(e.right);
      return;
    case "Unary":
      rejectNestedOwnedExpr(e.operand);
      return;
    case "Call":
      for (const a of e.args) rejectNestedOwnedExpr(a);
      return;
    case "TensorLit":
      // Unreachable — `classifyOwnedExpr` already returned
      // "tensor-lit" above and we threw. Kept for exhaustiveness.
      return;
  }
}

/**
 * Reject any `Call` node inside an expression subtree. Used to enforce
 * the rule "no function calls inside a multi-element tensor expression"
 * — codegen's elementwise loop has no way to materialize a Call result
 * yet.
 */
function rejectCallInTensorContext(e: IRExpr): void {
  switch (e.kind) {
    case "Call":
      throw new UnsupportedConstruct(
        `function calls inside a multi-element tensor expression are not ` +
          `yet supported (assign the call result to a name first)`,
        e.span
      );
    case "NumLit":
    case "ImagLit":
    case "Var":
    case "TensorLit":
      // TensorLit has already been rejected by `rejectNestedTensorLit`
      // before we get here; if it slipped through, the codegen-side
      // assertion will fire.
      return;
    case "Binary":
      rejectCallInTensorContext(e.left);
      rejectCallInTensorContext(e.right);
      return;
    case "Unary":
      rejectCallInTensorContext(e.operand);
      return;
  }
}

function validateStmts(stmts: ReadonlyArray<IRStmt>): void {
  for (const s of stmts) validateStmt(s);
}

function validateStmt(s: IRStmt): void {
  switch (s.kind) {
    case "Assign": {
      // `Assign.rhs` is the one position that *permits* a top-level
      // owned producer (TensorLit / string concat). Recurse into the
      // operands of that producer; everything else gets the whole
      // expression checked.
      const top = classifyOwnedExpr(s.rhs);
      if (top === "tensor-lit") {
        // TensorLit cells were required to be scalar-real at lowering;
        // still check none of them is itself an owned producer.
        const tl = s.rhs as Extract<IRExpr, { kind: "TensorLit" }>;
        for (const row of tl.elements) {
          for (const cell of row) rejectNestedOwnedExpr(cell);
        }
      } else if (top === "string-concat") {
        const b = s.rhs as Extract<IRExpr, { kind: "Binary" }>;
        rejectNestedOwnedExpr(b.left);
        rejectNestedOwnedExpr(b.right);
      } else {
        rejectNestedOwnedExpr(s.rhs);
        if (isMultiElement(s.rhs.ty)) {
          rejectCallInTensorContext(s.rhs);
        }
      }
      return;
    }
    case "ExprStmt":
      rejectNestedOwnedExpr(s.expr);
      return;
    case "Disp":
    case "Error":
      rejectNestedOwnedExpr(s.arg);
      return;
    case "If":
      rejectNestedOwnedExpr(s.cond);
      validateStmts(s.thenBody);
      for (const eif of s.elseifs) {
        rejectNestedOwnedExpr(eif.cond);
        validateStmts(eif.body);
      }
      if (s.elseBody) validateStmts(s.elseBody);
      return;
    case "While":
      rejectNestedOwnedExpr(s.cond);
      validateStmts(s.body);
      return;
    case "For":
      rejectNestedOwnedExpr(s.start);
      rejectNestedOwnedExpr(s.step);
      rejectNestedOwnedExpr(s.end);
      validateStmts(s.body);
      return;
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return;
  }
}

/**
 * Walk the lowered program rejecting constructs that would have made
 * codegen throw a stack trace — TensorLit nested inside expressions,
 * Call nodes inside multi-element tensor RHSs. Errors thrown here carry
 * a span, so users see a line number instead of a codegen-internal
 * trace.
 */
function validateIR(prog: IRProgram): void {
  for (const fn of prog.functions) validateStmts(fn.body);
  validateStmts(prog.stmts);
}

export function lower(
  ast: AbstractSyntaxTree,
  workspace: Workspace
): IRProgram {
  // Pull function definitions out of the top-level script body. They
  // become entries in the workspace's local-function table; the
  // remaining stmts are the script body.
  const scriptBody: Stmt[] = [];
  for (const s of ast.body) {
    if (s.type === "Function") {
      workspace.registerLocalFunction(s);
    } else {
      scriptBody.push(s);
    }
  }

  const shared: SharedSpecState = {
    workspace,
    cache: new Map(),
    order: [],
    inFlight: new Set(),
  };
  const top = new Lowerer(shared);
  const stmts = top.lowerStmts(scriptBody);
  const prog: IRProgram = {
    assignedVars: top.getAssignedVars(),
    functions: shared.order,
    stmts,
  };
  validateIR(prog);
  return prog;
}
