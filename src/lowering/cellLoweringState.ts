/**
 * Per-scope state for cell-array lowering.
 *
 * Owned by `Lowerer.cell`; mirrors the shape of `StructLoweringState`.
 * The pre-pass (`cellPrePass.collectCellShapes`) decides per root
 * variable whether the cell is a `TupleCellType` (fixed arity,
 * all-constant-index access) or a `HomogeneousCellType` (variable
 * length, uniform element type). This decision is pinned once at the
 * top of a body via `primeFromBody`, and `lowerCell.ts` consults it on
 * every cell-shape assignment / curly-index reference to know which
 * variant to construct.
 */

import type { Stmt } from "../parser/index.js";
import { collectCellShapes, type CellShapeMap } from "./cellPrePass.js";

export class CellLoweringState {
  /** Per-root cell-shape decision computed by `collectCellShapes`
   *  before body lowering starts. Empty when no cell literals or
   *  curly-brace accesses appear in the scope. */
  shapes: CellShapeMap = new Map();

  /** Populate `shapes` for the body about to be lowered. Called once
   *  before the body's stmts are visited. Calling again on the same
   *  instance overwrites the prior map (intentional — primeFromBody
   *  on an inner Lowerer should start from a clean slate). */
  primeFromBody(body: ReadonlyArray<Stmt>): void {
    this.shapes = collectCellShapes(body);
  }
}
