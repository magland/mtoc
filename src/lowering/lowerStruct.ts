/**
 * Lowering helpers for struct member access and the `struct(...)`
 * constructor. Three entry points:
 *
 *   - `lowerMemberRead`     — `s.f`, possibly chained (`s.inner.x`).
 *   - `lowerMemberStore`    — `s.f = rhs`, possibly chained
 *                             (`outer.inner.x = rhs`).
 *   - `lowerStructConstructor` — `struct('x', v1, 'y', v2, ...)` /
 *                             `struct()`.
 *
 * The pre-pass (`structPrePass`) has already accumulated the field-set
 * shape for every root variable. These helpers consult that shape to
 * decide:
 *   - which fields a variable can be assigned through (rejecting any
 *     name not in the pre-pass set is the v1 "static struct shape"
 *     guarantee), and
 *   - which nested-struct fields exist (so `outer.inner.x = …` works
 *     even before `inner` has been written to).
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr, IRStmt } from "./ir.js";
import { Lowerer } from "./lower.js";
import type { StructShape } from "./structPrePass.js";
import {
  isStruct,
  scalarDouble,
  structType,
  typeToString,
  unify,
  type MType,
  type StructType,
} from "./types.js";

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
    // If the user has directly recorded a type for this field (via
    // either `s.<name> = <leaf>` or `s.<name> = <struct value>`),
    // prefer that recorded type — it's the post-unify canonical
    // form. Otherwise:
    //   - if the pre-pass marked this field as nested, recurse into
    //     the nested shape (filling sub-field types via dotted-path
    //     lookups);
    //   - if leaf-marked, fall back to scalarDouble("zero").
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

/** Update the lowerer's per-root field-type tracking so the next
 *  `lookupStructTypeForRoot` reflects the freshly-assigned field. */
function recordFieldType(
  fieldTypes: Map<string, MType>,
  fieldPath: ReadonlyArray<string>,
  ty: MType
): void {
  fieldTypes.set(fieldPath.join("."), ty);
}

/** Look up the current static type of `rootName` in the lowerer's
 *  env, given the pre-pass shape. */
export function lookupStructTypeForRoot(
  this: Lowerer,
  rootName: string
): StructType | undefined {
  const shape = this.structShapes.get(rootName);
  if (shape === undefined) return undefined;
  const fieldTypes =
    this.structFieldTypes.get(rootName) ?? new Map<string, MType>();
  return buildStructType(shape, fieldTypes);
}

/** Lower `s.f`, possibly chained (`s.inner.x`). Returns an
 *  `IRExpr.MemberLoad` (or a chain of them) tagged with the resolved
 *  field type. Rejects:
 *    - dynamic member access (`s.(name)`)
 *    - access on a non-struct base
 *    - access of a field not in the pre-pass shape */
export function lowerMemberRead(
  this: Lowerer,
  e: Extract<Expr, { type: "Member" }>
): IRExpr {
  // Walk to the root variable, accumulating the field path.
  const path: string[] = [e.name];
  let base: Expr = e.base;
  while (base.type === "Member") {
    path.unshift(base.name);
    base = base.base;
  }
  if (base.type === "MemberDynamic") {
    throw new UnsupportedConstruct(
      `dynamic field access ('s.(name)') is not yet supported`,
      e.span
    );
  }
  if (base.type !== "Ident") {
    throw new UnsupportedConstruct(
      `field access on a non-variable base is not yet supported`,
      e.span
    );
  }
  // Look up the root in env; if it's a struct, traverse its fields.
  const rootTy = this.envLookup(base.name);
  if (rootTy === undefined) {
    throw new TypeError(`use of undefined variable '${base.name}'`, e.span);
  }
  if (!isStruct(rootTy)) {
    throw new UnsupportedConstruct(
      `'${base.name}' is ${typeToString(rootTy)}, not a struct; cannot read field '.${path[0]}'`,
      e.span
    );
  }
  // Build the IR chain: Var → MemberLoad → MemberLoad → …
  let cur: IRExpr = {
    kind: "Var",
    name: base.name,
    cName: this.currentCNameFor(base.name),
    ty: rootTy,
    span: base.span,
  };
  let curTy: MType = rootTy;
  for (let i = 0; i < path.length; i++) {
    const fieldName = path[i];
    if (!isStruct(curTy)) {
      throw new TypeError(
        `'${base.name}.${path.slice(0, i).join(".")}' is ${typeToString(curTy)}, not a struct; cannot read field '.${fieldName}'`,
        e.span
      );
    }
    const field: { name: string; type: MType } | undefined = curTy.fields.find(
      ff => ff.name === fieldName
    );
    if (!field) {
      throw new TypeError(
        `struct '${base.name}${path.slice(0, i).length > 0 ? "." + path.slice(0, i).join(".") : ""}' has no field '${fieldName}'`,
        e.span
      );
    }
    cur = {
      kind: "MemberLoad",
      base: cur,
      field: fieldName,
      ty: field.type,
      span: e.span,
    };
    curTy = field.type;
  }
  return cur;
}

/** Lower `s.f = rhs` (possibly chained: `outer.inner.x = rhs`).
 *  Returns an `IRStmt.MemberStore` (or, if the leaf field type would
 *  cause a struct-shape change, an Assign that re-binds the root). */
export function lowerMemberStore(
  this: Lowerer,
  lvalue: Extract<LValue, { type: "Member" }>,
  rhsExpr: Expr,
  span: Span
): IRStmt {
  // Resolve the chain back to a root Ident.
  const path: string[] = [lvalue.name];
  let base: Expr = lvalue.base;
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
    throw new UnsupportedConstruct(
      `assignment to a non-variable base is not yet supported`,
      span
    );
  }
  const rootName = base.name;
  // Verify the pre-pass identified this root as a struct, with this
  // field path. The pre-pass already accumulated the union of fields
  // across the body, so any path that surfaces here must already be
  // in the shape.
  const shape = this.structShapes.get(rootName);
  if (shape === undefined) {
    throw new TypeError(
      `'${rootName}.${path.join(".")} = …': struct field assignment to a non-struct (or unprepared) variable. ` +
        `This usually means '${rootName}' was assigned a non-struct value earlier in the same scope.`,
      span
    );
  }
  // Walk the path through the shape to validate every prefix exists.
  let cursor: StructShape | null = shape;
  for (let i = 0; i < path.length - 1; i++) {
    const next: StructShape | null | undefined = cursor?.fields.get(path[i]);
    if (next === undefined) {
      throw new TypeError(
        `'${rootName}.${path.slice(0, i + 1).join(".")} = …': field '${path[i]}' was not seen by the pre-pass`,
        span
      );
    }
    if (next === null) {
      throw new TypeError(
        `'${rootName}.${path.slice(0, i + 1).join(".")} = …': '${path[i]}' is a leaf field, not a nested struct`,
        span
      );
    }
    cursor = next;
  }
  const leafName = path[path.length - 1];
  if (cursor === null || !cursor.fields.has(leafName)) {
    throw new TypeError(
      `'${rootName}.${path.join(".")} = …': field '${leafName}' was not seen by the pre-pass`,
      span
    );
  }

  const rhs = this.lowerExpr(rhsExpr);
  // Reject struct-valued RHS that doesn't match the current shape;
  // and disallow direct struct-to-field assignment at a leaf marked
  // as a non-struct in the pre-pass (the pre-pass marks it leaf so we
  // know to keep it leaf). The constructor RHS handles its own field
  // wrapping; here we only allow:
  //   - leaf field: rhs is any MType compatible with the prior type
  //     at that field (numeric / string / numeric tensor / struct).
  //   - nested field path: the leaf is the last name; the chain prefix
  //     was validated above.
  const leafIsNested = cursor.fields.get(leafName) !== null;
  if (leafIsNested && !isStruct(rhs.ty)) {
    throw new TypeError(
      `'${rootName}.${path.join(".")} = …': leaf is a nested struct shape but the RHS is ${typeToString(rhs.ty)}`,
      span
    );
  }
  if (!leafIsNested && isStruct(rhs.ty)) {
    throw new TypeError(
      `'${rootName}.${path.join(".")} = …': leaf is a non-struct field but the RHS is a struct`,
      span
    );
  }

  // Update the per-root field-type tracking. For nested fields, the
  // rhs.ty IS the field's struct type; for leaf fields it's the
  // value's type.
  let fieldTypes = this.structFieldTypes.get(rootName);
  if (fieldTypes === undefined) {
    fieldTypes = new Map();
    this.structFieldTypes.set(rootName, fieldTypes);
  }
  // If this field already has a type, unify with the new one. The
  // unify result becomes the canonical field type.
  const prior = fieldTypes.get(path.join("."));
  const finalTy = prior === undefined ? rhs.ty : unify(prior, rhs.ty);
  if (finalTy.kind === "Unknown") {
    throw new TypeError(
      `'${rootName}.${path.join(".")} = …': cannot unify prior field type ${typeToString(prior!)} with new RHS type ${typeToString(rhs.ty)}`,
      span
    );
  }
  recordFieldType(fieldTypes, path, finalTy);

  // Rebuild the root struct type with the updated field tracking and
  // re-record the assignment (so `assignedVars` reflects the latest
  // shape).
  const newRootTy = lookupStructTypeForRoot.call(this, rootName)!;
  const cName = this.recordAssignment(rootName, newRootTy, span);
  const baseVar: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name: rootName,
    cName,
    ty: newRootTy,
    span: base.span,
  };
  return {
    kind: "MemberStore",
    base: baseVar,
    fieldPath: path,
    leafTy: finalTy,
    rhs,
    span,
  };
}

/** Lower the `struct('x', v1, 'y', v2, ...)` / `struct()` constructor.
 *  Returns an `IRExpr.StructLit`. Every key arg must be a string or
 *  char literal at lowering time. */
export function lowerStructConstructor(
  this: Lowerer,
  call: Extract<Expr, { type: "FuncCall" }>
): IRExpr {
  if (call.args.length % 2 !== 0) {
    throw new UnsupportedConstruct(
      `struct(...) constructor must take an even number of arguments (name/value pairs)`,
      call.span
    );
  }
  const fields: { name: string; value: IRExpr }[] = [];
  const fieldTypes: { name: string; type: MType }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < call.args.length; i += 2) {
    const keyArg = call.args[i];
    const valArg = call.args[i + 1];
    if (keyArg.type !== "String" && keyArg.type !== "Char") {
      throw new UnsupportedConstruct(
        `struct(...) field names must be string literals at lowering time`,
        keyArg.span
      );
    }
    const name = decodeQuotedLexeme(keyArg.value);
    if (seen.has(name)) {
      throw new UnsupportedConstruct(
        `struct(...) field '${name}' specified more than once`,
        keyArg.span
      );
    }
    seen.add(name);
    const value = this.lowerExpr(valArg);
    fields.push({ name, value });
    fieldTypes.push({ name, type: value.ty });
  }
  const ty = structType(fieldTypes);
  return {
    kind: "StructLit",
    fields,
    ty,
    span: call.span,
  };
}

/** Decode a numbl-style quoted literal lexeme (the parser keeps the
 *  surrounding quotes and the doubled-quote escapes). */
function decodeQuotedLexeme(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}
