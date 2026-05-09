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
  isScalarReal,
  MType,
  scalarComplex,
  scalarDouble,
  signFromValue,
  staticNumElements,
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

  /** Determine whether the unified type can be represented by a single
   *  predeclared C variable. Numeric types need both dims statically
   *  exact (so codegen knows the buffer size); Unknown / Void can never
   *  share storage. */
  private static canShareStorage(t: MType): boolean {
    if (t.kind !== "Numeric") return false;
    return t.rows.kind === "exact" && t.cols.kind === "exact";
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
   *    for the first write), returns that cName.
   *  - Incompatible reassignment — the unified type can't live in a
   *    single C variable (different elem kinds, non-exact dims, etc.).
   *    At `controlDepth === 0` we split: a fresh cName is allocated and
   *    a new `assignedVars` entry created; the old binding stays for
   *    earlier reads. Inside control flow we throw — Phase 2 will lift
   *    that with liveness analysis. */
  recordAssignment(name: string, ty: MType, span: Span): string {
    assertNotMtocReserved(name, span);
    // env tracks the LATEST type at the current program point —
    // sequential assignment replaces, it does not unify with prior types.
    this.env.set(name, ty);

    if (this.params.has(name)) {
      // Params keep their fixed cName (declared by the C function
      // signature). Phase 1 doesn't split params.
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
    if (Lowerer.canShareStorage(merged)) {
      // Compatible — widen the existing binding's type in place.
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

    // The merged-type Unknown branch and the non-exact-dims branch report
    // different errors today; preserve that distinction so the existing
    // "use a different name" guidance still kicks in for char/struct
    // mismatches versus shape conflicts.
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
        `being assigned ${typeToString(ty)}; mtoc requires a fixed shape ` +
        `across all assignments to a tensor variable inside control flow. ` +
        `Use a different name for the new value, or hoist the reassignment ` +
        `outside the surrounding if/while/for.`,
      span
    );
  }

  /**
   * Merge the post-arm envs of a control-flow construct into a single
   * env representing the program point after the construct.
   *
   * For each variable that appears in ANY arm's env, we unify its type
   * across every arm. If an arm doesn't have the variable, that arm
   * fell through without assigning it — the runtime sees the predeclared
   * default (0.0 in our codegen), which has sign `zero`. So we unify
   * with `scalarDouble("zero")` for those arms.
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
    const ZERO = scalarDouble("zero");
    const result = new Map<string, MType>();
    const allKeys = new Set<string>();
    for (const e of envs) for (const k of e.keys()) allKeys.add(k);

    for (const k of allKeys) {
      let unified: MType | undefined;
      for (const e of envs) {
        const t = e.get(k) ?? ZERO;
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
        // Reject non-exact dims up front: codegen needs a statically
        // known numel to emit a stack-backed `mtoc_tensor_t`, and a
        // multi-element RHS without exact dims has nowhere safe to
        // land. We surface this at lowering time so the user sees a
        // span. (TensorLit always has exact dims by construction.)
        // Done before recordAssignment so this never produces a
        // never-emit-able split binding.
        if (
          isMultiElement(rhs.ty) &&
          rhs.kind !== "TensorLit" &&
          staticNumElements(rhs.ty) === null
        ) {
          throw new UnsupportedConstruct(
            `assignment to '${s.name}' produces a tensor with non-exact ` +
              `dimensions (${typeToString(rhs.ty)}); mtoc requires a ` +
              `statically-known shape for tensor results`,
            s.span
          );
        }
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
          return { kind: "Disp", arg, span: s.span };
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
 * Reject a TensorLit anywhere inside an expression subtree. Used to
 * enforce the rule "TensorLit only at top level of Assign.rhs" — every
 * other position recurses through here.
 */
function rejectNestedTensorLit(e: IRExpr): void {
  switch (e.kind) {
    case "TensorLit":
      throw new UnsupportedConstruct(
        `tensor literals are only supported as the right-hand side of an ` +
          `assignment (not inside a larger expression)`,
        e.span
      );
    case "NumLit":
    case "ImagLit":
    case "Var":
      return;
    case "Binary":
      rejectNestedTensorLit(e.left);
      rejectNestedTensorLit(e.right);
      return;
    case "Unary":
      rejectNestedTensorLit(e.operand);
      return;
    case "Call":
      for (const a of e.args) rejectNestedTensorLit(a);
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
    case "Assign":
      if (s.rhs.kind === "TensorLit") {
        // Top-level TensorLit at Assign.rhs is the one supported
        // position. Cells were already required to be scalar-real.
        for (const row of s.rhs.elements) {
          for (const cell of row) rejectNestedTensorLit(cell);
        }
      } else {
        rejectNestedTensorLit(s.rhs);
        if (isMultiElement(s.rhs.ty)) {
          rejectCallInTensorContext(s.rhs);
        }
      }
      return;
    case "ExprStmt":
      rejectNestedTensorLit(s.expr);
      return;
    case "Disp":
      rejectNestedTensorLit(s.arg);
      return;
    case "If":
      rejectNestedTensorLit(s.cond);
      validateStmts(s.thenBody);
      for (const eif of s.elseifs) {
        rejectNestedTensorLit(eif.cond);
        validateStmts(eif.body);
      }
      if (s.elseBody) validateStmts(s.elseBody);
      return;
    case "While":
      rejectNestedTensorLit(s.cond);
      validateStmts(s.body);
      return;
    case "For":
      rejectNestedTensorLit(s.start);
      rejectNestedTensorLit(s.step);
      rejectNestedTensorLit(s.end);
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
