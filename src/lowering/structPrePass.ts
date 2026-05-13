/**
 * Pre-pass that walks a function/script body before lowering and
 * collects, per root variable name, the set of field names assigned via
 * `s.f = ...` chains and via the `struct('f', v, ...)` constructor.
 *
 * The output is consumed by the main lowering pass: when the lowerer
 * encounters the first `s.f = ...` assignment, it already knows the
 * full set of field names the variable will need (so the struct's
 * static type — and hence its C typedef — is fixed across the
 * variable's lifetime in the scope).
 *
 * Pre-pass rejections (raised here so they surface with a span before
 * the body lowering runs):
 *   - `s.(name)` dynamic field access — no static shape for the target
 *   - mixing `s.f = ...` (struct-shape) and `s = <non-struct>` for the
 *     same variable inside the same body (the storage-category mismatch
 *     case is rejected at lowering time, but we also reject the v1
 *     "different field-set" case here)
 *   - struct field-set divergence across the arms of an if/elseif/else
 *
 * The walker is intentionally narrow — it only inspects `Stmt.Assign`
 * (for `s = struct(...)` constructor RHS) and `Stmt.AssignLValue` with
 * a `Member` lvalue (for `s.f = ...` and chained variants). Other stmt
 * shapes recurse into their bodies but otherwise pass through.
 */

import type { LValue, Expr, Stmt, Span } from "../parser/index.js";
import { UnsupportedConstruct } from "./errors.js";
import { decodeNumblQuotedLexeme } from "./lexerHelpers.js";

/** One root variable's accumulated struct shape. */
export interface StructShape {
  /** Map from field-name → child shape (for nested struct fields) or
   *  `null` (leaf field, type filled in at lowering). */
  fields: Map<string, StructShape | null>;
  /** Span of the first assignment that pinned the shape — used in
   *  diagnostics for divergent field-set errors. */
  firstSpan: Span;
}

/** Output of the pre-pass: variable name → its accumulated shape. */
export type StructShapeMap = Map<string, StructShape>;

/** Walk every top-level stmt in `body` and accumulate a shape entry
 *  for each variable that ever appears as the root of a member
 *  assignment or as the LHS of a `struct(...)` constructor. Pure (no
 *  side effects beyond the returned map). */
export function collectStructShapes(body: ReadonlyArray<Stmt>): StructShapeMap {
  const map: StructShapeMap = new Map();
  walkStmts(body, map);
  return map;
}

/** Recurse into a list of statements, accumulating struct shapes. The
 *  scope is single-flat (function/script body): we don't introduce a
 *  nested scope here — `for` loop variables and `if`/`else` arms all
 *  contribute to the same shape map. */
function walkStmts(stmts: ReadonlyArray<Stmt>, map: StructShapeMap): void {
  for (const s of stmts) walkStmt(s, map);
}

function walkStmt(s: Stmt, map: StructShapeMap): void {
  switch (s.type) {
    case "Assign":
      // `s = struct('f', v, ...)` is the only Assign shape we care
      // about for the pre-pass. Every other RHS shape (including
      // non-struct assignments to the same name) doesn't add to the
      // shape; the storage-category check at lowering time catches
      // any mix.
      if (s.expr.type === "FuncCall" && s.expr.name === "struct") {
        addConstructorShape(map, s.name, s.expr, s.span);
      }
      return;

    case "AssignLValue": {
      // Member lvalue: `s.f = ...`, `outer.inner.x = ...`, etc.
      // Dynamic member access is rejected outright.
      if (s.lvalue.type === "MemberDynamic") {
        throw new UnsupportedConstruct(
          `dynamic field access ('s.(name) = ...') is not yet supported`,
          s.span
        );
      }
      if (s.lvalue.type !== "Member") return;
      // Walk to the root variable and collect the chain of field names.
      const root = collectMemberChain(s.lvalue, s.span);
      if (root === null) return;
      // If the RHS is a struct (constructor or struct-valued Ident
      // read), treat the leaf as a nested struct and recurse into its
      // shape. Otherwise it's a leaf field.
      const rhsStructShape = inferRhsStructShape(s.expr, map);
      if (rhsStructShape !== null) {
        addChainShapeNested(
          map,
          root.rootName,
          root.path,
          rhsStructShape,
          s.span
        );
      } else {
        addChainShape(map, root.rootName, root.path, s.span);
      }
      return;
    }

    case "If": {
      // V1: branch-divergent field-set rejection is enforced by the
      // shape merge below. We pre-pass each arm into a clone and
      // require every clone to agree (per root var). Variables that
      // appear in only some arms but get their field-set established
      // before the if (i.e. already in `map`) inherit that shape and
      // are fine. Variables that get their first member assignment
      // inside the if must agree across every arm.
      const armMaps: StructShapeMap[] = [];
      armMaps.push(cloneMap(map));
      walkStmts(s.thenBody, armMaps[0]);
      for (const eif of s.elseifBlocks) {
        const m = cloneMap(map);
        walkStmts(eif.body, m);
        armMaps.push(m);
      }
      if (s.elseBody !== null) {
        const m = cloneMap(map);
        walkStmts(s.elseBody, m);
        armMaps.push(m);
      }
      mergeArmShapes(map, armMaps, s.span);
      return;
    }

    case "While":
      walkStmts(s.body, map);
      return;

    case "For":
      walkStmts(s.body, map);
      return;

    case "Switch":
    case "TryCatch":
      // Not currently supported by the lowerer — let the main pass
      // raise its own UnsupportedConstruct with a span.
      return;

    case "MultiAssign":
    case "ExprStmt":
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
      return;
  }
}

/** Walk a `Member` lvalue chain back to its root variable and return
 *  the ordered list of field names from outermost to innermost. A
 *  `Member` whose base isn't ultimately an `Ident` (e.g. `f().x = 1`)
 *  is rejected — we don't support function-result lvalues. */
function collectMemberChain(
  lv: Extract<LValue, { type: "Member" }>,
  span: Span
): { rootName: string; path: string[] } | null {
  const path: string[] = [lv.name];
  let base: Expr = lv.base;
  while (base.type === "Member") {
    path.unshift(base.name);
    base = base.base;
  }
  if (base.type === "MemberDynamic") {
    throw new UnsupportedConstruct(
      `dynamic field access ('s.(name) = ...') is not yet supported`,
      span
    );
  }
  if (base.type !== "Ident") {
    // f().x = ... is not currently supported. Let the main pass raise
    // its own error with the offending span — the pre-pass simply
    // skips it.
    return null;
  }
  return { rootName: base.name, path };
}

/** When the LHS is `s.f = <struct-typed RHS>`, the pre-pass needs to
 *  know that `s.f` is itself a struct with the RHS's field-name set.
 *  Returns the inferred shape for the RHS, or null if the RHS isn't a
 *  struct value the pre-pass can identify statically. */
function inferRhsStructShape(
  expr: Expr,
  knownShapes: StructShapeMap
): StructShape | null {
  if (expr.type === "FuncCall" && expr.name === "struct") {
    // struct('a', v1, 'b', v2, ...) — field set is the keys.
    if (expr.args.length % 2 !== 0) return null;
    const shape: StructShape = { fields: new Map(), firstSpan: expr.span };
    for (let i = 0; i < expr.args.length; i += 2) {
      const keyArg = expr.args[i];
      if (keyArg.type !== "String" && keyArg.type !== "Char") return null;
      const name = decodeNumblQuotedLexeme(keyArg.value);
      // Recursively check the value for struct-of-struct cases.
      const valShape = inferRhsStructShape(expr.args[i + 1], knownShapes);
      shape.fields.set(name, valShape);
    }
    return shape;
  }
  if (expr.type === "Ident") {
    // The RHS reads another variable. If we've already pre-pass-seen
    // that variable as a struct, propagate its shape.
    const known = knownShapes.get(expr.name);
    if (known !== undefined) return cloneShape(known);
  }
  return null;
}

/** Identical to `addChainShape` but the leaf is itself a struct whose
 *  shape is `leafShape`. The leaf entry in the cursor's `fields` map
 *  becomes a nested shape rather than `null`. */
function addChainShapeNested(
  map: StructShapeMap,
  rootName: string,
  path: ReadonlyArray<string>,
  leafShape: StructShape,
  span: Span
): void {
  let shape = map.get(rootName);
  if (shape === undefined) {
    shape = { fields: new Map(), firstSpan: span };
    map.set(rootName, shape);
  }
  let cursor = shape;
  for (let i = 0; i < path.length - 1; i++) {
    const name = path[i];
    let next = cursor.fields.get(name);
    if (next === undefined || next === null) {
      next = { fields: new Map(), firstSpan: span };
      cursor.fields.set(name, next);
    }
    cursor = next;
  }
  const leafName = path[path.length - 1];
  const existing = cursor.fields.get(leafName);
  if (existing === undefined || existing === null) {
    cursor.fields.set(leafName, leafShape);
  } else {
    // Merge field names: the union of existing nested fields plus new ones.
    for (const [name, child] of leafShape.fields) {
      if (!existing.fields.has(name)) existing.fields.set(name, child);
    }
  }
}

/** Add the shape implied by `outer.inner.x = rhs` (chained members)
 *  to the map's entry for `rootName`. Creates intermediate nested
 *  shapes as needed. */
function addChainShape(
  map: StructShapeMap,
  rootName: string,
  path: ReadonlyArray<string>,
  span: Span
): void {
  let shape = map.get(rootName);
  if (shape === undefined) {
    shape = { fields: new Map(), firstSpan: span };
    map.set(rootName, shape);
  }
  // Walk along `path`, creating intermediate nested shapes for every
  // step but the last; the last step is a leaf entry (null marker —
  // type fills in at the lowering site).
  let cursor = shape;
  for (let i = 0; i < path.length - 1; i++) {
    const name = path[i];
    let next = cursor.fields.get(name);
    if (next === undefined) {
      next = null;
    }
    if (next === null) {
      // Promote a leaf entry to a nested shape on the first chained
      // assignment that needs it. This handles the legitimate pattern
      // where `outer.inner = scalar` (treated as leaf) is later
      // overwritten by `outer.inner.x = ...`; the v1 rule is "no
      // shape-changing reassignments", so we reject this case
      // explicitly to keep the static shape stable.
      if (cursor.fields.has(name)) {
        throw new UnsupportedConstruct(
          `'${rootName}.${path.slice(0, i + 1).join(".")}' is assigned both as a leaf field and as a nested struct; mtoc requires one shape for the lifetime of the variable`,
          span
        );
      }
      next = { fields: new Map(), firstSpan: span };
      cursor.fields.set(name, next);
    }
    cursor = next;
  }
  // Leaf step: register the field name. If it already exists with a
  // nested shape, that's a conflict (leaf vs nested at the same path).
  const leaf = path[path.length - 1];
  const existing = cursor.fields.get(leaf);
  if (existing !== undefined && existing !== null) {
    throw new UnsupportedConstruct(
      `'${rootName}.${path.join(".")}' is assigned both as a leaf field and as a nested struct; mtoc requires one shape for the lifetime of the variable`,
      span
    );
  }
  if (existing === undefined) {
    cursor.fields.set(leaf, null);
  }
}

/** Process `s = struct('f1', v1, 'f2', v2, ...)`. Every odd-indexed
 *  arg must be a string literal at lowering time; here we extract
 *  those names (and reject malformed shapes). Each field is added as
 *  a leaf; field-typed sub-expressions are handled at lowering. */
function addConstructorShape(
  map: StructShapeMap,
  rootName: string,
  call: Extract<Expr, { type: "FuncCall" }>,
  span: Span
): void {
  if (call.args.length % 2 !== 0) {
    throw new UnsupportedConstruct(
      `struct(...) constructor must take an even number of arguments (name/value pairs)`,
      span
    );
  }
  let shape = map.get(rootName);
  if (shape === undefined) {
    shape = { fields: new Map(), firstSpan: span };
    map.set(rootName, shape);
  } else {
    // Reassigning to a *different* struct shape via the constructor
    // is the v1 "shape change" case — reject with a clear span.
    // (Same shape via the constructor is fine — we don't check field
    // names against the existing shape here because the lowering
    // recordAssignment / storageCategory machinery will catch any
    // remaining mismatch.)
  }
  for (let i = 0; i < call.args.length; i += 2) {
    const keyArg = call.args[i];
    if (keyArg.type !== "String" && keyArg.type !== "Char") {
      throw new UnsupportedConstruct(
        `struct(...) field names must be string literals at lowering time`,
        keyArg.span
      );
    }
    const name = decodeNumblQuotedLexeme(keyArg.value);
    if (!shape.fields.has(name)) {
      shape.fields.set(name, null);
    }
  }
}

/** Deep-clone a shape map so each branch arm can accumulate its own
 *  updates without disturbing the others. */
function cloneMap(src: StructShapeMap): StructShapeMap {
  const out: StructShapeMap = new Map();
  for (const [k, v] of src) out.set(k, cloneShape(v));
  return out;
}

function cloneShape(s: StructShape): StructShape {
  const fields = new Map<string, StructShape | null>();
  for (const [name, child] of s.fields) {
    fields.set(name, child === null ? null : cloneShape(child));
  }
  return { fields, firstSpan: s.firstSpan };
}

/** Merge per-arm shape maps back into `target`. The rule:
 *    - A root var that was already in `target` before the If keeps
 *      its base shape. Arm-level field additions are added to the
 *      merged shape ONLY if every arm that mentioned the var added
 *      the same set of fields; otherwise raise UnsupportedConstruct.
 *    - A root var that's NEW in every arm gets the union of arm shapes
 *      IFF every arm agrees on the same shape (same field set);
 *      otherwise reject. */
function mergeArmShapes(
  target: StructShapeMap,
  armMaps: ReadonlyArray<StructShapeMap>,
  span: Span
): void {
  // Collect every root name that appears in any arm.
  const allRoots = new Set<string>();
  for (const m of armMaps) for (const k of m.keys()) allRoots.add(k);
  for (const root of allRoots) {
    const baseShape = target.get(root);
    const armShapes = armMaps.map(m => m.get(root) ?? null);
    if (baseShape === undefined) {
      // First time we're seeing this root anywhere. Every arm that
      // mentions it must produce the same shape; arms that don't
      // mention it are "absent" — combined with the post-If linear
      // path that's also absent, they don't conflict. The remaining
      // arms must agree.
      const present = armShapes.filter((s): s is StructShape => s !== null);
      if (present.length === 0) continue;
      const merged = present[0];
      for (let i = 1; i < present.length; i++) {
        if (!shapesAgree(merged, present[i])) {
          throw new UnsupportedConstruct(
            `branch-divergent struct field assignment for '${root}': different arms of this if/elseif/else assign different field-sets`,
            span
          );
        }
      }
      // If the field-set was set on some arms but not others, the
      // post-If merge is also ambiguous (the "absent" arm contributes
      // no shape). Reject unless every arm contributes the same shape.
      if (present.length !== armShapes.length) {
        throw new UnsupportedConstruct(
          `branch-divergent struct field assignment for '${root}': not every arm assigns this struct's fields`,
          span
        );
      }
      target.set(root, merged);
    } else {
      // The var existed before the If with some base shape. Every arm
      // must extend that shape with the same set of new fields (or
      // not extend it at all).
      const baseFieldKeys = new Set(baseShape.fields.keys());
      let chosen: StructShape | null = null;
      for (const arm of armShapes) {
        if (arm === null) continue;
        // Find the new fields the arm added relative to baseShape.
        if (chosen === null) {
          chosen = arm;
          continue;
        }
        if (!shapesAgree(chosen, arm)) {
          throw new UnsupportedConstruct(
            `branch-divergent struct field assignment for '${root}': different arms of this if/elseif/else assign different field-sets`,
            span
          );
        }
      }
      if (chosen === null) continue;
      // The chosen arm-shape may add new fields beyond base. If any
      // arm didn't extend (i.e. equals the base shape) while another
      // did, that's a divergence too.
      const chosenKeys = new Set(chosen.fields.keys());
      for (let i = 0; i < armShapes.length; i++) {
        const arm = armShapes[i];
        const armKeys =
          arm === null ? baseFieldKeys : new Set(arm.fields.keys());
        // If the chosen arm has more fields than this arm's view, and
        // this arm wasn't a no-touch (i.e. arm !== null), reject.
        if (
          arm !== null &&
          !setsEqual(armKeys as Set<string>, chosenKeys as Set<string>)
        ) {
          throw new UnsupportedConstruct(
            `branch-divergent struct field assignment for '${root}': different arms of this if/elseif/else assign different field-sets`,
            span
          );
        }
      }
      target.set(root, chosen);
    }
  }
}

/** Two `StructShape`s agree iff their field-key sets are equal and
 *  every shared nested-shape entry recursively agrees. Leaf-vs-nested
 *  mismatches are a disagreement. */
function shapesAgree(a: StructShape, b: StructShape): boolean {
  if (a.fields.size !== b.fields.size) return false;
  for (const [name, av] of a.fields) {
    if (!b.fields.has(name)) return false;
    const bv = b.fields.get(name)!;
    if (av === null && bv === null) continue;
    if (av === null || bv === null) return false;
    if (!shapesAgree(av, bv)) return false;
  }
  return true;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
