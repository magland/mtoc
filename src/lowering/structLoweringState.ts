/**
 * Per-scope state for struct lowering.
 *
 * Owned by `Lowerer.struct`; was previously two raw `Map`s on
 * `Lowerer` (`structShapes` + `structFieldTypes`). Pulling the pair
 * into its own object keeps the god-object slimmer and makes the
 * "named-type per-scope state" pattern reusable: when `classdef`
 * lands, `ClassLoweringState` slots in alongside in the same shape.
 *
 * Two pieces of state per scope:
 *
 *  - `shapes`: the pre-pass output (`collectStructShapes`) recording
 *    every variable that appears as a struct root (via either
 *    `s.f = …` or `struct(...)` constructor). Pinned once at the top
 *    of a body via `primeFromBody`; subsequent mutations come from
 *    `seedFromStructType` (when a struct-typed param arrives at a
 *    function-scope lowerer and adds its call-site shape).
 *
 *  - `fieldTypes`: per-root, dotted-path → current MType tracking.
 *    Populated incrementally as the body assigns through fields, and
 *    seeded from the call-site struct type for struct params. Read
 *    by `lookupStructTypeFor` to build the current `StructType`.
 */

import type { Stmt } from "../parser/index.js";
import {
  collectStructShapes,
  type StructShape,
  type StructShapeMap,
} from "./structPrePass.js";
import {
  isStruct,
  scalarDouble,
  structType,
  type MType,
  type StructType,
} from "./types.js";

export class StructLoweringState {
  /** Per-root struct-shape map computed by `collectStructShapes`
   *  before body lowering starts. Empty when no struct lvalues or
   *  `struct(...)` constructors appear in the scope. The lowering
   *  helpers in `lowerStruct.ts` read this to know the variable's
   *  static field-set; the storage-category mismatch check in
   *  `recordAssignment` then keeps the shape stable across the
   *  variable's lifetime. */
  shapes: StructShapeMap = new Map();

  /** Per-root struct field-type tracking. Keyed by root var name,
   *  each entry maps dotted field paths (`"x"`, `"inner.y"`) to the
   *  current MType. Updated by `lowerMemberStore` and consulted by
   *  `lookupStructTypeFor` to assemble the variable's current
   *  `StructType`. */
  fieldTypes: Map<string, Map<string, MType>> = new Map();

  /** Populate `shapes` for the body about to be lowered. Called once
   *  before the body's stmts are visited; calling again on the same
   *  instance overwrites the prior map (intentional — primeFromBody
   *  on an inner Lowerer should start from a clean slate). */
  primeFromBody(body: ReadonlyArray<Stmt>): void {
    this.shapes = collectStructShapes(body);
  }

  /** Get-or-insert the per-root `fieldTypes` map. Returned reference
   *  is mutable so callers can populate dotted-path entries directly. */
  ensureFieldTypes(rootName: string): Map<string, MType> {
    let m = this.fieldTypes.get(rootName);
    if (m === undefined) {
      m = new Map();
      this.fieldTypes.set(rootName, m);
    }
    return m;
  }

  /** Build a `StructType` for `rootName` reflecting the current
   *  field-type tracking. Returns undefined when the variable isn't
   *  in the pre-pass shape map. Fields the user has directly
   *  assigned use their recorded type; pre-pass-known leaves that
   *  haven't been written stand in as `scalarDouble("zero")` so the
   *  struct's typedef is still emittable. */
  lookupStructTypeFor(rootName: string): StructType | undefined {
    const shape = this.shapes.get(rootName);
    if (shape === undefined) return undefined;
    const fieldTypes =
      this.fieldTypes.get(rootName) ?? new Map<string, MType>();
    return buildStructType(shape, fieldTypes);
  }

  /** Seed shapes + fieldTypes for a function-parameter binding whose
   *  call-site type is a struct. Lets member reads on the param work
   *  before any body assignment touches it; recurses into nested
   *  struct fields. No-op for non-struct types so the caller can hand
   *  any param type through. */
  seedFromStructType(rootName: string, ty: MType): void {
    if (!isStruct(ty)) return;
    let shape = this.shapes.get(rootName);
    if (shape === undefined) {
      shape = { fields: new Map(), firstSpan: { file: "", start: 0, end: 0 } };
      this.shapes.set(rootName, shape);
    }
    const fieldTypes = this.ensureFieldTypes(rootName);
    seedShape(shape, fieldTypes, ty, []);
  }
}

/** Walk a `StructType` and merge its field set into the shape +
 *  fieldTypes maps. Nested struct fields recurse so the deepest
 *  leaves end up registered with dotted paths. */
function seedShape(
  shape: StructShape,
  fieldTypes: Map<string, MType>,
  ty: StructType,
  pathSoFar: string[]
): void {
  for (const f of ty.fields) {
    const newPath = [...pathSoFar, f.name];
    if (isStruct(f.type)) {
      let nested = shape.fields.get(f.name);
      if (nested === undefined || nested === null) {
        nested = { fields: new Map(), firstSpan: shape.firstSpan };
        shape.fields.set(f.name, nested);
      }
      seedShape(nested, fieldTypes, f.type, newPath);
    } else {
      if (!shape.fields.has(f.name)) {
        shape.fields.set(f.name, null);
      }
      if (!fieldTypes.has(newPath.join("."))) {
        fieldTypes.set(newPath.join("."), f.type);
      }
    }
  }
}

/** Build the runtime `StructType` from a pre-pass shape, picking the
 *  current field types from `fieldTypes`. Fields the user has assigned
 *  show up as a real MType; fields the pre-pass identified but the
 *  user hasn't assigned yet stand in as `scalarDouble("zero")` so the
 *  struct's typedef can be emitted even when only a subset of fields
 *  has been written. */
function buildStructType(
  shape: StructShape,
  fieldTypes: ReadonlyMap<string, MType>
): StructType {
  const fields: { name: string; type: MType }[] = [];
  for (const [name, nested] of shape.fields) {
    const direct = fieldTypes.get(name);
    if (direct !== undefined) {
      fields.push({ name, type: direct });
      continue;
    }
    if (nested === null) {
      fields.push({ name, type: scalarDouble("zero") });
    } else {
      const subTypes = subFieldMap(fieldTypes, name);
      fields.push({ name, type: buildStructType(nested, subTypes) });
    }
  }
  return structType(fields);
}

/** Extract the sub-map of nested-field types whose keys start with
 *  `prefix.` (returns the sub-keys with the prefix stripped). */
function subFieldMap(
  flat: ReadonlyMap<string, MType>,
  prefix: string
): Map<string, MType> {
  const dotted = `${prefix}.`;
  const out = new Map<string, MType>();
  for (const [k, v] of flat) {
    if (k.startsWith(dotted)) {
      out.set(k.slice(dotted.length), v);
    }
  }
  return out;
}
