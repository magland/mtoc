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
  absentDefaultFor,
  canShareStorage,
  isCell,
  isClass,
  isHandle,
  isMultiElement,
  isOwned,
  isScalarComplex,
  isScalarReal,
  isStruct,
  MType,
  NumericType,
  charArrayType,
  scalarChar,
  scalarComplex,
  scalarDouble,
  signFromValue,
  STRING,
  typeToString,
  unify,
  type DimInfo,
} from "./types.js";

import { StructLoweringState } from "./structLoweringState.js";
import { ClassLoweringState } from "./classLoweringState.js";
import { lowerClassMethodCall, lowerSuperCall } from "./lowerClass.js";
import {
  lowerMemberRead,
  lowerMemberStore,
  lowerStructConstructor,
  lowerStructFieldIndex,
} from "./lowerStruct.js";
import { CellLoweringState } from "./cellLoweringState.js";
import {
  lowerCellIndexRead,
  lowerCellIndexStore,
  lowerCellLiteral,
} from "./lowerCell.js";

import { lowerIf } from "./lowerIf.js";
import { lowerFor } from "./lowerFor.js";
import { lowerWhile } from "./lowerWhile.js";
import { lowerBinary } from "./lowerBinary.js";
import { lowerUnary } from "./lowerUnary.js";
import {
  isElementwiseBuiltin,
  lowerBuiltinCall,
  lowerFuncCall,
  lowerMultiAssignCall,
} from "./lowerFuncCall.js";
import {
  handleUserCallable,
  lowerAnonFunc,
  lowerFuncHandle,
  lowerHandleCall,
} from "./lowerHandle.js";
import { lowerIndexStore } from "./lowerIndexStore.js";
import { lowerIndexSliceStore } from "./lowerIndexSliceStore.js";
import { lowerTensorLiteral } from "./lowerTensorLiteral.js";
import { isSliceArg } from "./indexResolve.js";
import {
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "./walk.js";
import { anfNormalize, classifyOwnedExpr, ownedExprMessage } from "./anf.js";
import { decodeNumblQuotedLexeme } from "./lexerHelpers.js";
import { normalizeStructTypes } from "./normalizeStructTypes.js";

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
  /** Per-program counter for synthetic anonymous-function names
   *  (`_mtoc_anon_<N>`). Each `@(...)` site bumps this once; subsequent
   *  specializations of the same anonymous body share the base name. */
  anonCounter: { value: number };
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
  /** Counter for the synthetic suffix used by `synthesizeDiscardAssign`
   *  to give each bare-statement-scope owned expression a unique
   *  `_mtoc_stmt_discard_<N>` binding. Per-scope so different functions
   *  don't share numbering. */
  private discardCounter = 0;
  /** Counter for the synthetic `_mtoc_class_init_<N>` bindings created
   *  at every class-constructor call site (the receiver-as-first-param
   *  initial value). Per-scope so different functions don't share
   *  numbering. */
  private classInitCounter = 0;
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
   *  the base variable's C name + type plus the axis (a 0-based axis
   *  index, or `"linear"` for single-slot indexing whose `end` is
   *  `numel(base)`). Pushed by `lowerIndexLoad` / `lowerIndexSlice`
   *  around each index slot they lower; consumed by the `EndKeyword`
   *  arm of `lowerExpr`. Outside an index, the stack is empty and an
   *  `end` use raises an `UnsupportedConstruct` with a span. */
  endStack: Array<{
    baseCName: string;
    baseTy: MType;
    axis: number | "linear";
  }> = [];

  /** Per-scope struct-lowering state — pre-pass shape map and the
   *  per-root field-type tracking that grows as the body assigns
   *  through fields. Reified into its own object so the god-object
   *  stays slim and so the future `ClassLoweringState` can slot in
   *  alongside in the same shape. See `structLoweringState.ts`. */
  struct = new StructLoweringState();

  /** Per-scope class-lowering state — root vars whose values are
   *  class instances, plus per-property type tracking. Mirrors the
   *  struct state but the declared property set comes from
   *  `ClassInfo` rather than a body-walking pre-pass. */
  class_ = new ClassLoweringState();

  /** Alias for `class_`. `class` is a reserved word in TS so the
   *  field can't be named `class` directly, but a getter under that
   *  name reads cleanly at call sites (`this.class.roots`, etc.). */
  get class(): ClassLoweringState {
    return this.class_;
  }

  /** Per-scope cell-lowering state — pre-pass tuple-vs-homogeneous
   *  decision per root variable that ever appears as a cell. See
   *  `cellLoweringState.ts`. */
  cell = new CellLoweringState();

  /** Function-specialization cache + workspace handle. Helpers in
   *  sibling files reach through this for user-call dispatch. */
  readonly shared: SharedSpecState;

  /** Source file the current Lowerer scope lives in. Script-scope: the
   *  workspace's `mainFile`. Function-scope: the file the function
   *  being specialized was loaded from. Threaded through the
   *  resolver's `CallSite` so cross-file local-function and private-
   *  function visibility rules apply correctly. */
  readonly currentFile: string;

  /** Enclosing class name when lowering inside a class method body —
   *  used to populate `CallSite.className` so the resolver's
   *  class-file local-function precedence rule (which scopes
   *  `classFileSubfunctions` per className) works correctly. Undefined
   *  at script scope and inside ordinary (non-method) functions. */
  readonly currentClassName?: string;

  /** Enclosing method name when lowering inside a class method body —
   *  used to populate `CallSite.methodName`. Lets the resolver scope
   *  external-method-file local helpers to the right method. Undefined
   *  outside class-method bodies. */
  readonly currentMethodName?: string;

  constructor(
    shared: SharedSpecState,
    paramBindings: Array<{ name: string; cName: string; ty: MType }> = [],
    outputVars: string[] = [],
    isInsideFunction = false,
    currentFile?: string,
    currentClassName?: string,
    currentMethodName?: string
  ) {
    this.shared = shared;
    this.params = new Set(paramBindings.map(p => p.name));
    for (const p of paramBindings) {
      this.env.set(p.name, p.ty);
      this.currentBindingCName.set(p.name, p.cName);
    }
    this.outputVars = outputVars;
    this.isInsideFunction = isInsideFunction;
    this.currentFile = currentFile ?? shared.workspace.mainFile;
    this.currentClassName = currentClassName;
    this.currentMethodName = currentMethodName;
  }

  /** Populate the struct-state shape map for the body about to be
   *  lowered. Called once before the body's stmts are visited. */
  primeStructShapes(body: ReadonlyArray<Stmt>): void {
    this.struct.primeFromBody(body);
  }

  /** Populate the cell-state shape map for the body about to be
   *  lowered. Called once before the body's stmts are visited,
   *  alongside `primeStructShapes`. */
  primeCellShapes(body: ReadonlyArray<Stmt>): void {
    this.cell.primeFromBody(body);
  }

  /** Build a `StructType` for `rootName` reflecting the current
   *  field-type tracking. Returns undefined if the variable is not in
   *  the pre-pass shape map. */
  currentStructTypeFor(rootName: string): MType | undefined {
    return this.struct.lookupStructTypeFor(rootName);
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

  /** Build a `CallSite` for the vendored resolver. Fills in `file`
   *  plus the optional `className` / `methodName` lexical-scope fields
   *  when this `Lowerer` is specializing a class method body. Helpers
   *  use this instead of constructing a `{ file: this.currentFile }`
   *  literal so a new resolver-relevant field added later only needs
   *  to be added in one place. */
  callSite(): {
    file: string;
    className?: string;
    methodName?: string;
  } {
    const cs: { file: string; className?: string; methodName?: string } = {
      file: this.currentFile,
    };
    if (this.currentClassName !== undefined)
      cs.className = this.currentClassName;
    if (this.currentMethodName !== undefined)
      cs.methodName = this.currentMethodName;
    return cs;
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
    if (canShareStorage(prevBinding.ty, ty) && merged.kind !== "Unknown") {
      // Compatible — widen the existing binding's type in place. The
      // merged type stays consistent with the predeclared C variable's
      // category (scalar/tensor, real/complex); shape-level coarsening
      // (e.g. notOne ∨ unknown → unknown) doesn't change the C type.
      this.assignedVars.set(prevBinding.cName, {
        ty: merged,
        cName: prevBinding.cName,
      });
      // For struct, handle, and cell types, also widen env to the
      // merged type. The codegen pipeline (normalizeStructTypes,
      // handle-capture snapshot in `lowerAnonFunc`, cell post-
      // widening typedef collapse) reads the widened type from
      // assignedVars or env; keeping env in sync here avoids a
      // discrepancy between the at-time captured type and the
      // post-normalize typedef.
      if (
        isStruct(merged) ||
        isHandle(merged) ||
        isCell(merged) ||
        isClass(merged)
      ) {
        this.env.set(name, merged);
      }
      return prevBinding.cName;
    }
    // Struct / cell types: when the storage category matches (same
    // field-name set for struct, same arity for tuple cell, same elem
    // storage for homogeneous cell) but field-wise unify produced
    // Unknown, the conflict is almost always an unassigned-field
    // placeholder (scalarDouble("zero") from `buildStructType`) vs
    // the field's first real assignment of an incompatible category
    // (e.g. cell, string). Take the NEW type wholesale — the
    // normalize pass at the end of lowering already propagates the
    // final widened type to every reference, so the typedef stays
    // consistent. Pure numeric → numeric mismatches still fall into
    // the split / error path below since `canShareStorage` rejects
    // them.
    if (
      canShareStorage(prevBinding.ty, ty) &&
      (isStruct(ty) || isCell(ty) || isClass(ty))
    ) {
      this.assignedVars.set(prevBinding.cName, {
        ty,
        cName: prevBinding.cName,
      });
      this.env.set(name, ty);
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

  /** Allocate a fresh `_mtoc_stmt_discard_<N>` binding and return an
   *  `Assign` of `rhs` into it. Used by the `ExprStmt` lowering to give
   *  a bare statement-scope owned expression (tensor / string /
   *  char-array / struct / handle-with-captures) a name to take
   *  ownership of, so the heap buffer is released at scope exit by the
   *  standard owned-LHS predeclare + free walk. The synthetic cName is
   *  never user-visible — it lives only in `assignedVars`, with no
   *  matching MATLAB-name entry in `currentBindingCName` (so no user
   *  read can target it). */
  private synthesizeDiscardAssign(rhs: IRExpr, span: Span): IRStmt {
    const cName = `_mtoc_stmt_discard_${this.discardCounter++}`;
    const ty = rhs.ty;
    this.assignedVars.set(cName, { ty, cName });
    return { kind: "Assign", name: cName, cName, rhs, ty, span };
  }

  /** Mint a fresh `_mtoc_class_init_<N>` id. Used by `lowerClass`
   *  to give each constructor call's synthetic receiver a unique
   *  binding. */
  nextClassInitId(): number {
    return this.classInitCounter++;
  }

  /** Register a synthetic var (one not referenced by MATLAB-source
   *  name) in `assignedVars` so the standard predeclaration + free
   *  walks pick it up. Returns the cName (same as `baseName` today;
   *  reserved-prefix synthetic names don't go through `cNameFor`).
   *  Used by `lowerClass` to install the constructor receiver's
   *  initial empty value. */
  registerSyntheticBinding(baseName: string, ty: MType): string {
    this.assignedVars.set(baseName, { cName: baseName, ty });
    return baseName;
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
      // when a branch doesn't assign it. `absentDefaultFor` walks the
      // present-types set and picks the right zero-value type for the
      // shared storage category (string → mtoc_string_empty();
      // char-array → empty handle; scalar char → '\0'; mixed or
      // numeric → 0.0). New kinds register a default once in
      // `types.ts` instead of editing this chain.
      const absentDefault: MType = absentDefaultFor(present);

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

  /** Accept a scalar real or scalar complex as a boolean condition.
   *  Used by `if` / `elseif` / `while` / `assert(cond)`. Complex
   *  conditions follow numbl's toBool rule
   *  (`creal(z) != 0 || cimag(z) != 0`), expanded by codegen at the
   *  `Unary Not` / cmp-or-logical / `mtoc_assert_*` site. */
  requireScalarCond(ty: MType, role: string, span: Span): void {
    if (!isScalarReal(ty) && !isScalarComplex(ty)) {
      throw new UnsupportedConstruct(
        `${role} must be a real or complex scalar (got ${typeToString(ty)})`,
        span
      );
    }
  }

  /** Lower a bare `Range` AST node (`a:b` / `a:s:b` used as a value,
   *  not as a for-loop iterable or index slot) into a `MakeRange` IR
   *  node. Matches numbl's `runtimeRange` semantics: result is a 1×n
   *  row vector of real doubles. `step` defaults to a literal `1`
   *  when the source omitted it. start / step / end must be scalar
   *  real expressions; complex / char ranges are deferred. */
  private lowerBareRange(e: Extract<Expr, { type: "Range" }>): IRExpr {
    const start = this.lowerExpr(e.start);
    const end = this.lowerExpr(e.end);
    this.requireScalarReal(start.ty, "range start", e.start.span);
    this.requireScalarReal(end.ty, "range end", e.end.span);
    let step: IRExpr;
    if (e.step === null) {
      step = {
        kind: "NumLit",
        value: 1,
        ty: scalarDouble("positive"),
        span: e.span,
      };
    } else {
      step = this.lowerExpr(e.step);
      this.requireScalarReal(step.ty, "range step", e.step.span);
    }
    const ty: NumericType = {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims: [{ kind: "one" }, { kind: "notOne" }],
      sign: "unknown",
    };
    return {
      kind: "MakeRange",
      start,
      step,
      end,
      ty,
      span: e.span,
    };
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
        // Cell-array literal RHS: consult the pre-pass shape decision
        // for the LHS to decide whether to lower as a tuple or
        // homogeneous cell. The pre-pass guarantees the LHS shape is
        // pinned for the variable's lifetime — `recordAssignment`'s
        // storage-category machinery then refuses a later assignment
        // that crosses category.
        let rhs: IRExpr;
        if (s.expr.type === "Cell") {
          const shape = this.cell.shapes.get(s.name);
          const shapeKind = shape?.kind ?? null;
          const expectedArity = shape?.kind === "tuple" ? shape.arity : null;
          rhs = lowerCellLiteral(this, s.expr, shapeKind, expectedArity);
        } else {
          rhs = this.lowerExpr(s.expr);
        }
        // If the RHS is a StructLit and the LHS is in the pre-pass
        // struct-shape map, widen the RHS to the full struct shape
        // for the variable (other fields stay as their previously-
        // recorded types, or scalarDouble("zero") as the absent
        // default). This way `s = struct('x', 1)` followed later by
        // `s.y = 2` both reference the same `Struct{x,y}` typedef.
        let rhsTy = rhs.ty;
        let assignRhs = rhs;
        // If the RHS is class-typed, register the LHS in the class
        // state so subsequent `s.<prop>` reads/writes find the
        // declared property set. This is the analog of the struct
        // pre-pass: for classes, the shape comes from `ClassInfo`,
        // not from a body-walking pre-pass, so the registration
        // happens here at assignment time. The flat property name
        // list comes from `rhsTy.properties` (already inheritance-
        // flattened by whatever produced this ClassType).
        if (isClass(rhsTy)) {
          const info = this.shared.workspace.ctx.getClassInfo(rhsTy.className);
          if (info !== null) {
            const flatProps = rhsTy.properties.map(p => p.name);
            this.class.registerRoot(s.name, info, flatProps);
            const propTypes = this.class.ensurePropertyTypes(s.name);
            for (const p of rhsTy.properties) {
              if (!propTypes.has(p.name)) propTypes.set(p.name, p.type);
            }
          }
        }
        if (rhs.kind === "StructLit" && this.struct.shapes.has(s.name)) {
          // Refresh the per-field tracking with the constructor's fields.
          const fieldTypes = this.struct.ensureFieldTypes(s.name);
          for (const f of rhs.fields) {
            fieldTypes.set(f.name, f.value.ty);
          }
          const fullTy = this.currentStructTypeFor(s.name);
          if (fullTy !== undefined && isStruct(fullTy)) {
            rhsTy = fullTy;
            // Reshape the StructLit to match the full struct type —
            // emit-time will translate it via a designated-init
            // compound literal, so missing-field defaults are filled
            // by C's `{}` zero rule.
            assignRhs = {
              ...rhs,
              ty: fullTy,
            };
          }
        }
        const cName = this.recordAssignment(s.name, rhsTy, s.span);
        return {
          kind: "Assign",
          name: s.name,
          cName,
          rhs: assignRhs,
          ty: rhsTy,
          span: s.span,
        };
      }

      case "AssignLValue": {
        // The parser produces this for any non-bare-identifier LHS:
        // `v(i) = x`, `obj.field = x`, `M(i,j) = x`, etc.
        if (s.lvalue.type === "Index") {
          // Range/colon slot routes to the slice-write path; otherwise
          // it's a scalar IndexStore.
          if (s.lvalue.indices.some(isSliceArg)) {
            return lowerIndexSliceStore.call(this, s.lvalue, s.expr, s.span);
          }
          return lowerIndexStore.call(this, s.lvalue, s.expr, s.span);
        }
        if (s.lvalue.type === "Member") {
          return lowerMemberStore.call(this, s.lvalue, s.expr, s.span);
        }
        if (s.lvalue.type === "IndexCell") {
          return lowerCellIndexStore(this, s.lvalue, s.expr, s.span);
        }
        throw new UnsupportedConstruct(
          `assignment to a ${s.lvalue.type} lvalue is not yet supported`,
          s.span
        );
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
        // A bare-Ident statement `tic;` / `toc;` parses as
        // `ExprStmt(Ident)`. numbl evaluates such an Ident as a no-arg
        // function call; mtoc forwards to the builtin's `lowerStmt`
        // hook with `args=[]` so the print-side-effect path runs (for
        // `toc;`) and a value-discarding ExprStmt is produced for
        // `tic;`.
        if (
          s.expr.type === "Ident" &&
          this.envLookup(s.expr.name) === undefined
        ) {
          const builtin = getBuiltin(s.expr.name);
          if (builtin?.lowerStmt) {
            const lowered = builtin.lowerStmt(this, [], s.span);
            if (lowered !== null) return lowered;
          }
        }
        if (s.expr.type === "FuncCall") {
          // Resolve to decide between the user-function `MultiAssignCall`
          // route (0-output / N≥2-output) and the regular expression
          // path. envLookup'd names (variable index) and builtins fall
          // through to the regular path; their dispatch happens inside
          // `lowerFuncCall`. Handle-bound names take a parallel route:
          // a 0/N-output handle call needs `MultiAssignCall` too, since
          // the underlying user function's C ABI is `void` + out-pointers.
          let userTarget: {
            ast: import("../workspace/workspace.js").FunctionStmt;
            file: string;
            callName: string;
          } | null = null;
          const envTy = this.envLookup(s.expr.name);
          if (envTy !== undefined && isHandle(envTy)) {
            const u = handleUserCallable(envTy, s.span);
            userTarget = { ast: u.ast, file: u.file, callName: u.name };
          } else if (envTy === undefined) {
            // Args not lowered yet; pass `[]`. See the parallel comment
            // in `lowerFuncCall.ts`.
            const target = this.shared.workspace.resolve(
              s.expr.name,
              [],
              this.callSite(),
              s.expr.span
            );
            if (target?.kind === "userFunction") {
              userTarget = {
                ast: target.ast,
                file: target.file,
                callName: target.name,
              };
            }
          }
          if (userTarget && userTarget.ast.outputs.length !== 1) {
            return lowerMultiAssignCall.call(
              this,
              userTarget.ast,
              userTarget.file,
              userTarget.callName,
              s.expr.args,
              [],
              s.span
            );
          }
          const builtin = getBuiltin(s.expr.name);
          if (builtin?.lowerStmt) {
            const lowered = builtin.lowerStmt(this, s.expr.args, s.span);
            if (lowered !== null) return lowered;
          }
        }
        const expr = this.lowerExpr(s.expr);
        // Owned-valued bare expression at statement scope (tensor /
        // string / char-array / struct / handle-with-captures): bind
        // the result to a synthetic `_mtoc_stmt_discard_<N>` so the
        // returned heap buffer has a name to take ownership of. The
        // discard binding lives in `assignedVars`, so the standard
        // scope-exit free walk releases it; the standard owned-LHS
        // `Assign` codegen consumes the producer's handle directly
        // (no extra copy). A bare `Var` of an owned name would deep-
        // copy, so short-circuit that to a value-discarding `ExprStmt`
        // — reading a Var has no side effect and no buffer to free.
        if (isOwned(expr.ty) && expr.kind !== "Var") {
          return this.synthesizeDiscardAssign(expr, s.span);
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
        // user function or a user-function-backed handle. Multi-
        // assigning a builtin (named or handle) isn't supported
        // because builtins are scalar return-by-value and have no
        // multi-output convention in mtoc today.
        if (s.expr.type !== "FuncCall") {
          throw new UnsupportedConstruct(
            `multi-assign right-hand side must be a user-function call`,
            s.span
          );
        }
        const envTy = this.envLookup(s.expr.name);
        if (envTy !== undefined && isHandle(envTy)) {
          const u = handleUserCallable(envTy, s.span);
          return lowerMultiAssignCall.call(
            this,
            u.ast,
            u.file,
            u.name,
            s.expr.args,
            s.lvalues,
            s.span
          );
        }
        // Args not lowered yet; pass `[]`. See parallel comment in
        // `lowerFuncCall.ts`.
        const target = this.shared.workspace.resolve(
          s.expr.name,
          [],
          this.callSite(),
          s.expr.span
        );
        if (target?.kind !== "userFunction") {
          throw new UnsupportedConstruct(
            `multi-assign of '${s.expr.name}' is not supported ` +
              `(only user-defined functions can appear on the right of ` +
              `\`[...] = ...\`)`,
            s.span
          );
        }
        return lowerMultiAssignCall.call(
          this,
          target.ast,
          target.file,
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
        const inner = decodeNumblQuotedLexeme(raw);
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
        const inner = decodeNumblQuotedLexeme(raw);
        if (inner.length === 0) {
          throw new UnsupportedConstruct(
            `empty char literal ('') is not yet supported ` +
              `(1×0 char arrays are deferred)`,
            e.span
          );
        }
        const n = inner.length;
        const cols: DimInfo = n === 1 ? { kind: "one" } : { kind: "notOne" };
        const ty: NumericType = n === 1 ? scalarChar() : charArrayType(cols);
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
        // numbl evaluates a bare identifier that isn't a variable or
        // constant as a no-arg call (interpreterExec.ts `case "Ident"` —
        // see `tic` / `toc` / `pi`-style names). mtoc dispatches the
        // same way for known no-arg builtins so `t = tic;` and `e = toc`
        // work alongside their parens form. Mismatched arity (e.g. bare
        // `sqrt`) surfaces at the builtin's own arity check with a
        // clearer message than "undefined variable".
        const builtin = getBuiltin(e.name);
        if (builtin && builtin.category === "expr") {
          return lowerBuiltinCall.call(this, e.name, [], e.span);
        }
        throw new TypeError(`use of undefined variable '${e.name}'`, e.span);
      }

      case "Binary":
        return lowerBinary.call(this, e);

      case "Unary":
        return lowerUnary.call(this, e);

      case "Tensor":
        return lowerTensorLiteral.call(this, e);

      case "Cell":
        // `{e1, …, eN}` literal in expression position (NOT the
        // direct RHS of an Assign — that case is handled in the
        // Assign arm of lowerStmt so we can consult the LHS's pre-
        // pass shape). Without a target binding, we have to decide
        // tuple-vs-homogeneous from the literal alone — homogeneous
        // when slot types unify, else reject.
        return lowerCellLiteral(this, e, null, null);

      case "IndexCell":
        return lowerCellIndexRead(this, e);

      case "FuncCall":
        // Special-case the `struct(...)` constructor before generic
        // function-call dispatch — it shouldn't go through the
        // builtin/user-function resolver (no such function exists in
        // the workspace).
        if (e.name === "struct" && this.envLookup(e.name) === undefined) {
          return lowerStructConstructor.call(this, e);
        }
        // Function-handle call: when `e.name` is bound to a
        // `HandleType` in the current env, dispatch through the
        // handle's resolved target instead of treating `e.name(args)`
        // as either a function call by name or an index expression.
        // This branch must precede `lowerFuncCall` since that helper
        // would otherwise route an env-bound name to `IndexLoad` /
        // `IndexSlice`.
        {
          const envTy = this.envLookup(e.name);
          if (envTy !== undefined && isHandle(envTy)) {
            return lowerHandleCall.call(this, e.name, envTy, e.args, e.span);
          }
        }
        return lowerFuncCall.call(this, e);

      case "FuncHandle":
        return lowerFuncHandle.call(this, e);

      case "AnonFunc":
        return lowerAnonFunc.call(this, e);

      case "Member":
        return lowerMemberRead.call(this, e);

      case "MemberDynamic":
        throw new UnsupportedConstruct(
          `dynamic field access ('s.(name)') is not yet supported`,
          e.span
        );

      case "MethodCall": {
        // The parser produces `MethodCall { base, name, args }` for
        // `obj.name(args)`. We try class-method dispatch first: if the
        // base lowers to a `ClassType`, route through
        // `lowerClassMethodCall`, which calls
        // `Workspace.resolveForTargetClass`. Otherwise fall through to
        // `lowerStructFieldIndex`, which handles the legacy
        // `<struct>.<tensorField>(<scalar indices>)` field-then-index
        // shape.
        if (e.base.type === "Ident") {
          const baseTy = this.envLookup(e.base.name);
          if (baseTy !== undefined && isClass(baseTy)) {
            const receiverIR: IRExpr = {
              kind: "Var",
              name: e.base.name,
              cName: this.currentCNameFor(e.base.name),
              ty: baseTy,
              span: e.base.span,
            };
            return lowerClassMethodCall.call(
              this,
              baseTy,
              receiverIR,
              e.name,
              e.args,
              e.span
            );
          }
        }
        return lowerStructFieldIndex.call(this, e);
      }

      case "Range":
        return this.lowerBareRange(e);

      case "SuperMethodCall":
        return lowerSuperCall.call(this, e);

      default:
        throw new UnsupportedConstruct(
          `unsupported expression: ${e.type}`,
          "span" in e ? e.span : null
        );
    }
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
      for (const slot of slice.index) {
        if (slot.kind === "Range") {
          rejectNestedOwnedExpr(slot.start);
          rejectNestedOwnedExpr(slot.step);
          rejectNestedOwnedExpr(slot.end);
        } else if (slot.kind === "Scalar") {
          rejectNestedOwnedExpr(slot.expr);
        }
      }
    } else if (top === "make-range") {
      const r = s.rhs as Extract<IRExpr, { kind: "MakeRange" }>;
      rejectNestedOwnedExpr(r.start);
      rejectNestedOwnedExpr(r.step);
      rejectNestedOwnedExpr(r.end);
    } else if (top === "user-call" || top === "builtin-call") {
      const call = s.rhs as Extract<IRExpr, { kind: "Call" }>;
      for (const a of call.args) rejectNestedOwnedExpr(a);
    } else if (top === "struct-lit") {
      const lit = s.rhs as Extract<IRExpr, { kind: "StructLit" }>;
      for (const f of lit.fields) rejectNestedOwnedExpr(f.value);
    } else if (top === "cell-lit") {
      const lit = s.rhs as Extract<IRExpr, { kind: "CellLit" }>;
      for (const el of lit.elements) rejectNestedOwnedExpr(el);
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
  const functionStmts: Extract<Stmt, { type: "Function" }>[] = [];
  for (const s of ast.body) {
    if (s.type === "Function") {
      workspace.registerLocalFunction(s);
      functionStmts.push(s);
    } else if (s.type === "ClassDef") {
      // Local class: register on the vendored ctx so the resolver
      // sees it. The actual class lowering (constructor / method
      // specialization) happens lazily when a call to the class
      // resolves through Workspace.resolve. Local classdefs don't
      // emit any direct IR — they're metadata for the resolver.
      workspace.ctx.registerLocalClass(s);
    } else if (s.type === "Import") {
      throw new UnsupportedConstruct(
        `'import' statements are not yet supported by mtoc`,
        "span" in s ? s.span : null
      );
    } else {
      scriptBody.push(s);
    }
  }

  // Build the function index now that main-file locals are registered
  // and every workspace file has been added. Resolution and
  // specialization below both depend on this.
  workspace.finalize();

  // Function-file mode: a .m file with only function definitions and
  // no top-level script body is treated as if the first function were
  // the script entry. Mirrors numbl, which calls the first function
  // with zero args and zero outputs. The function stays registered
  // for cross-calls; its body is duplicated into the script position.
  let bodyToLower: Stmt[] = scriptBody;
  if (scriptBody.length === 0 && functionStmts.length > 0) {
    const entry = functionStmts[0];
    if (entry.params.length > 0) {
      throw new UnsupportedConstruct(
        `function '${entry.name}' is used as the script entry but has ` +
          `parameters; mtoc cannot supply arguments when running a ` +
          `function-only file`,
        entry.span
      );
    }
    bodyToLower = entry.body;
  }

  const shared: SharedSpecState = {
    workspace,
    cache: new Map(),
    order: [],
    inFlight: new Set(),
    anonCounter: { value: 0 },
  };
  const top = new Lowerer(shared);
  top.primeStructShapes(bodyToLower);
  top.primeCellShapes(bodyToLower);
  const stmts = top.lowerStmts(bodyToLower);
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
  // Normalize struct-typed IR nodes so every reference to the same
  // variable carries the final (post-widening) type. Without this,
  // intermediate widening states leak into the IR and the codegen
  // emits multiple distinct typedefs for the same logical variable.
  normalizeStructTypes(prog);
  validateIR(prog);
  return prog;
}
