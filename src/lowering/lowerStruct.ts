/**
 * Lowering helpers for struct values:
 *   - `lowerStructConstructor`  — `struct('f', v, 'g', w)` → `IRExpr.StructLit`
 *   - `lowerMemberRead`         — `s.f1.f2....` → `IRExpr.MemberLoad`
 *   - `lowerMemberStore`        — `s.f1.f2.... = rhs` → `IRStmt.MemberStore`
 *
 * The pre-pass (`structPrePass.ts`) has already discovered every
 * variable that is treated as a struct in the body, plus the
 * top-level field-set per such variable, plus rejected the dynamic
 * field-access / struct-array / branch-divergent-shape patterns.
 * These helpers lower individual occurrences and grow each struct
 * variable's MType as fresh fields are introduced.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { TypeError, UnsupportedConstruct } from "./errors.js";
import type { IRExpr, IRStmt } from "./ir.js";
import type { Lowerer } from "./lower.js";
import {
  isStruct,
  structType,
  typeToString,
  type MType,
  type StructType,
} from "./types.js";

/** Lower a top-level `struct('f1', v1, 'f2', v2, ...)` call into a
 *  `IRExpr.StructLit`. Keys must be string literals (already vetted by
 *  the pre-pass for the assignment-RHS case; we re-validate here so
 *  nested or function-arg uses are still caught). */
export function lowerStructConstructor(
  this: Lowerer,
  argsAst: ReadonlyArray<Expr>,
  span: Span
): IRExpr {
  if (argsAst.length % 2 !== 0) {
    throw new UnsupportedConstruct(
      "struct() constructor requires an even number of arguments " +
        "(name/value pairs)",
      span
    );
  }
  const fields: { name: string; value: IRExpr; span: Span }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argsAst.length; i += 2) {
    const keyAst = argsAst[i];
    const valueAst = argsAst[i + 1];
    if (keyAst.type !== "String") {
      throw new UnsupportedConstruct(
        "struct() constructor field names must be string literals " +
          "(mtoc does not support dynamic struct construction)",
        keyAst.span
      );
    }
    const raw = keyAst.value;
    if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
      throw new UnsupportedConstruct(
        "struct() constructor: malformed string-literal field name",
        keyAst.span
      );
    }
    const name = raw.slice(1, -1).replace(/""/g, '"');
    if (name.length === 0) {
      throw new UnsupportedConstruct(
        "struct() constructor: empty field name",
        keyAst.span
      );
    }
    if (seen.has(name)) {
      throw new UnsupportedConstruct(
        `struct() constructor: duplicate field name '${name}'`,
        keyAst.span
      );
    }
    seen.add(name);
    const value = this.lowerExpr(valueAst);
    if (value.ty.kind === "Unknown" || value.ty.kind === "Void") {
      throw new TypeError(
        `struct() field '${name}' has type ${typeToString(value.ty)} ` +
          `(values must be typed)`,
        valueAst.span
      );
    }
    fields.push({ name, value, span: keyAst.span });
  }
  const ty = structType(fields.map(f => ({ name: f.name, type: f.value.ty })));
  return { kind: "StructLit", fields, ty, span };
}

/** Walk a `Member` chain on the AST side, returning the root Ident
 *  name and the ordered field path (top → leaf). Throws on any
 *  non-trivial base (dynamic field, struct-array index, non-Ident
 *  root). Used by member-read lowering. */
export function memberChainRootAst(
  e: Extract<Expr, { type: "Member" }>,
  span: Span
): { name: string; path: string[]; baseSpan: Span } {
  const path: string[] = [];
  let cur: Expr = e;
  while (cur.type === "Member") {
    path.unshift(cur.name);
    cur = cur.base;
  }
  if (cur.type === "MemberDynamic") {
    throw new UnsupportedConstruct(
      "dynamic field access `s.(expr)` is not yet supported by mtoc",
      cur.span
    );
  }
  if (cur.type === "Index" || cur.type === "IndexCell") {
    throw new UnsupportedConstruct(
      "struct-array indexing (`s(i).field`) is not yet supported by mtoc " +
        "(only scalar structs in v1)",
      span
    );
  }
  if (cur.type !== "Ident") {
    throw new UnsupportedConstruct(
      `member access requires a simple identifier base (got ${cur.type})`,
      cur.span
    );
  }
  return { name: cur.name, path, baseSpan: cur.span };
}

/** Lower `s.f1.f2....` as a value expression into an `IRExpr.MemberLoad`. */
export function lowerMemberRead(
  this: Lowerer,
  e: Extract<Expr, { type: "Member" }>
): IRExpr {
  const { name, path, baseSpan } = memberChainRootAst(e, e.span);
  const baseTy = this.envLookup(name);
  if (baseTy === undefined) {
    throw new TypeError(`use of undefined variable '${name}'`, baseSpan);
  }
  if (!isStruct(baseTy)) {
    throw new TypeError(
      `'${name}' is ${typeToString(baseTy)}; cannot read field '${path[0]}' ` +
        `on a non-struct value`,
      e.span
    );
  }
  // Walk the chain, resolving each field's type against the current
  // struct type.
  let curTy: MType = baseTy;
  for (let i = 0; i < path.length; i++) {
    if (!isStruct(curTy)) {
      throw new TypeError(
        `cannot read field '${path[i]}' on non-struct value of type ` +
          `${typeToString(curTy)} (chain: ${name}.${path.slice(0, i + 1).join(".")})`,
        e.span
      );
    }
    const f = curTy.fields.find(ff => ff.name === path[i]);
    if (!f) {
      throw new TypeError(
        `struct '${name}' has no field '${path[i]}' (chain: ` +
          `${name}.${path.slice(0, i + 1).join(".")})`,
        e.span
      );
    }
    curTy = f.type;
  }
  const baseCName = this.currentCNameFor(name);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName: baseCName,
    ty: baseTy,
    span: baseSpan,
  };
  return { kind: "MemberLoad", base, path, ty: curTy, span: e.span };
}

/** Lower `<lvalue> = <expr>` where `lvalue` is a `Member`. */
export function lowerMemberStore(
  this: Lowerer,
  lvalue: Extract<LValue, { type: "Member" }>,
  exprAst: Expr,
  span: Span
): IRStmt {
  const lvalueAst: Extract<Expr, { type: "Member" }> = {
    type: "Member",
    base: lvalue.base,
    name: lvalue.name,
    span,
  };
  const { name, path, baseSpan } = memberChainRootAst(lvalueAst, span);

  // Lower the RHS BEFORE growing the struct type — the RHS's type is
  // what we'll seat into the field slot. The RHS reads can see the
  // current binding (so a `s.a = s.a + 1` style update works once we
  // support it through control-flow).
  const rhs = this.lowerExpr(exprAst);
  if (rhs.ty.kind === "Unknown" || rhs.ty.kind === "Void") {
    throw new TypeError(
      `struct field '${path.join(".")}' has type ${typeToString(rhs.ty)} ` +
        `(values must be typed)`,
      exprAst.span
    );
  }

  // Grow or initialize `name`'s struct type by setting the leaf field
  // along the chain to `rhs.ty`.
  const prevTy = this.envLookup(name);
  if (prevTy !== undefined && !isStruct(prevTy)) {
    throw new UnsupportedConstruct(
      `'${name}' was previously ${typeToString(prevTy)} and is now being ` +
        `assigned a struct field; mtoc requires a fresh name (or hoist the ` +
        `struct creation above the prior assignment)`,
      span
    );
  }
  const newTy = setFieldType(
    prevTy as StructType | undefined,
    path,
    rhs.ty,
    span
  );
  // recordAssignment to register/widen the binding's static type. We
  // synthesize a member-store rather than going through `Assign` —
  // `recordAssignment` still does the right thing: it widens the
  // binding's type to include the new field. Subsequent reads will
  // see the widened struct type.
  const cName = this.recordAssignment(name, newTy, span);
  const base: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name,
    cName,
    ty: newTy,
    span: baseSpan,
  };
  return { kind: "MemberStore", base, path, rhs, span };
}

/** Produce a new struct type that has the chain `path` set to `leafTy`.
 *  Any intermediate struct in the chain is grown to contain the next
 *  level's field. */
function setFieldType(
  prev: StructType | undefined,
  path: ReadonlyArray<string>,
  leafTy: MType,
  span: Span
): StructType {
  if (path.length === 0) {
    throw new UnsupportedConstruct(
      `internal: empty member path in struct field assignment`,
      span
    );
  }
  const fieldName = path[0];
  if (path.length === 1) {
    return upsertField(prev, fieldName, leafTy);
  }
  // Recurse into the nested struct. Existing field at fieldName must
  // be a struct (or absent).
  const existing = prev?.fields.find(f => f.name === fieldName);
  if (existing && !isStruct(existing.type)) {
    throw new UnsupportedConstruct(
      `cannot assign nested field '${path.slice(1).join(".")}' on field ` +
        `'${fieldName}' of type ${typeToString(existing.type)} ` +
        `(must be a struct)`,
      span
    );
  }
  const innerNext = setFieldType(
    existing ? (existing.type as StructType) : undefined,
    path.slice(1),
    leafTy,
    span
  );
  return upsertField(prev, fieldName, innerNext);
}

function upsertField(
  prev: StructType | undefined,
  name: string,
  ty: MType
): StructType {
  // Preserve insertion order from the prior type and append a fresh
  // field at the end if it's newly introduced.
  const prevFields = prev
    ? new Map(prev.fields.map(f => [f.name, f.type]))
    : new Map<string, MType>();
  prevFields.set(name, ty);
  const insertionOrder = prev ? [...prev.insertionOrder] : [];
  if (!insertionOrder.includes(name)) insertionOrder.push(name);
  const ordered: { name: string; type: MType }[] = insertionOrder.map(n => ({
    name: n,
    type: prevFields.get(n)!,
  }));
  // structType() sorts fields by name (canonical form) AND sets
  // insertionOrder to its caller-given order. We feed it the ordered
  // list so `insertionOrder` matches `ordered`'s sequence, which is
  // the prior `insertionOrder` with the new name appended.
  return structType(ordered);
}
