/**
 * Lowering helpers for cell-array literals and curly-brace indexing.
 *
 * Three entry points:
 *   - `lowerCellLiteral`         — `{e1, e2, …, eN}` (also `{}`).
 *   - `lowerCellIndexRead`       — `c{i}` (read).
 *   - `lowerCellIndexStore`      — `c{i} = rhs` (write).
 *
 * The pre-pass (`cellPrePass`) has decided per root variable whether
 * its static shape is a `TupleCellType` (fixed arity, all-constant
 * index access) or a `HomogeneousCellType` (variable length, uniform
 * element type). These helpers consult that decision to construct the
 * right MType and IR shape.
 */

import type { Expr, LValue, Span } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import type { IRExpr, IRStmt } from "./ir.js";
import { Lowerer } from "./lower.js";
import {
  homogeneousCellType,
  isHomogeneousCell,
  isScalarReal,
  isTupleCell,
  tupleCellType,
  typeToString,
  unify,
  type DimInfo,
  type MType,
} from "./types.js";

/** Lower a `{e1, …, eN}` cell-array constructor.
 *
 *  When the surrounding Assign's LHS has pre-pass shape `tuple`, the
 *  literal lowers to a `CellLit { cellKind: "tuple" }` with one IR
 *  expression per slot and a `TupleCellType` whose slots carry each
 *  cell's MType. When the LHS is pre-pass `homogeneous` (or the
 *  literal sits outside an assignment we can tag), the literal lowers
 *  to a `CellLit { cellKind: "homogeneous" }` whose `elem` is the
 *  unified slot type.
 *
 *  Without a known LHS context (e.g. `disp({1, 2})`), we default to
 *  homogeneous if every cell's type unifies, else reject — there's no
 *  variable to anchor a tuple shape to. */
export function lowerCellLiteral(
  lo: Lowerer,
  e: Extract<Expr, { type: "Cell" }>,
  /** Pre-pass shape kind for the binding this literal is being
   *  assigned to. `null` means the literal isn't a direct Assign RHS,
   *  so the lowerer has to decide on its own (homogeneous-or-reject). */
  lhsShapeKind: "tuple" | "homogeneous" | null,
  /** Expected slot count when `lhsShapeKind === "tuple"`. */
  expectedArity: number | null
): IRExpr {
  // v1: 1-D cell arrays only (a single source-level row).
  if (e.rows.length > 1) {
    throw new UnsupportedConstruct(
      `2-D / N-D cell literals (multiple rows) are not yet supported by mtoc`,
      e.span
    );
  }
  const cells = e.rows.length === 0 ? [] : e.rows[0];

  // Empty literal `{}`: must be homogeneous. The element type is
  // unknown until a later write — we use `unknown` numeric so the
  // first `c{i} = val` widens via `unify`.
  if (cells.length === 0) {
    if (lhsShapeKind === "tuple") {
      throw new UnsupportedConstruct(
        `empty cell literal '{}' is incompatible with the tuple-cell ` +
          `shape pre-pass-decided for this variable`,
        e.span
      );
    }
    return {
      kind: "CellLit",
      cellKind: "homogeneous",
      elements: [],
      ty: homogeneousCellType({ kind: "Unknown" }, { kind: "notOne" }),
      span: e.span,
    };
  }

  // Lower each element. Cells can hold any MType (numeric, string,
  // struct, handle, nested cell, …). For homogeneous cells, every
  // cell's type must unify to a single elem MType; for tuple cells,
  // per-slot types just need to be lowerable.
  const loweredCells: IRExpr[] = cells.map(c => lo.lowerExpr(c));

  if (lhsShapeKind === "tuple") {
    if (expectedArity !== null && loweredCells.length !== expectedArity) {
      throw new UnsupportedConstruct(
        `cell literal has ${loweredCells.length} slot(s) but the tuple ` +
          `cell binding was pre-pass-pinned to arity ${expectedArity}`,
        e.span
      );
    }
    const slots: MType[] = loweredCells.map(ce => ce.ty);
    return {
      kind: "CellLit",
      cellKind: "tuple",
      elements: loweredCells,
      ty: tupleCellType(slots),
      span: e.span,
    };
  }

  // Homogeneous path: unify every cell's type.
  let elemTy: MType = loweredCells[0].ty;
  for (let i = 1; i < loweredCells.length; i++) {
    const u = unify(elemTy, loweredCells[i].ty);
    if (u.kind === "Unknown") {
      throw new TypeError(
        `homogeneous cell literal has incompatible element types at slot 1 ` +
          `(${typeToString(elemTy)}) and slot ${i + 1} ` +
          `(${typeToString(loweredCells[i].ty)}); use a fresh variable or ` +
          `arrange the literal so all elements share one type`,
        cells[i].span
      );
    }
    elemTy = u;
  }
  const lenDim: DimInfo =
    loweredCells.length === 1 ? { kind: "one" } : { kind: "notOne" };
  return {
    kind: "CellLit",
    cellKind: "homogeneous",
    elements: loweredCells,
    ty: homogeneousCellType(elemTy, lenDim),
    span: e.span,
  };
}

/** Lower `c{i}` (read). Tuple cells require `i` to be a `NumLit`
 *  integer in `[1, arity]` so the slot type is statically known;
 *  homogeneous cells accept any scalar real index expression (1-based
 *  MATLAB index). The base can be any expression whose static type
 *  is a cell — typically a `Var`, but also a `MemberLoad`
 *  (`s.items{1}`) or a nested `CellIndexLoad` (`outer{1}{2}`). */
export function lowerCellIndexRead(
  lo: Lowerer,
  e: Extract<Expr, { type: "IndexCell" }>
): IRExpr {
  if (e.indices.length !== 1) {
    throw new UnsupportedConstruct(
      `${e.indices.length}-D curly-brace indexing is not yet supported ` +
        `(mtoc supports 1-D cell arrays only)`,
      e.span
    );
  }
  const baseIr = lo.lowerExpr(e.base);
  const baseTy = baseIr.ty;
  const idxIr = lo.lowerExpr(e.indices[0]);
  if (isTupleCell(baseTy)) {
    if (idxIr.kind !== "NumLit" || !Number.isInteger(idxIr.value)) {
      throw new UnsupportedConstruct(
        `tuple-cell base requires a literal integer index in '{}' (got a ` +
          `non-literal); use a homogeneous cell to allow variable indices`,
        e.indices[0].span
      );
    }
    const k = idxIr.value;
    if (k < 1 || k > baseTy.slots.length) {
      throw new TypeError(
        `tuple-cell base has arity ${baseTy.slots.length}; index ${k} ` +
          `out of range`,
        e.indices[0].span
      );
    }
    return {
      kind: "CellIndexLoad",
      base: baseIr,
      index: idxIr,
      ty: baseTy.slots[k - 1],
      span: e.span,
    };
  }
  if (isHomogeneousCell(baseTy)) {
    if (!isScalarReal(idxIr.ty)) {
      throw new TypeError(
        `cell index must be a real scalar (got ${typeToString(idxIr.ty)})`,
        e.indices[0].span
      );
    }
    return {
      kind: "CellIndexLoad",
      base: baseIr,
      index: idxIr,
      ty: baseTy.elem,
      span: e.span,
    };
  }
  throw new TypeError(
    `cannot apply curly-brace indexing to ${typeToString(baseTy)}: ` +
      `'{...}' is only valid on a cell array`,
    e.span
  );
}

/** Lower `c{i} = rhs`. For tuple cells, the slot's static type widens
 *  by unify with the RHS; for homogeneous cells, the elem type widens
 *  with the RHS as well. */
export function lowerCellIndexStore(
  lo: Lowerer,
  lvalue: Extract<LValue, { type: "IndexCell" }>,
  rhsExpr: Expr,
  span: Span
): IRStmt {
  if (lvalue.base.type !== "Ident") {
    throw new UnsupportedConstruct(
      `curly-brace assignment with a non-variable base is not yet supported`,
      span
    );
  }
  if (lvalue.indices.length !== 1) {
    throw new UnsupportedConstruct(
      `${lvalue.indices.length}-D curly-brace assignment is not yet ` +
        `supported (mtoc supports 1-D cell arrays only)`,
      span
    );
  }
  const rootName = lvalue.base.name;
  const idxIr = lo.lowerExpr(lvalue.indices[0]);
  const rhs = lo.lowerExpr(rhsExpr);

  // Consult the pre-pass shape map to decide the variable's cell
  // category. The pre-pass already pinned tuple/homogeneous via the
  // observed access pattern.
  const shape = lo.cell.shapes.get(rootName);
  if (shape === undefined) {
    throw new TypeError(
      `'${rootName}{...} = …' but the pre-pass did not classify ` +
        `'${rootName}' as a cell. This usually means the cell was assigned ` +
        `with a non-cell shape earlier in the same scope.`,
      span
    );
  }

  // Look up the current MType for the root (may not exist yet if this
  // is the first reference). Build the post-write MType by widening
  // the affected slot / elem with `rhs.ty`.
  const prevTy = lo.envLookup(rootName);
  let newTy: MType;
  if (shape.kind === "tuple") {
    if (idxIr.kind !== "NumLit" || !Number.isInteger(idxIr.value)) {
      throw new UnsupportedConstruct(
        `tuple cell '${rootName}' requires a literal integer index on ` +
          `assignment (got a non-literal)`,
        lvalue.indices[0].span
      );
    }
    const k = idxIr.value;
    if (k < 1 || k > shape.arity) {
      throw new TypeError(
        `tuple cell '${rootName}' has arity ${shape.arity}; index ${k} out ` +
          `of range`,
        lvalue.indices[0].span
      );
    }
    // Build / update the slots tuple.
    let slots: MType[];
    if (prevTy !== undefined && isTupleCell(prevTy)) {
      slots = prevTy.slots.slice();
    } else {
      slots = new Array<MType>(shape.arity).fill({ kind: "Unknown" });
    }
    const prevSlot = slots[k - 1];
    const merged =
      prevSlot.kind === "Unknown" ? rhs.ty : unify(prevSlot, rhs.ty);
    if (merged.kind === "Unknown") {
      throw new TypeError(
        `tuple cell '${rootName}{${k}} = …': cannot unify prior slot type ` +
          `${typeToString(prevSlot)} with new RHS type ${typeToString(rhs.ty)}`,
        span
      );
    }
    slots[k - 1] = merged;
    newTy = tupleCellType(slots);
  } else {
    // Homogeneous: index must be scalar real; elem widens with rhs.
    if (!isScalarReal(idxIr.ty)) {
      throw new TypeError(
        `cell index must be a real scalar (got ${typeToString(idxIr.ty)})`,
        lvalue.indices[0].span
      );
    }
    let elem: MType = rhs.ty;
    let len: DimInfo = { kind: "notOne" };
    if (prevTy !== undefined && isHomogeneousCell(prevTy)) {
      if (prevTy.elem.kind === "Unknown") {
        elem = rhs.ty;
      } else {
        const u = unify(prevTy.elem, rhs.ty);
        if (u.kind === "Unknown") {
          throw new TypeError(
            `homogeneous cell '${rootName}': cannot unify prior elem type ` +
              `${typeToString(prevTy.elem)} with new RHS type ` +
              `${typeToString(rhs.ty)}`,
            span
          );
        }
        elem = u;
      }
      // A curly-index assignment doesn't shrink length — keep the
      // prior len as a floor. If it was `one`, an out-of-range write
      // would extend, so widen to `notOne` (any-length).
      len = prevTy.len.kind === "one" ? { kind: "notOne" } : prevTy.len;
    }
    newTy = homogeneousCellType(elem, len);
  }

  // Record the updated cell type on the variable. This widens the
  // assignedVars binding so codegen emits one stable typedef.
  const cName = lo.recordAssignment(rootName, newTy, span);
  const baseVar: Extract<IRExpr, { kind: "Var" }> = {
    kind: "Var",
    name: rootName,
    cName,
    ty: newTy,
    span: lvalue.base.span,
  };
  // Slot type for the store: either the widened tuple slot or the
  // homogeneous elem.
  const slotTy: MType = isTupleCell(newTy)
    ? newTy.slots[(idxIr as Extract<IRExpr, { kind: "NumLit" }>).value - 1]
    : (newTy as ReturnType<typeof homogeneousCellType>).elem;
  return {
    kind: "CellIndexStore",
    base: baseVar,
    index: idxIr,
    rhs,
    slotTy,
    span,
  };
}
