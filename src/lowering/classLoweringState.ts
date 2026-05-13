/**
 * Per-scope state for classdef lowering.
 *
 * Owned by `Lowerer.class`. Mirrors `StructLoweringState`'s shape but
 * the property set is declared up-front by the classdef (not inferred
 * from body walking), so the pre-pass piece is much smaller: at body
 * entry we just register which root variables are class-typed and the
 * declaring `ClassInfo` to read declared property names from.
 *
 * Two pieces of state per scope:
 *
 *  - `roots`: root var name → declaring `ClassInfo`. Seeded when a
 *    class-typed param arrives on entry (via `seedFromClassType`) and
 *    when an assignment binds a name to a class instance (via
 *    `registerRoot`). Drives `lookupClassTypeFor` so a `MemberStore`
 *    knows the variable's declared property set.
 *
 *  - `propertyTypes`: per-root, property-name → current MType. Filled
 *    incrementally as the body assigns `obj.<prop> = ...`. Unwritten
 *    declared properties stand in as `scalarDouble("zero")` (matching
 *    numbl's `[]`-to-double default semantics for unannotated
 *    properties).
 */

import type { ClassInfo } from "../numbl-core/lowering/loweringContext.js";
import {
  classType,
  isClass,
  scalarDouble,
  type ClassType,
  type MType,
} from "./types.js";

export class ClassLoweringState {
  /** Per-root class identity. Each entry says "this var holds an
   *  instance of this class". Drives `lookupClassTypeFor`. */
  roots: Map<string, ClassInfo> = new Map();

  /** Per-root inheritance-flattened property name list (parent-first,
   *  then child-own). Stored separately from `ClassInfo` (which only
   *  has the class's OWN properties) so `lookupClassTypeFor` can
   *  emit the typedef with every accessible property — including
   *  those inherited from superclasses. */
  flatProps: Map<string, ReadonlyArray<string>> = new Map();

  /** Per-root property-type tracking. Keyed by root var name, each
   *  entry maps property names to the current MType. Properties the
   *  class declares but the body hasn't written use `scalarDouble`
   *  as the default. */
  propertyTypes: Map<string, Map<string, MType>> = new Map();

  /** Register a root variable as a class instance of the declaring
   *  class. `flatProps` carries the inheritance-flattened property
   *  list (parent-first); pass `info.propertyNames` if the class has
   *  no superclass. Idempotent; later calls with the same root may
   *  pass a different `ClassInfo` only if the classes are identical
   *  (same file + name). */
  registerRoot(
    rootName: string,
    info: ClassInfo,
    flatProps: ReadonlyArray<string>
  ): void {
    this.roots.set(rootName, info);
    this.flatProps.set(rootName, flatProps);
  }

  /** Get-or-insert the per-root `propertyTypes` map. The returned
   *  reference is mutable so callers can populate entries directly. */
  ensurePropertyTypes(rootName: string): Map<string, MType> {
    let m = this.propertyTypes.get(rootName);
    if (m === undefined) {
      m = new Map();
      this.propertyTypes.set(rootName, m);
    }
    return m;
  }

  /** Build a `ClassType` for `rootName` reflecting the current
   *  property-type tracking, declared property set, and class
   *  identity. Returns undefined when the variable isn't registered
   *  as a class root. Properties not yet assigned use
   *  `scalarDouble("zero")` so the typedef is emittable. */
  lookupClassTypeFor(rootName: string): ClassType | undefined {
    const info = this.roots.get(rootName);
    if (info === undefined) return undefined;
    const propMap =
      this.propertyTypes.get(rootName) ?? new Map<string, MType>();
    const names =
      this.flatProps.get(rootName) ??
      (info.propertyNames as ReadonlyArray<string>);
    const properties: { name: string; type: MType }[] = [];
    for (const name of names) {
      const ty = propMap.get(name) ?? scalarDouble("zero");
      properties.push({ name, type: ty });
    }
    return classType({
      className: info.qualifiedName,
      file: info.fileName,
      properties,
    });
  }

  /** Seed the per-root state for a class-typed function parameter.
   *  Records the class identity AND the flattened property name list.
   *  Property types ARE seeded too so reads on an unassigned param
   *  still work — EXCEPT for "placeholder" entries (default
   *  `scalarDouble("zero")` from a fresh constructor receiver), which
   *  are skipped so the first body write establishes the type
   *  fresh. `isInitialReceiver` distinguishes a constructor's
   *  receiver (all-placeholders) from a method's receiver (real
   *  call-site types). No-op for non-class types so callers can
   *  hand any param type through. */
  seedFromClassType(
    rootName: string,
    ty: MType,
    info: ClassInfo | null,
    isInitialReceiver = false
  ): void {
    if (!isClass(ty)) return;
    if (info !== null) this.roots.set(rootName, info);
    // The call-site ClassType's properties ARE the flattened set —
    // mtoc never produces a ClassType from a partial set, only via
    // `initialClassType` / `lookupClassTypeFor` which both use the
    // inheritance-flattened name list.
    this.flatProps.set(
      rootName,
      ty.properties.map(p => p.name)
    );
    if (isInitialReceiver) return;
    const propMap = this.ensurePropertyTypes(rootName);
    for (const p of ty.properties) {
      if (!propMap.has(p.name)) propMap.set(p.name, p.type);
    }
  }
}
