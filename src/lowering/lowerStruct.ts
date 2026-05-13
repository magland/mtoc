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
import { decodeNumblQuotedLexeme } from "./lexerHelpers.js";
import type { StructShape } from "./structPrePass.js";
import {
  isMultiElement,
  isNumeric,
  isScalarReal,
  isStruct,
  scalarComplex,
  scalarDouble,
  structType,
  typeToString,
  unify,
  type MType,
} from "./types.js";

/** When a function parameter is a struct, seed the inner lowerer's
 *  per-root field-type tracking so member reads on the param work
 *  even before the body has assigned through it. Also augment the
 *  pre-pass struct-shape map to reflect the param's call-site shape.
 *  No-op for non-struct types so callers can hand any param type
 *  through. Thin wrapper over `StructLoweringState.seedFromStructType`. */
export function seedStructParamFieldTypes(
  inner: Lowerer,
  rootName: string,
  ty: MType
): void {
  inner.struct.seedFromStructType(rootName, ty);
}

/** Update the lowerer's per-root field-type tracking so the next
 *  `currentStructTypeFor` reflects the freshly-assigned field. */
function recordFieldType(
  fieldTypes: Map<string, MType>,
  fieldPath: ReadonlyArray<string>,
  ty: MType
): void {
  fieldTypes.set(fieldPath.join("."), ty);
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
  const shape = this.struct.shapes.get(rootName);
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
  const fieldTypes = this.struct.ensureFieldTypes(rootName);
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
  const newRootTy = this.struct.lookupStructTypeFor(rootName)!;
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
    const name = decodeNumblQuotedLexeme(keyArg.value);
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

/** Lower a `obj.field(indices...)` `MethodCall` whose base resolves to
 *  a struct and whose `field` is a tensor-typed property — i.e. a
 *  field-then-index read. Synthesizes an `IRExpr.IndexLoad` whose base
 *  is a fake `Var` carrying the dotted C-path as `cName`, so codegen
 *  renders `<base>.<field1>.<field2>....real[<offset>]` correctly.
 *
 *  Today this is the only `MethodCall` shape mtoc accepts: every other
 *  form (true method dispatch, base that isn't a struct, range/colon
 *  slot, deep field expressions) rejects with a span. When class
 *  support lands, the `lowerExpr` `MethodCall` arm will try
 *  class-method dispatch first and fall through here for the struct-
 *  field case.
 *
 *  Field reads with no args (`obj.field` with zero indices in the
 *  source) come through as `MemberLoad` and return that directly. */
export function lowerStructFieldIndex(
  this: Lowerer,
  e: Extract<Expr, { type: "MethodCall" }>
): IRExpr {
  const memberExpr: Expr = {
    type: "Member",
    base: e.base,
    name: e.name,
    span: e.span,
  };
  const memberIr = lowerMemberRead.call(
    this,
    memberExpr as Extract<Expr, { type: "Member" }>
  );
  if (e.args.length === 0) return memberIr;
  if (!isNumeric(memberIr.ty) || !isMultiElement(memberIr.ty)) {
    throw new UnsupportedConstruct(
      `indexing into struct field '${e.name}' requires a tensor field (got ${typeToString(memberIr.ty)})`,
      e.span
    );
  }
  // Walk the MemberLoad chain to gather the path; the C-side base
  // expression is the dotted concatenation of struct field names.
  const fieldPath: string[] = [];
  let cur: IRExpr = memberIr;
  while (cur.kind === "MemberLoad") {
    fieldPath.unshift(cur.field);
    cur = cur.base;
  }
  if (cur.kind !== "Var") {
    throw new UnsupportedConstruct(
      `indexing into a complex struct-field expression is not yet supported by mtoc`,
      e.span
    );
  }
  const syntheticBase: IRExpr = {
    kind: "Var",
    name: `${cur.name}.${fieldPath.join(".")}`,
    cName: `${cur.cName}.${fieldPath.join(".")}`,
    ty: memberIr.ty,
    span: e.span,
  };
  // Range / colon slots on a struct-field expression require a
  // hoisted name; range writes / reads aren't wired in this form.
  if (e.args.some(a => a.type === "Range" || a.type === "Colon")) {
    throw new UnsupportedConstruct(
      `range / colon indexing on a struct-field expression ('s.field(a:b)') is not yet supported; assign the field to a name first`,
      e.span
    );
  }
  const indices = e.args.map(a => this.lowerExpr(a));
  for (let i = 0; i < indices.length; i++) {
    if (!isScalarReal(indices[i].ty)) {
      throw new TypeError(
        `index ${i + 1} of 's.${e.name}(...)' must be a real scalar (got ${typeToString(indices[i].ty)})`,
        e.args[i].span
      );
    }
  }
  const baseTy = memberIr.ty;
  const resultTy: MType =
    isNumeric(baseTy) && baseTy.isComplex
      ? scalarComplex()
      : scalarDouble("unknown");
  return {
    kind: "IndexLoad",
    base: syntheticBase as Extract<IRExpr, { kind: "Var" }>,
    indices,
    ty: resultTy,
    span: e.span,
  };
}
