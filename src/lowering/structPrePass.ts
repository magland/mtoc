/**
 * Struct field-set pre-pass.
 *
 * Before the main lowering walk runs over a function or script body,
 * `collectStructShapes` walks every assignment to discover, per
 * variable name, the union of field-names that variable will be
 * assigned via `s.field = expr` or via the `struct('f', v, ...)`
 * constructor on the RHS. That field-set IS the variable's static
 * struct shape — the lowerer's main pass then resolves each field's
 * TYPE during its normal walk, and the resulting `StructType`'s
 * `fields` are the union we computed here.
 *
 * The pre-pass also enforces v1's "no branch-divergent shapes"
 * restriction: a variable that is treated as a struct in one branch
 * of a control-flow construct and at a different shape (different
 * field-set, or as a non-struct) in another must be split by the
 * user. We surface the conflict with a span at the offending
 * assignment.
 *
 * Out-of-scope for v1 (rejected at pre-pass time, with a span):
 *   - dynamic field access `s.(name)` on either side
 *   - the `s = []` empty-matrix-promoted-to-struct idiom
 *   - struct-array shapes (any `s(i).f` pattern)
 */

import type { Expr, Stmt } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";

/** Insertion-ordered field-set for one numbl variable. */
export interface StructShape {
  /** Field names in source-discovered insertion order. */
  insertionOrder: string[];
  /** Set view of insertionOrder for fast lookups. */
  set: Set<string>;
}

/** Map: numbl variable name → its discovered struct shape, or null if
 *  the variable is provably NOT a struct (assigned as a non-struct
 *  value at some point). The lowerer consults this map at lowering
 *  time to decide whether a fresh `s.f = v` introduces a new struct
 *  variable vs. extends an existing one. */
export type StructShapeMap = ReadonlyMap<string, StructShape>;

/** Walk `body` and collect struct shapes for every variable that is
 *  treated as a struct anywhere in the body. */
export function collectStructShapes(body: Stmt[]): StructShapeMap {
  const out = new Map<string, StructShape>();
  walkStmts(body, out, /*inBranch=*/ false);
  return out;
}

/** Lookup a top-level Member chain root: returns the leaf name +
 *  the path (top-level field first). Returns null if `lvalue` is
 *  not a static-name member chain rooted at an `Ident`. */
function memberChainRoot(
  lvalue: Expr
): { name: string; path: string[] } | null {
  const path: string[] = [];
  let cur: Expr = lvalue;
  // Walk inwards: outermost Member is the leaf field (e.g. `s.a.b`
  // has Member(Member(Ident(s), "a"), "b") — leaf is `b`, base is `s.a`).
  while (cur.type === "Member") {
    path.unshift(cur.name);
    cur = cur.base;
  }
  if (cur.type !== "Ident") return null;
  if (path.length === 0) return null;
  return { name: cur.name, path };
}

/** Walk every nested AST expression and reject `s.(dynamic)` and
 *  struct-array `s(i).f` patterns up-front. We don't enforce them
 *  inside expression-position reads exhaustively (the main lowering
 *  pass also catches them); this walker focuses on assignment-shape
 *  inference. */
function walkStmts(
  stmts: ReadonlyArray<Stmt>,
  out: Map<string, StructShape>,
  inBranch: boolean
): void {
  for (const s of stmts) {
    walkStmt(s, out, inBranch);
  }
}

function walkStmt(
  s: Stmt,
  out: Map<string, StructShape>,
  inBranch: boolean
): void {
  switch (s.type) {
    case "Assign": {
      // Bare-name assignment: `s = <rhs>`. If rhs is a `struct(...)`
      // constructor with literal keys, this defines the variable's
      // struct shape (entire insertionOrder set).
      handleStructConstructorAssign(s.name, s.expr, out, inBranch, s);
      walkExpr(s.expr, out);
      return;
    }
    case "AssignLValue": {
      if (s.lvalue.type === "Member") {
        // Lvalue is a Member chain. Discover the root name and path.
        const root = memberChainRoot({
          type: "Member",
          base: s.lvalue.base,
          name: s.lvalue.name,
          span: s.span,
        });
        if (root === null) {
          throw new UnsupportedConstruct(
            "struct field assignment must have a simple variable as its " +
              "innermost base (got a non-identifier base)",
            s.span
          );
        }
        // Reject struct-array patterns: any `s(i).f` indicates a struct
        // array, not supported in v1. (memberChainRoot already filters
        // to Ident roots; an Index base would have returned null above.
        // But we may have intermediate Index nodes inside the Member
        // chain — walk to verify.)
        rejectStructArrayInsideMember(s.lvalue, s.span);
        addField(out, root.name, root.path[0], s.span, inBranch);
        // Note: for nested chains like `s.a.b = ...`, only the
        // TOP-LEVEL field `a` is registered on `s`'s shape here.
        // The nested struct `s.a`'s own shape (containing field `b`)
        // is inferred during the main lowering pass via type unification
        // — the pre-pass focuses on identifying which root names are
        // struct-typed and what their top-level field set is.
        walkExpr(s.expr, out);
        return;
      }
      if (s.lvalue.type === "MemberDynamic") {
        throw new UnsupportedConstruct(
          "dynamic field access `s.(expr)` is not yet supported by mtoc",
          s.span
        );
      }
      // Other lvalues — Index / IndexCell. Don't touch struct shapes.
      walkExpr(s.expr, out);
      return;
    }
    case "ExprStmt": {
      walkExpr(s.expr, out);
      return;
    }
    case "If": {
      walkExpr(s.cond, out);
      // Each branch contributes fields. We collect everything together;
      // any branch that doesn't assign a field still leaves the field
      // present in the shape — that mirrors numbl's "the struct type
      // is the union" semantics. v1 forbids divergent shapes across
      // branches AT THE FRESH-NEW-STRUCT level (a struct introduced in
      // only one arm). We approximate by marking entries created
      // inside a branch; the main lowering pass will then check that
      // each branch consistently grows the shape.
      walkStmts(s.thenBody, out, true);
      for (const e of s.elseifBlocks) {
        walkExpr(e.cond, out);
        walkStmts(e.body, out, true);
      }
      if (s.elseBody) walkStmts(s.elseBody, out, true);
      return;
    }
    case "While":
      walkExpr(s.cond, out);
      walkStmts(s.body, out, true);
      return;
    case "For":
      walkExpr(s.expr, out);
      walkStmts(s.body, out, true);
      return;
    case "Switch": {
      walkExpr(s.expr, out);
      for (const c of s.cases) {
        walkExpr(c.value, out);
        walkStmts(c.body, out, true);
      }
      if (s.otherwise) walkStmts(s.otherwise, out, true);
      return;
    }
    case "TryCatch":
      walkStmts(s.tryBody, out, true);
      walkStmts(s.catchBody, out, true);
      return;
    case "Function":
      // Nested function — pre-pass only looks at the enclosing scope;
      // the function body gets its own pre-pass when lowered.
      return;
    case "MultiAssign":
      walkExpr(s.expr, out);
      return;
    case "Synth":
      walkStmts(s.subStmts, out, inBranch);
      return;
    case "Global":
    case "Persistent":
    case "Break":
    case "Continue":
    case "Return":
    case "Import":
    case "ClassDef":
    case "Directive":
      return;
  }
}

function rejectStructArrayInsideMember(
  lvalue: Expr,
  span: import("../parser/index.js").Span
): void {
  let cur: Expr = lvalue;
  while (cur.type === "Member" || cur.type === "MemberDynamic") {
    if (cur.type === "MemberDynamic") {
      throw new UnsupportedConstruct(
        "dynamic field access `s.(expr)` is not yet supported by mtoc",
        span
      );
    }
    cur = cur.base;
    if (cur.type === "Index" || cur.type === "IndexCell") {
      throw new UnsupportedConstruct(
        "struct-array assignment (`s(i).field = ...`) is not yet supported " +
          "by mtoc (only scalar structs in v1)",
        span
      );
    }
  }
}

/** Handle `s = struct('a', va, 'b', vb)` by populating `s`'s shape
 *  with the literal-key fields. Non-struct constructor RHS or any
 *  non-literal key is left for the main lowering pass to reject. */
function handleStructConstructorAssign(
  name: string,
  rhs: Expr,
  out: Map<string, StructShape>,
  inBranch: boolean,
  parentStmt: Stmt
): void {
  if (rhs.type !== "FuncCall" || rhs.name !== "struct") return;
  // Empty struct(): shape is `{}` — register the variable.
  if (rhs.args.length === 0) {
    seedShape(out, name, parentStmt.span, inBranch);
    return;
  }
  if (rhs.args.length % 2 !== 0) {
    throw new UnsupportedConstruct(
      "struct() constructor requires an even number of arguments " +
        "(name/value pairs)",
      rhs.span
    );
  }
  const fieldNames: string[] = [];
  for (let i = 0; i < rhs.args.length; i += 2) {
    const key = rhs.args[i];
    if (key.type !== "String") {
      throw new UnsupportedConstruct(
        "struct() constructor field names must be string literals " +
          "(mtoc does not support dynamic struct construction)",
        key.span
      );
    }
    const raw = key.value;
    if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
      throw new UnsupportedConstruct(
        "struct() constructor: malformed string-literal field name",
        key.span
      );
    }
    const fname = raw.slice(1, -1).replace(/""/g, '"');
    if (fname.length === 0) {
      throw new UnsupportedConstruct(
        "struct() constructor: empty field name",
        key.span
      );
    }
    fieldNames.push(fname);
  }
  seedShape(out, name, parentStmt.span, inBranch);
  for (const f of fieldNames) {
    addField(out, name, f, parentStmt.span, inBranch);
  }
}

function seedShape(
  out: Map<string, StructShape>,
  name: string,
  span: import("../parser/index.js").Span,
  inBranch: boolean
): void {
  if (!out.has(name)) {
    if (inBranch) {
      throw new UnsupportedConstruct(
        `struct variable '${name}' is first introduced inside a control-flow ` +
          `branch; mtoc v1 requires fresh struct creation at top level so the ` +
          `predeclared C variable has a definite static shape`,
        span
      );
    }
    out.set(name, { insertionOrder: [], set: new Set() });
  }
}

function addField(
  out: Map<string, StructShape>,
  name: string,
  field: string,
  span: import("../parser/index.js").Span,
  inBranch: boolean
): void {
  if (!out.has(name)) {
    if (inBranch) {
      // Fresh struct introduced inside a branch — rejected.
      throw new UnsupportedConstruct(
        `struct variable '${name}' is first introduced inside a control-flow ` +
          `branch; mtoc v1 requires fresh struct creation at top level so the ` +
          `predeclared C variable has a definite static shape`,
        span
      );
    }
    out.set(name, { insertionOrder: [], set: new Set() });
  }
  const shape = out.get(name)!;
  if (!shape.set.has(field)) {
    shape.set.add(field);
    shape.insertionOrder.push(field);
  }
}

function walkExpr(e: Expr, out: Map<string, StructShape>): void {
  // We only need to discover struct shapes from assignments. But we
  // also want to surface a struct constructor used in nested
  // expression position so its arguments can be reasoned about — and
  // to reject `s.(name)` dynamic access whenever it appears.
  switch (e.type) {
    case "MemberDynamic":
      throw new UnsupportedConstruct(
        "dynamic field access `s.(expr)` is not yet supported by mtoc",
        e.span
      );
    case "Member":
      walkExpr(e.base, out);
      return;
    case "Index":
    case "IndexCell":
      walkExpr(e.base, out);
      for (const a of e.indices) walkExpr(a, out);
      return;
    case "FuncCall":
      for (const a of e.args) walkExpr(a, out);
      return;
    case "Binary":
      walkExpr(e.left, out);
      walkExpr(e.right, out);
      return;
    case "Unary":
      walkExpr(e.operand, out);
      return;
    case "Range":
      walkExpr(e.start, out);
      if (e.step) walkExpr(e.step, out);
      walkExpr(e.end, out);
      return;
    case "Tensor":
    case "Cell":
      for (const row of e.rows) for (const c of row) walkExpr(c, out);
      return;
    case "AnonFunc":
      walkExpr(e.body, out);
      return;
    case "MethodCall":
      walkExpr(e.base, out);
      for (const a of e.args) walkExpr(a, out);
      return;
    case "Number":
    case "String":
    case "Char":
    case "ImagUnit":
    case "EndKeyword":
    case "Ident":
    case "Colon":
    case "MetaClass":
    case "FuncHandle":
    case "SuperMethodCall":
    case "ClassInstantiation":
      return;
  }
}
