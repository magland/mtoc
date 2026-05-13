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
import {
  isHandle,
  isHomogeneousCell,
  isStruct,
  isTupleCell,
  type HandleType,
  type MType,
  type StructType,
} from "./types.js";

/** Rewrite every struct-typed expression in the program so the type
 *  comes from the variable's binding in the relevant scope. */
export function normalizeStructTypes(prog: IRProgram): void {
  // Per-scope: cName → final type. For main, we use prog.assignedVars
  // directly. For each function, we build a combined map from params,
  // outputs, and the function's assignedVars (later wins on duplicate
  // keys, but they shouldn't overlap).
  prog.stmts = rewriteStmts(prog.stmts, prog.assignedVars);
  normalizeAssignedVars(prog.assignedVars);
  for (const fn of prog.functions) {
    const binds = new Map<string, MType>();
    for (const p of fn.params) binds.set(p.cName, p.ty);
    for (const o of fn.outputs) binds.set(o.cName, o.ty);
    for (const [k, v] of fn.assignedVars) binds.set(k, v.ty);
    const wrapped = mapFromTypeMap(binds);
    fn.body = rewriteStmts(fn.body, wrapped);
    normalizeAssignedVars(fn.assignedVars);
    // Normalize handle-typed params/outputs too — their captures may
    // hold stale struct types referencing the enclosing-scope's
    // bindings.
    fn.params = fn.params.map(p =>
      isHandle(p.ty) ? { ...p, ty: normalizeHandleType(p.ty, wrapped) } : p
    );
    fn.outputs = fn.outputs.map(o =>
      isHandle(o.ty) ? { ...o, ty: normalizeHandleType(o.ty, wrapped) } : o
    );
  }
}

/** Normalize handle-typed entries in an assignedVars map: the
 *  predeclaration uses the binding's type to pick a C type, so the
 *  binding must reflect the normalized HandleType (with binds-aligned
 *  captures) or the predecl and the assign site disagree. */
function normalizeAssignedVars(assignedVars: Map<string, VarBinding>): void {
  // Build a `binds`-shape view of the same map so the helper can
  // look up by cName.
  const wrapped: ReadonlyMap<string, VarBinding> = assignedVars;
  for (const [k, v] of assignedVars) {
    if (isHandle(v.ty)) {
      assignedVars.set(k, {
        ...v,
        ty: normalizeHandleType(v.ty, wrapped),
      });
    }
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
      let finalTy: MType = s.ty;
      if (isStruct(s.ty) && binds.has(s.cName)) {
        finalTy = binds.get(s.cName)!.ty;
      } else if (isHandle(s.ty)) {
        // For handle bindings: the binds map's stored HandleType may
        // itself have stale captures, so normalize it before adopting
        // it as the LHS type. The RHS HandleLit was normalized via
        // `rewriteExpr` above and is the authoritative shape; use
        // its ty as the final LHS type so the predecl, the assign
        // site, and any later reads all see the same typedef.
        if (newRhs.kind === "HandleLit" && isHandle(newRhs.ty)) {
          finalTy = newRhs.ty;
        } else if (binds.has(s.cName)) {
          finalTy = normalizeHandleType(
            binds.get(s.cName)!.ty as HandleType,
            binds
          );
        } else {
          finalTy = normalizeHandleType(s.ty, binds);
        }
      }
      // If the RHS is a StructLit and the surrounding Assign got
      // widened, also widen the literal's ty so emitExpr produces
      // the same typedef name as the LHS binding expects.
      if (newRhs.kind === "StructLit" && isStruct(finalTy)) {
        newRhs = { ...newRhs, ty: finalTy };
      }
      // Same widening rule for cell literals: the LHS binding's
      // post-widening type may have updated per-slot types (tuple)
      // or elem (homogeneous), and the literal's `ty` needs to
      // match so the emitted typedef name agrees with the predecl.
      if (isTupleCell(s.ty) && binds.has(s.cName)) {
        finalTy = binds.get(s.cName)!.ty;
      } else if (isHomogeneousCell(s.ty) && binds.has(s.cName)) {
        finalTy = binds.get(s.cName)!.ty;
      }
      if (
        newRhs.kind === "CellLit" &&
        (isTupleCell(finalTy) || isHomogeneousCell(finalTy))
      ) {
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
    case "CellIndexStore": {
      const newBase = rewriteExpr(s.base, binds) as Extract<
        IRExpr,
        { kind: "Var" }
      >;
      const newRhs = rewriteExpr(s.rhs, binds);
      const newIndex = rewriteExpr(s.index, binds);
      // Re-derive the slot type from the (possibly widened) base
      // type so the consume-site `_assign` helper picks up the
      // canonical typedef.
      const slotTy = resolveCellSlotType(newBase.ty, s.index) ?? s.slotTy;
      return {
        ...s,
        base: newBase,
        index: newIndex,
        rhs: newRhs,
        slotTy,
      };
    }
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
      if (isHandle(e.ty)) {
        return { ...e, ty: normalizeHandleType(e.ty, binds) };
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
      return e;
    case "HandleLit": {
      // Rewrite the captured VALUES' tys AND the HandleType's
      // captures' tys (which determine the C struct field types) so
      // both line up against the final widened struct types in
      // `binds`. Without this, a struct-typed capture taken at the
      // @-site (when `s` was `Struct<{a:+, b:+}>`) but later widened
      // (to `Struct<{a:+, b:nonneg}>`) would emit a typedef whose
      // `cap_s` field disagrees with the call-site copy helper.
      const newCaptures = e.captures.map(c => ({
        name: c.name,
        value: rewriteExpr(c.value, binds),
      }));
      const newTy = isHandle(e.ty) ? normalizeHandleType(e.ty, binds) : e.ty;
      return { ...e, captures: newCaptures, ty: newTy };
    }
    case "HandleCaptureLoad": {
      // Rewrite the base (so its HandleType reflects post-widening
      // capture shapes), then derive the load's `ty` from the base's
      // normalized HandleType. Without this, a HandleCaptureLoad
      // built at @-site time would carry a stale capture type while
      // the handle struct's field has the binds-normalized type.
      const newBase = rewriteExpr(e.base, binds) as Extract<
        IRExpr,
        { kind: "Var" }
      >;
      let newTy = e.ty;
      if (isHandle(newBase.ty)) {
        const cap = newBase.ty.captures.find(c => c.name === e.captureName);
        if (cap !== undefined) newTy = cap.ty;
      }
      return { ...e, base: newBase, ty: newTy };
    }
    case "CellLit": {
      // Rewrite each element; if the LHS binding's type widened, the
      // surrounding Assign's `ty` carries that widening — `rewriteStmt`
      // re-applies it to the CellLit's `ty` similarly to the StructLit
      // path. Here we only normalize the children.
      const elements = e.elements.map(el => rewriteExpr(el, binds));
      return { ...e, elements };
    }
    case "CellIndexLoad": {
      // Re-derive the slot type from the (possibly widened) base
      // type so consume-site dispatch picks up the canonical typedef.
      const newBase = rewriteExpr(e.base, binds);
      const newIndex = rewriteExpr(e.index, binds);
      const newTy = resolveCellSlotType(newBase.ty, newIndex) ?? e.ty;
      return { ...e, base: newBase, index: newIndex, ty: newTy };
    }
  }
}

/** Rewrite a `HandleType`'s capture-tuple types using `binds`. The
 *  capture name is the same identifier as the captured variable's
 *  scope-level binding, so we look it up directly. Returns a fresh
 *  HandleType with normalized captures; leaves the target unchanged. */
function normalizeHandleType(
  h: HandleType,
  binds: ReadonlyMap<string, VarBinding>
): HandleType {
  if (h.captures.length === 0) return h;
  const newCaptures = h.captures.map(c => {
    if (binds.has(c.name)) {
      return { name: c.name, ty: binds.get(c.name)!.ty };
    }
    if (isHandle(c.ty)) {
      return { name: c.name, ty: normalizeHandleType(c.ty, binds) };
    }
    return c;
  });
  return { ...h, captures: newCaptures };
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

/** Resolve the slot MType of a `c{idx}` access against the (possibly
 *  widened) cell type `ty`. Tuple cells consult `slots[k-1]` from the
 *  literal-index expression; homogeneous cells return the cell's
 *  `elem` regardless of the index expression. Returns null when the
 *  base type isn't a cell, when a tuple-cell index isn't a NumLit, or
 *  when the index is out of range. */
function resolveCellSlotType(ty: MType, index: IRExpr): MType | null {
  if (isTupleCell(ty)) {
    if (index.kind !== "NumLit") return null;
    const k = index.value;
    if (!Number.isInteger(k) || k < 1 || k > ty.slots.length) return null;
    return ty.slots[k - 1];
  }
  if (isHomogeneousCell(ty)) return ty.elem;
  return null;
}
