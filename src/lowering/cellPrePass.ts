/**
 * Pre-pass that walks a function/script body before lowering and
 * decides, per root variable that ever appears as a cell, whether it
 * should be lowered as a `TupleCellType` (fixed-shape, heterogeneous
 * slots, all-constant-index access) or a `HomogeneousCellType`
 * (variable-length, uniform element type).
 *
 * The output is consumed by the main lowering pass: when the lowerer
 * encounters the first cell-shape assignment (`c = {…}`) or
 * curly-index write (`c{k} = …`) for a variable, it already knows
 * whether the variable's static type is a tuple-cell or a homogeneous-
 * cell. That decision pins the C typedef once for the variable's
 * lifetime — same "one shape per binding" guarantee structs and
 * tensors give.
 *
 * v1 decision rules:
 *
 *  - "Cell-pattern" assignments for a root variable include:
 *      • `c = { e1, …, eN }`   — literal cell-array constructor
 *      • `c{i} = rhs`          — curly-index write
 *      • `c = cell(n)` / `c = cell(1, n)` (deferred; not v1)
 *
 *  - A root is **homogeneous** when ANY of:
 *      • Some `c{i} = …` write uses a non-NumLit index, OR
 *      • Some `c{i}` read appears with a non-NumLit index, OR
 *      • An empty `c = {}` literal appears anywhere
 *
 *  - Otherwise the root is **tuple**:
 *      • Every cell literal has the same arity N
 *      • Every curly-index read/write uses a NumLit index in [1, N]
 *
 *  The tuple-vs-homogeneous question is purely an access-pattern call.
 *  The per-slot vs per-elem MType inference happens at lowering — the
 *  pre-pass only commits to the shape category.
 *
 * Pre-pass rejections (raised here with a span):
 *
 *  - "Branch-divergent cell arity / category" — different arms of an
 *    if/elseif/else assign cell shapes that don't reconcile (different
 *    arities in tuple mode, or one arm tuple and another homogeneous).
 *
 *  - "Cell literal arity mismatch across reassignments" inside the
 *    same flat scope when the per-root shape says tuple — caught here
 *    so the user sees a span before the lowerer's storage-category
 *    machinery does.
 *
 *  - "Tuple-cell write with non-literal index" inside a body where
 *    the access pattern would otherwise classify as tuple but a single
 *    `c{i} = …` with a variable index forces homogeneity. The pre-
 *    pass marks the root homogeneous instead of erroring; the
 *    cross-slot-type compatibility check fires at lowering.
 */

import type { Expr, LValue, Span, Stmt } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";

/** What the pre-pass decided per root variable. The lowering pass
 *  consults this to know which cell variant to construct on the first
 *  cell-shape assignment. */
export type CellShape =
  | {
      /** Fixed-shape heterogeneous cell. */
      kind: "tuple";
      /** Common slot count across every literal / index reference. */
      arity: number;
      /** Span of the first cell pattern that pinned the shape — used
       *  in diagnostics for divergent-arity errors. */
      firstSpan: Span;
    }
  | {
      /** Variable-length homogeneous cell. */
      kind: "homogeneous";
      /** Span of the first cell pattern that pinned the shape. */
      firstSpan: Span;
    };

/** Output of the pre-pass: variable name → its decided cell shape.
 *  Variables that never appear in a cell-shape context don't appear
 *  in the map. */
export type CellShapeMap = Map<string, CellShape>;

/** Walk every top-level stmt in `body` and accumulate a cell-shape
 *  decision for each variable that ever appears in a cell context. */
export function collectCellShapes(body: ReadonlyArray<Stmt>): CellShapeMap {
  // Observations are accumulated first; the final shape is decided in
  // one pass at the end so the "any non-literal index → homogeneous"
  // rule can be applied globally regardless of statement order.
  const obs = new Map<string, CellObservations>();
  walkStmtsFlat(body, obs, []);
  return finalize(obs);
}

interface CellObservations {
  /** Each `c = {…}` literal's slot count (and source span). */
  literalArities: Array<{ arity: number; span: Span }>;
  /** True iff `c = {}` ever appears. */
  hasEmptyLiteral: boolean;
  /** Each curly-brace access's literal index (1-based), if known. */
  literalIndices: number[];
  /** True iff any curly-brace access used a non-NumLit index. */
  hasNonLitIndex: boolean;
  /** Span of the first cell pattern that established a shape. */
  firstSpan: Span;
  /** For each control-flow merge, the per-arm observations are
   *  collected separately and reconciled at the merge point. The flat
   *  walker handles the simple case; branch-arms are walked in
   *  parallel and reconciled by `mergeArms`. */
}

function newObs(span: Span): CellObservations {
  return {
    literalArities: [],
    hasEmptyLiteral: false,
    literalIndices: [],
    hasNonLitIndex: false,
    firstSpan: span,
  };
}

function ensureObs(
  obs: Map<string, CellObservations>,
  name: string,
  span: Span
): CellObservations {
  let e = obs.get(name);
  if (e === undefined) {
    e = newObs(span);
    obs.set(name, e);
  }
  return e;
}

/** Statement-level walker. The optional `armObs` parameter is non-empty
 *  inside an if/elseif/else arm and receives parallel observations the
 *  caller will reconcile at the join. The flat call passes the outer
 *  obs map directly. */
function walkStmtsFlat(
  stmts: ReadonlyArray<Stmt>,
  obs: Map<string, CellObservations>,
  _armPath: ReadonlyArray<string>
): void {
  for (const s of stmts) walkStmt(s, obs, _armPath);
}

function walkStmt(
  s: Stmt,
  obs: Map<string, CellObservations>,
  armPath: ReadonlyArray<string>
): void {
  switch (s.type) {
    case "Assign": {
      // `c = { … }` is the only Assign shape we care about for cell
      // pre-pass purposes. Every other RHS shape leaves the cell
      // observations alone; the storage-category check at lowering
      // time catches any mix.
      if (s.expr.type === "Cell") {
        const arity = countCellArity(s.expr);
        const o = ensureObs(obs, s.name, s.span);
        if (arity === 0) o.hasEmptyLiteral = true;
        else o.literalArities.push({ arity, span: s.span });
      }
      // Recurse into the RHS to catch cell literals or curly-index
      // reads nested in larger expressions (e.g. `disp(c{1})`).
      observeExpr(s.expr, obs);
      return;
    }
    case "AssignLValue": {
      // `c{i} = rhs` is the curly-index write shape.
      if (s.lvalue.type === "IndexCell") {
        if (s.lvalue.base.type !== "Ident") {
          throw new UnsupportedConstruct(
            `curly-brace assignment with a non-variable base is not yet ` +
              `supported by mtoc`,
            s.span
          );
        }
        if (s.lvalue.indices.length !== 1) {
          throw new UnsupportedConstruct(
            `curly-brace assignment with ${s.lvalue.indices.length} indices is ` +
              `not yet supported (mtoc supports 1-D cell arrays only)`,
            s.span
          );
        }
        const root = s.lvalue.base.name;
        const o = ensureObs(obs, root, s.span);
        const idxExpr = s.lvalue.indices[0];
        if (idxExpr.type === "Number") {
          const n = Number(idxExpr.value);
          if (!Number.isInteger(n) || n < 1) {
            throw new UnsupportedConstruct(
              `cell curly-index '${root}{${idxExpr.value}}' must be a ` +
                `positive integer literal`,
              idxExpr.span
            );
          }
          o.literalIndices.push(n);
        } else {
          o.hasNonLitIndex = true;
        }
        observeExpr(s.expr, obs);
        return;
      }
      // Member / Index lvalues: just recurse to catch nested cells.
      observeLValue(s.lvalue, obs);
      observeExpr(s.expr, obs);
      return;
    }
    case "ExprStmt":
      observeExpr(s.expr, obs);
      return;
    case "If": {
      observeExpr(s.cond, obs);
      // Per-arm observations: walk each arm into a fresh map, then
      // reconcile at the join. A root that appears in only some arms
      // must agree on shape category (tuple-vs-homogeneous) across
      // every arm where it appears; arms that don't touch the root
      // are neutral.
      const armMaps: Map<string, CellObservations>[] = [];
      const a0: Map<string, CellObservations> = new Map();
      walkStmtsFlat(s.thenBody, a0, armPath);
      armMaps.push(a0);
      for (const eif of s.elseifBlocks) {
        observeExpr(eif.cond, obs);
        const ai: Map<string, CellObservations> = new Map();
        walkStmtsFlat(eif.body, ai, armPath);
        armMaps.push(ai);
      }
      if (s.elseBody !== null) {
        const am: Map<string, CellObservations> = new Map();
        walkStmtsFlat(s.elseBody, am, armPath);
        armMaps.push(am);
      }
      mergeArmObs(obs, armMaps, s.span);
      return;
    }
    case "While":
      observeExpr(s.cond, obs);
      walkStmtsFlat(s.body, obs, armPath);
      return;
    case "For":
      observeExpr(s.expr, obs);
      walkStmtsFlat(s.body, obs, armPath);
      return;
    case "MultiAssign":
      observeExpr(s.expr, obs);
      for (const lv of s.lvalues) {
        if (lv.type !== "Ignore") observeLValue(lv, obs);
      }
      return;
    case "Function":
    case "Break":
    case "Continue":
    case "Return":
    case "Global":
    case "Persistent":
    case "Import":
    case "ClassDef":
    case "Directive":
    case "Synth":
    case "Switch":
    case "TryCatch":
      return;
  }
}

/** Recurse into an expression and observe curly-brace reads. Used to
 *  catch `disp(c{1})` and similar where the cell access is nested. */
function observeExpr(e: Expr, obs: Map<string, CellObservations>): void {
  switch (e.type) {
    case "IndexCell": {
      // Only record curly-index access on an Ident base — `f(){i}` is
      // not in v1 anyway, and the lowerer will reject it.
      if (e.base.type === "Ident" && e.indices.length === 1) {
        const root = e.base.name;
        const o = ensureObs(obs, root, e.span);
        const idxExpr = e.indices[0];
        if (idxExpr.type === "Number") {
          const n = Number(idxExpr.value);
          if (Number.isInteger(n) && n >= 1) o.literalIndices.push(n);
          else o.hasNonLitIndex = true;
        } else {
          o.hasNonLitIndex = true;
        }
      }
      // Recurse into the base + each index expression.
      observeExpr(e.base, obs);
      for (const ix of e.indices) observeExpr(ix, obs);
      return;
    }
    case "Cell": {
      // A cell literal in expression position (not as an Assign RHS)
      // isn't bound to a name yet — no observations to record. Still
      // recurse into its elements to catch nested cells.
      for (const row of e.rows) for (const cell of row) observeExpr(cell, obs);
      return;
    }
    case "Number":
    case "String":
    case "Char":
    case "Ident":
    case "EndKeyword":
    case "ImagUnit":
    case "Colon":
    case "MetaClass":
    case "FuncHandle":
      return;
    case "Binary":
      observeExpr(e.left, obs);
      observeExpr(e.right, obs);
      return;
    case "Unary":
      observeExpr(e.operand, obs);
      return;
    case "Range":
      observeExpr(e.start, obs);
      if (e.step !== null) observeExpr(e.step, obs);
      observeExpr(e.end, obs);
      return;
    case "FuncCall":
      for (const a of e.args) observeExpr(a, obs);
      return;
    case "Index":
      observeExpr(e.base, obs);
      for (const ix of e.indices) observeExpr(ix, obs);
      return;
    case "Member":
      observeExpr(e.base, obs);
      return;
    case "MemberDynamic":
      observeExpr(e.base, obs);
      observeExpr(e.nameExpr, obs);
      return;
    case "MethodCall":
      observeExpr(e.base, obs);
      for (const a of e.args) observeExpr(a, obs);
      return;
    case "SuperMethodCall":
      for (const a of e.args) observeExpr(a, obs);
      return;
    case "AnonFunc":
      observeExpr(e.body, obs);
      return;
    case "Tensor":
      for (const row of e.rows) for (const cell of row) observeExpr(cell, obs);
      return;
    case "ClassInstantiation":
      for (const a of e.args) observeExpr(a, obs);
      return;
  }
}

function observeLValue(lv: LValue, obs: Map<string, CellObservations>): void {
  switch (lv.type) {
    case "Var":
    case "Ignore":
      return;
    case "Index":
      observeExpr(lv.base, obs);
      for (const ix of lv.indices) observeExpr(ix, obs);
      return;
    case "IndexCell":
      observeExpr(lv.base, obs);
      for (const ix of lv.indices) observeExpr(ix, obs);
      return;
    case "Member":
      observeExpr(lv.base, obs);
      return;
    case "MemberDynamic":
      observeExpr(lv.base, obs);
      observeExpr(lv.nameExpr, obs);
      return;
  }
}

function countCellArity(c: Extract<Expr, { type: "Cell" }>): number {
  // v1: 1-D cells only. mtoc rejects multi-row cell literals at
  // lowering with a clearer message; here we just count the total
  // element count which equals row 0's length for a 1-row literal.
  if (c.rows.length === 0) return 0;
  let total = 0;
  for (const row of c.rows) total += row.length;
  return total;
}

/** Merge per-arm observations back into `target`. The rule:
 *    - A root in `target` with no arm observations stays unchanged.
 *    - A root touched by any arm acquires the union of arm
 *      observations, which the final `finalize` pass resolves into
 *      tuple-vs-homogeneous via the same per-root rules.
 *    - If two arms produce literal-arity sets that can't share a
 *      tuple shape (different non-zero arities AND no non-literal
 *      index in either arm), reject here with a span — the user has
 *      to hoist or rename.
 */
function mergeArmObs(
  target: Map<string, CellObservations>,
  armMaps: ReadonlyArray<Map<string, CellObservations>>,
  span: Span
): void {
  const allRoots = new Set<string>();
  for (const m of armMaps) for (const k of m.keys()) allRoots.add(k);
  for (const root of allRoots) {
    const tgt = ensureObs(target, root, span);
    for (const m of armMaps) {
      const a = m.get(root);
      if (a === undefined) continue;
      for (const { arity, span: s } of a.literalArities) {
        tgt.literalArities.push({ arity, span: s });
      }
      if (a.hasEmptyLiteral) tgt.hasEmptyLiteral = true;
      for (const i of a.literalIndices) tgt.literalIndices.push(i);
      if (a.hasNonLitIndex) tgt.hasNonLitIndex = true;
    }
  }
}

/** Resolve every collected observation into a concrete tuple-vs-
 *  homogeneous shape per root. The decision rules:
 *
 *    - Any non-literal curly-index access → homogeneous
 *    - Any empty `c = {}` literal           → homogeneous
 *    - Otherwise tuple, with arity = the unique non-zero literal
 *      arity. Conflicting non-zero arities or out-of-range literal
 *      indices raise UnsupportedConstruct here.
 */
function finalize(obs: Map<string, CellObservations>): CellShapeMap {
  const out: CellShapeMap = new Map();
  for (const [root, o] of obs) {
    // No literal cell-array context at all (only a curly-index access,
    // for example): still treat as homogeneous if the access existed.
    const hasAnyContext =
      o.literalArities.length > 0 ||
      o.hasEmptyLiteral ||
      o.literalIndices.length > 0 ||
      o.hasNonLitIndex;
    if (!hasAnyContext) continue;

    if (o.hasNonLitIndex || o.hasEmptyLiteral) {
      out.set(root, { kind: "homogeneous", firstSpan: o.firstSpan });
      continue;
    }
    // Pure tuple path. Every literal arity must agree.
    if (o.literalArities.length === 0) {
      // Only curly-index accesses appeared, no literal. Treat as
      // homogeneous — we have no static arity to fix the tuple shape
      // to (a literal write like `c{1} = …` against an undeclared
      // root won't reach this branch because we'd need either a
      // literal or empty literal to make sense of it, but a sibling
      // statement might have established the root some other way).
      out.set(root, { kind: "homogeneous", firstSpan: o.firstSpan });
      continue;
    }
    const arity = o.literalArities[0].arity;
    for (const a of o.literalArities) {
      if (a.arity !== arity) {
        throw new UnsupportedConstruct(
          `'${root}' is assigned cell literals of different arities ` +
            `(${arity} vs ${a.arity}); mtoc requires a tuple cell to keep ` +
            `one arity across the variable's lifetime, or use homogeneous-` +
            `cell access (variable index) to admit length changes`,
          a.span
        );
      }
    }
    for (const i of o.literalIndices) {
      if (i > arity) {
        throw new UnsupportedConstruct(
          `tuple cell '${root}' has arity ${arity} but a slot index ${i} is ` +
            `referenced; either keep all indices in [1, ${arity}] or use ` +
            `a variable index to opt into homogeneous-cell semantics`,
          o.firstSpan
        );
      }
    }
    out.set(root, { kind: "tuple", arity, firstSpan: o.firstSpan });
  }
  return out;
}
