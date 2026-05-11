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
import { getBuiltin } from "../workspace/builtins.js";
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
  isCharArray,
  isCharScalar,
  isMultiElement,
  isOwned,
  isScalar,
  isScalarReal,
  isString,
  MType,
  NumericType,
  scalarChar,
  scalarComplex,
  scalarDouble,
  signFromValue,
  STRING,
  typeToString,
  unify,
  type DimInfo,
} from "./types.js";

import { lowerIf } from "./lowerIf.js";
import { lowerFor } from "./lowerFor.js";
import { lowerWhile } from "./lowerWhile.js";
import { lowerBinary } from "./lowerBinary.js";
import { lowerUnary } from "./lowerUnary.js";
import {
  isElementwiseBuiltin,
  lowerFuncCall,
  lowerMultiAssignCall,
} from "./lowerFuncCall.js";
import { lowerIndexStore } from "./lowerIndexStore.js";
import { lowerIndexSliceStore } from "./lowerIndexSliceStore.js";
import { lowerTensorLiteral } from "./lowerTensorLiteral.js";
import {
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "./walk.js";
import { anfNormalize } from "./anf.js";

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
  /** Output variables for the current function scope, in declaration
   *  order. Empty array at script scope and inside zero-output
   *  functions; length 1 for classic single-output functions; length ≥
   *  2 for multi-output. Used to (1) decide whether `return` is legal
   *  here and (2) populate `IRStmt.ReturnFromFunction.outputCNames`
   *  with the LIVE post-lowering cName of every output via
   *  `currentCNameFor`. */
  private outputVars: string[];
  /** True iff this lowerer is lowering inside a function body. Empty
   *  `outputVars` alone can't distinguish script scope from a zero-
   *  output function — both have nothing to return — so this flag
   *  drives the "is `return` legal here?" check. */
  private isInsideFunction: boolean;
  /** Nesting depth inside control-flow constructs. Bumped by
   *  `lowerIf` / `lowerWhile` / `lowerFor` via `withControlDepth`.
   *  Splitting an incompatible reassignment is only allowed at depth
   *  0 — inside a branch or loop the merge would have to reconcile
   *  bindings across arms / iterations, which Phase 1 doesn't attempt. */
  controlDepth = 0;

  /** Stack of contexts for resolving the `end` keyword. Each entry
   *  describes the indexing context an `end` token would refer to:
   *  the base variable's C name + type plus the axis (`row`, `col`,
   *  or `linear`). Pushed by `lowerIndexLoad` around each index slot
   *  it lowers; consumed by the `EndKeyword` arm of `lowerExpr`.
   *  Outside an index, the stack is empty and an `end` use raises
   *  an `UnsupportedConstruct` with a span. */
  endStack: Array<{
    baseCName: string;
    baseTy: MType;
    axis: "row" | "col" | "linear";
  }> = [];

  /** Function-specialization cache + workspace handle. Helpers in
   *  sibling files reach through this for user-call dispatch. */
  readonly shared: SharedSpecState;

  constructor(
    shared: SharedSpecState,
    paramBindings: Array<{ name: string; cName: string; ty: MType }> = [],
    outputVars: string[] = [],
    isInsideFunction = false
  ) {
    this.shared = shared;
    this.params = new Set(paramBindings.map(p => p.name));
    for (const p of paramBindings) {
      this.env.set(p.name, p.ty);
      this.currentBindingCName.set(p.name, p.cName);
    }
    this.outputVars = outputVars;
    this.isInsideFunction = isInsideFunction;
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
      // Absent default: the value a C predeclaration gives the variable
      // when a branch doesn't assign it. Numeric → 0.0; string →
      // mtoc_string_empty(); char scalar → '\0'; char array → empty.
      const absentDefault: MType = present.every(isString)
        ? STRING
        : present.every(t => isCharArray(t))
          ? {
              kind: "Numeric",
              elem: "char",
              isComplex: false,
              rows: { kind: "one" },
              cols: { kind: "notOne" },
              sign: "unknown",
            }
          : present.every(t => isCharScalar(t))
            ? scalarChar()
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

      case "AssignLValue": {
        // The parser produces this for any non-bare-identifier LHS:
        // `v(i) = x`, `obj.field = x`, `M(i,j) = x`, etc. We only
        // handle the indexed-write form today; other lvalue kinds
        // raise UnsupportedConstruct with a span.
        if (s.lvalue.type !== "Index") {
          throw new UnsupportedConstruct(
            `assignment to a ${s.lvalue.type} lvalue is not yet supported`,
            s.span
          );
        }
        // Range/colon slot routes to the slice-write path; otherwise
        // it's a scalar IndexStore.
        const isSliceArg = (a: Expr): boolean =>
          a.type === "Range" || a.type === "Colon";
        if (s.lvalue.indices.some(isSliceArg)) {
          return lowerIndexSliceStore.call(this, s.lvalue, s.expr, s.span);
        }
        return lowerIndexStore.call(this, s.lvalue, s.expr, s.span);
      }

      case "ExprStmt": {
        // Bare-statement user-function call: 0-output and N≥2-output
        // user functions can't appear in expression position (their C
        // ABI is `void` + out-pointers, not return-by-value), so we
        // route them to `MultiAssignCall` here. 1-output user calls
        // continue through the regular `lowerExpr` → `ExprStmt(Call)`
        // pipeline so the emitted C is the existing `(void)(foo(x));`
        // shape. Builtins delegate to their `lowerStmt` hook (if any)
        // before the default expression-call path; that's how `disp`
        // and `error` produce dedicated `IRStmt.Disp` / `IRStmt.Error`
        // nodes without lower.ts hardcoding their names.
        if (s.expr.type === "FuncCall") {
          const target = this.shared.workspace.resolve(s.expr.name);
          if (target?.kind === "userFunction") {
            const fnAst = this.shared.workspace.localFunctions.get(s.expr.name);
            if (fnAst && fnAst.outputs.length !== 1) {
              return lowerMultiAssignCall.call(
                this,
                fnAst,
                s.expr.name,
                s.expr.args,
                [],
                s.span
              );
            }
          }
          const builtin = getBuiltin(s.expr.name);
          if (builtin?.lowerStmt) {
            const lowered = builtin.lowerStmt(this, s.expr.args, s.span);
            if (lowered !== null) return lowered;
          }
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
        if (this.outputVars.length === 0 && !this.isInsideFunction) {
          throw new UnsupportedConstruct(
            `'return' at script scope is not supported (only inside functions)`,
            s.span
          );
        }
        return {
          kind: "ReturnFromFunction",
          outputCNames: this.outputVars.map(o => this.currentCNameFor(o)),
          span: s.span,
        };
      }

      case "For":
        return lowerFor.call(this, s);

      case "MultiAssign": {
        // `[a, b, ~] = foo(x);` — only legal when `foo` resolves to a
        // user function; multi-assigning a builtin isn't supported
        // because builtins are scalar return-by-value and have no
        // multi-output convention in mtoc today.
        if (s.expr.type !== "FuncCall") {
          throw new UnsupportedConstruct(
            `multi-assign right-hand side must be a user-function call`,
            s.span
          );
        }
        const target = this.shared.workspace.resolve(s.expr.name);
        if (target?.kind !== "userFunction") {
          throw new UnsupportedConstruct(
            `multi-assign of '${s.expr.name}' is not supported ` +
              `(only user-defined functions can appear on the right of ` +
              `\`[...] = ...\`)`,
            s.span
          );
        }
        const fnAst = this.shared.workspace.localFunctions.get(s.expr.name);
        if (!fnAst) {
          throw new UnsupportedConstruct(
            `internal: workspace claimed '${s.expr.name}' is a user function ` +
              `but no AST is registered`,
            s.span
          );
        }
        return lowerMultiAssignCall.call(
          this,
          fnAst,
          s.expr.name,
          s.expr.args,
          s.lvalues,
          s.span
        );
      }

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
        // numbl's char (single-quoted) is a 1×N row-vector of code
        // units. mtoc maps each char literal to a NumericType with
        // elem:"char". Scalar chars (N=1) become bare C `char`;
        // multi-element chars become `mtoc_char_tensor_t`.
        const raw = e.value;
        if (raw.length < 2 || raw[0] !== "'" || raw[raw.length - 1] !== "'") {
          throw new UnsupportedConstruct(
            `internal: malformed char literal lexeme '${raw}'`,
            e.span
          );
        }
        // Doubled single-quote '' → ' inside a char literal.
        const inner = raw.slice(1, -1).replace(/''/g, "'");
        if (inner.length === 0) {
          throw new UnsupportedConstruct(
            `empty char literal ('') is not yet supported ` +
              `(1×0 char arrays are deferred)`,
            e.span
          );
        }
        const n = inner.length;
        const cols: DimInfo = n === 1 ? { kind: "one" } : { kind: "notOne" };
        const ty: NumericType = {
          kind: "Numeric",
          elem: "char",
          isComplex: false,
          rows: { kind: "one" },
          cols,
          sign: "unknown",
        };
        return { kind: "CharLit", value: inner, ty, span: e.span };
      }

      case "EndKeyword": {
        // `end` is only meaningful inside an index expression. The
        // `endStack` is pushed by `lowerIndexLoad` for each index
        // slot it lowers; the top describes which axis of which base
        // this `end` refers to. Outside an index the stack is empty
        // and we reject with a span.
        if (this.endStack.length === 0) {
          throw new UnsupportedConstruct(
            `'end' is only valid inside an index expression`,
            e.span
          );
        }
        const top = this.endStack[this.endStack.length - 1];
        return {
          kind: "EndRef",
          baseCName: top.baseCName,
          baseTy: top.baseTy,
          axis: top.axis,
          ty: scalarDouble("nonnegative"),
          span: e.span,
        };
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
 * Owned-allocating expression kinds: expressions whose evaluation
 * returns a fresh heap-owned value at runtime (tensor / char tensor /
 * string). The post-lowering ANF pass (`src/lowering/anf.ts`) hoists
 * every such expression that isn't already at the top of an owned-LHS
 * `Assign.rhs` into a synthetic `Assign` to a `_mtoc_anf_<N>` temp,
 * so after ANF an owned producer appears at exactly one position: the
 * full RHS of an owned-LHS `Assign`. This validator verifies that
 * invariant.
 *
 * - `tensor-lit`: every TensorLit allocates a fresh tensor.
 * - `string-concat`: a string-typed `Binary` (`+`) calls
 *   `mtoc_string_concat`, which returns an owned handle.
 * - `index-slice`: an `IndexSlice` (range/colon read) allocates a
 *   fresh tensor sized by the index range.
 * - `user-call`: a `Call` to a user-defined function whose result is
 *   owned (`isOwned`), returned by struct value from the callee.
 *
 * `Var` is never an owned-allocating expression — it just reads an
 * already-owned heap value; the read doesn't transfer ownership.
 * `StringLit` points at `.rodata` (zero allocation) and is fine
 * anywhere. Elementwise scalar builtin Calls and Binary/Unary nodes
 * also don't allocate at the call site — they fold into iter-loop
 * staging buffers managed by `emitTensorAssignFromExpr`.
 */
type OwnedExprKind =
  | "tensor-lit"
  | "string-concat"
  | "index-slice"
  | "user-call";

function classifyOwnedExpr(e: IRExpr): OwnedExprKind | null {
  if (e.kind === "TensorLit") return "tensor-lit";
  if (e.kind === "Binary" && isString(e.ty)) return "string-concat";
  if (e.kind === "IndexSlice") return "index-slice";
  if (e.kind === "Call" && e.callee.kind === "userFunc" && isOwned(e.ty)) {
    return "user-call";
  }
  return null;
}

function ownedExprMessage(kind: OwnedExprKind): string {
  switch (kind) {
    case "tensor-lit":
      return (
        "internal: tensor literal still nested inside another expression " +
        "after ANF; ANF pass should have hoisted it"
      );
    case "string-concat":
      return (
        "internal: string concatenation still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
    case "index-slice":
      return (
        "internal: range/colon index slice still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
    case "user-call":
      return (
        "internal: owned-returning user-function call still nested " +
        "inside another expression after ANF; ANF pass should have " +
        "hoisted it"
      );
  }
}

/**
 * Reject any owned-allocating sub-expression that ANF didn't hoist.
 * After ANF the IR satisfies "owned producers only appear as the
 * full RHS of an owned-LHS Assign"; this walker enforces that on
 * every expression position EXCEPT the cases the caller has already
 * exempted (the direct-consume Assign.rhs).
 */
function rejectNestedOwnedExpr(e: IRExpr): void {
  forEachSubExpr(e, sub => {
    const kind = classifyOwnedExpr(sub);
    if (kind !== null) {
      throw new UnsupportedConstruct(ownedExprMessage(kind), sub.span);
    }
  });
}

/**
 * Reject non-elementwise `Call` nodes inside a multi-element tensor
 * expression. After ANF every owned-producing user-func Call has
 * been hoisted into its own Assign, so what remains under a multi-
 * element expression is either an elementwise builtin Call (which
 * lifts slot-by-slot in the iter loop) or a reduction-style Call
 * whose tensor arg has been collapsed to a per-slot scalar — the
 * latter is wrong, so reject it with a span.
 */
function rejectCallInTensorContext(e: IRExpr): void {
  forEachSubExpr(e, sub => {
    if (sub.kind !== "Call") return;
    if (sub.callee.kind === "builtin" && isElementwiseBuiltin(sub.callee.sig)) {
      return;
    }
    throw new UnsupportedConstruct(
      `function calls inside a multi-element tensor expression are not ` +
        `yet supported here (only element-wise scalar builtins like ` +
        `sqrt/sin/abs lift slot-by-slot; assign other call results to ` +
        `a name first)`,
      sub.span
    );
  });
}

function validateStmt(s: IRStmt): void {
  if (s.kind === "Assign") {
    // The only position that permits a top-level owned producer is
    // the RHS of an owned-LHS Assign whose RHS kind matches the
    // producer's classification — the ANF pass leaves that direct
    // consume site intact and lifts everything else. Recurse into
    // the producer's operands (those positions are nested), and run
    // the standard rejection on any other RHS shape.
    const top = classifyOwnedExpr(s.rhs);
    if (top === "tensor-lit") {
      const tl = s.rhs as Extract<IRExpr, { kind: "TensorLit" }>;
      for (const row of tl.elements) {
        for (const cell of row) rejectNestedOwnedExpr(cell);
      }
    } else if (top === "string-concat") {
      const b = s.rhs as Extract<IRExpr, { kind: "Binary" }>;
      rejectNestedOwnedExpr(b.left);
      rejectNestedOwnedExpr(b.right);
    } else if (top === "index-slice") {
      const slice = s.rhs as Extract<IRExpr, { kind: "IndexSlice" }>;
      if (slice.index.kind === "Range") {
        rejectNestedOwnedExpr(slice.index.start);
        rejectNestedOwnedExpr(slice.index.step);
        rejectNestedOwnedExpr(slice.index.end);
      }
    } else if (top === "user-call") {
      const call = s.rhs as Extract<IRExpr, { kind: "Call" }>;
      for (const a of call.args) rejectNestedOwnedExpr(a);
    } else {
      rejectNestedOwnedExpr(s.rhs);
      if (isMultiElement(s.rhs.ty)) {
        rejectCallInTensorContext(s.rhs);
      }
    }
    return;
  }
  // Every other stmt holds expressions in non-consume positions.
  // After ANF none of them should contain an owned producer.
  forEachTopLevelExpr(s, rejectNestedOwnedExpr);
}

/**
 * Walk the post-ANF program and assert the "owned producers only at
 * Assign-RHS top" invariant. Anything that slipped through is
 * an internal bug — ANF should have hoisted it — but we still throw
 * with a span so the user sees a line number.
 */
function validateIR(prog: IRProgram): void {
  for (const fn of prog.functions) forEachStmtInTree(fn.body, validateStmt);
  forEachStmtInTree(prog.stmts, validateStmt);
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
  // A-normalize: hoist every owned-producing sub-expression that
  // isn't already at a direct consume site into a synthetic
  // `_mtoc_anf_<N> = <producer>;` Assign. After this pass the IR
  // satisfies the invariant `validateIR` enforces.
  anfNormalize(prog);
  validateIR(prog);
  return prog;
}
