/**
 * Post-lowering normalization pass that stabilizes every struct-typed
 * IR node's `ty` to the canonical post-widening type from
 * `assignedVars` / params / outputs. Without this pass, multiple
 * intermediate widened types (one per field assignment) leak into the
 * IR, and codegen ends up emitting multiple distinct typedefs for the
 * same logical variable.
 *
 * For other kinds (numeric, string), the `cTypeFor` mapping is stable
 * regardless of intermediate sign/shape evolution, so this pass is a
 * no-op for them.
 */

import type {
  IRExpr,
  IRProgram,
  IRStmt,
  IndexSliceArg,
  VarBinding,
} from "./ir.js";
import { isStruct, type MType, type StructType } from "./types.js";

/** Rewrite every struct-typed expression in the program so the type
 *  comes from the variable's binding in the relevant scope. */
export function normalizeStructTypes(prog: IRProgram): void {
  // Per-scope: cName → final type. For main, we use prog.assignedVars
  // directly. For each function, we build a combined map from params,
  // outputs, and the function's assignedVars (later wins on duplicate
  // keys, but they shouldn't overlap).
  prog.stmts = rewriteStmts(prog.stmts, prog.assignedVars);
  for (const fn of prog.functions) {
    const binds = new Map<string, MType>();
    for (const p of fn.params) binds.set(p.cName, p.ty);
    for (const o of fn.outputs) binds.set(o.cName, o.ty);
    for (const [k, v] of fn.assignedVars) binds.set(k, v.ty);
    fn.body = rewriteStmts(fn.body, mapFromTypeMap(binds));
    // Also rewrite the assignedVars entries (their internal struct
    // shapes are already the final widened ones — but their field
    // types may transitively include other struct types that we need
    // to also normalize. In v1 that's a no-op since field types come
    // straight from unify on field values, not on cross-variable
    // references).
  }
}

function mapFromTypeMap(
  m: ReadonlyMap<string, MType>
): Map<string, VarBinding> {
  const out = new Map<string, VarBinding>();
  for (const [k, v] of m) out.set(k, { cName: k, ty: v });
  return out;
}

function rewriteStmts(
  stmts: ReadonlyArray<IRStmt>,
  binds: ReadonlyMap<string, VarBinding>
): IRStmt[] {
  return stmts.map(s => rewriteStmt(s, binds));
}

function rewriteStmt(
  s: IRStmt,
  binds: ReadonlyMap<string, VarBinding>
): IRStmt {
  switch (s.kind) {
    case "Assign": {
      let newRhs = rewriteExpr(s.rhs, binds);
      // If the LHS is a struct binding, update s.ty to match the
      // post-widening type so the codegen emits a consistent typedef
      // for the predeclaration vs the assign site.
      const finalTy =
        isStruct(s.ty) && binds.has(s.cName) ? binds.get(s.cName)!.ty : s.ty;
      // If the RHS is a StructLit and the surrounding Assign got
      // widened, also widen the literal's ty so emitExpr produces
      // the same typedef name as the LHS binding expects.
      if (newRhs.kind === "StructLit" && isStruct(finalTy)) {
        newRhs = { ...newRhs, ty: finalTy };
      }
      return { ...s, rhs: newRhs, ty: finalTy };
    }
    case "MemberStore": {
      const newBase = rewriteExpr(s.base, binds) as Extract<
        IRExpr,
        { kind: "Var" }
      >;
      const newRhs = rewriteExpr(s.rhs, binds);
      // The leaf type is derived from walking the final struct type
      // along the fieldPath.
      const leafTy = resolveFieldPathType(newBase.ty, s.fieldPath) ?? s.leafTy;
      return { ...s, base: newBase, rhs: newRhs, leafTy };
    }
    case "ExprStmt":
      return { ...s, expr: rewriteExpr(s.expr, binds) };
    case "Disp":
      return { ...s, arg: rewriteExpr(s.arg, binds) };
    case "Error":
      return { ...s, arg: rewriteExpr(s.arg, binds) };
    case "Assert":
      return {
        ...s,
        cond: rewriteExpr(s.cond, binds),
        msg: s.msg === null ? null : rewriteExpr(s.msg, binds),
      };
    case "Fprintf":
      return {
        ...s,
        fmt: rewriteExpr(s.fmt, binds),
        args: s.args.map(a => rewriteExpr(a, binds)),
      };
    case "If":
      return {
        ...s,
        cond: rewriteExpr(s.cond, binds),
        thenBody: rewriteStmts(s.thenBody, binds),
        elseifs: s.elseifs.map(eif => ({
          cond: rewriteExpr(eif.cond, binds),
          body: rewriteStmts(eif.body, binds),
        })),
        elseBody: s.elseBody === null ? null : rewriteStmts(s.elseBody, binds),
      };
    case "While":
      return {
        ...s,
        cond: rewriteExpr(s.cond, binds),
        body: rewriteStmts(s.body, binds),
      };
    case "For":
      return {
        ...s,
        start: rewriteExpr(s.start, binds),
        step: rewriteExpr(s.step, binds),
        end: rewriteExpr(s.end, binds),
        body: rewriteStmts(s.body, binds),
      };
    case "IndexStore":
      return {
        ...s,
        base: rewriteExpr(s.base, binds) as Extract<IRExpr, { kind: "Var" }>,
        indices: s.indices.map(i => rewriteExpr(i, binds)),
        rhs: rewriteExpr(s.rhs, binds),
      };
    case "IndexSliceStore":
      return {
        ...s,
        base: rewriteExpr(s.base, binds) as Extract<IRExpr, { kind: "Var" }>,
        index: s.index.map(slot => rewriteSliceArg(slot, binds)),
        rhs: rewriteExpr(s.rhs, binds),
      };
    case "MultiAssignCall":
      return { ...s, args: s.args.map(a => rewriteExpr(a, binds)) };
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return s;
  }
}

function rewriteSliceArg(
  arg: IndexSliceArg,
  binds: ReadonlyMap<string, VarBinding>
): IndexSliceArg {
  if (arg.kind === "Colon") return arg;
  if (arg.kind === "Scalar")
    return { ...arg, expr: rewriteExpr(arg.expr, binds) };
  return {
    ...arg,
    start: rewriteExpr(arg.start, binds),
    step: rewriteExpr(arg.step, binds),
    end: rewriteExpr(arg.end, binds),
  };
}

function rewriteExpr(
  e: IRExpr,
  binds: ReadonlyMap<string, VarBinding>
): IRExpr {
  switch (e.kind) {
    case "Var": {
      if (isStruct(e.ty) && binds.has(e.cName)) {
        return { ...e, ty: binds.get(e.cName)!.ty };
      }
      return e;
    }
    case "MemberLoad": {
      const newBase = rewriteExpr(e.base, binds);
      // After base normalization, walk to the field type.
      const ty = resolveFieldPathType(newBase.ty, [e.field]) ?? e.ty;
      return { ...e, base: newBase, ty };
    }
    case "StructLit":
      return {
        ...e,
        fields: e.fields.map(f => ({
          name: f.name,
          value: rewriteExpr(f.value, binds),
        })),
      };
    case "Binary":
      return {
        ...e,
        left: rewriteExpr(e.left, binds),
        right: rewriteExpr(e.right, binds),
      };
    case "Unary":
      return { ...e, operand: rewriteExpr(e.operand, binds) };
    case "Call":
      return { ...e, args: e.args.map(a => rewriteExpr(a, binds)) };
    case "TensorLit":
      return {
        ...e,
        elements: e.elements.map(row =>
          row.map(cell => rewriteExpr(cell, binds))
        ),
      };
    case "IndexLoad":
      return {
        ...e,
        base: rewriteExpr(e.base, binds) as Extract<IRExpr, { kind: "Var" }>,
        indices: e.indices.map(i => rewriteExpr(i, binds)),
      };
    case "IndexSlice":
      return {
        ...e,
        base: rewriteExpr(e.base, binds) as Extract<IRExpr, { kind: "Var" }>,
        index: e.index.map(slot => rewriteSliceArg(slot, binds)),
      };
    case "MakeRange":
      return {
        ...e,
        start: rewriteExpr(e.start, binds),
        step: rewriteExpr(e.step, binds),
        end: rewriteExpr(e.end, binds),
      };
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "EndRef":
    case "HandleLit":
      return e;
  }
}

/** Walk a field path through a struct type and return the leaf's
 *  type, or null if the path doesn't exist. */
function resolveFieldPathType(
  ty: MType,
  path: ReadonlyArray<string>
): MType | null {
  let cur: MType = ty;
  for (const name of path) {
    if (!isStruct(cur)) return null;
    const sty: StructType = cur;
    const f = sty.fields.find(ff => ff.name === name);
    if (!f) return null;
    cur = f.type;
  }
  return cur;
}
