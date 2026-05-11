/**
 * A-normalization pass — hoists every owned-producing sub-expression
 * out of larger expressions into its own synthetic `Assign` to a
 * fresh `_mtoc_anf_<N>` temp. After this pass the IR satisfies a
 * tight invariant:
 *
 *   An "owned-producing" expression (TensorLit, IndexSlice, string
 *   `Binary` (concat), or `Call(userFunc)` whose result is `isOwned`)
 *   only appears as the entire `rhs` of an `Assign` whose LHS type
 *   matches the producer's kind.
 *
 * That invariant collapses the codegen consume-site logic to a
 * single path: every owned producer flows directly into an owned-LHS
 * `mtoc_<kind>_assign(&lhs, producer)`, freeing the prior buffer and
 * installing the new one. Lifetimes of the synthetic temps are then
 * managed by the existing liveness pass (`computeFutureTouches`) and
 * scope-exit free walks — they're ordinary entries in `assignedVars`.
 *
 * This unifies a previously scattered set of rules:
 *   - the codegen "call temp" pre-pass in `emitTensorAssignFromExpr`,
 *   - the validator's `checkUserCallNesting` / `assignRoutesToMaterialization`,
 *   - the patchwork "can a user-func tensor call appear here?" tables.
 *
 * After ANF, what survives in the IR is uniform. New owned-producing
 * builtins (e.g. a future `zeros(N, M)`) plug in by extending
 * `isOwnedProducer` — every nested-use case becomes legal for free.
 */

import type { IRExpr, IRProgram, IRStmt, VarBinding } from "./ir.js";
import { isOwned, isString, type MType } from "./types.js";

/** Counter shared across the whole program so synthetic temp names
 *  stay deterministic and unique. Boxed in an object so passes can
 *  mutate it without threading a return value. */
interface AnfCounter {
  value: number;
}

/** True when `e` is an "owned producer" — an expression that, when
 *  evaluated, returns a freshly-allocated heap-backed value (tensor /
 *  char tensor / string). After ANF every such expression sits as the
 *  full RHS of an owned-LHS `Assign`. */
export function isOwnedProducer(e: IRExpr): boolean {
  if (e.kind === "TensorLit") return true;
  if (e.kind === "IndexSlice") return true;
  if (e.kind === "Binary" && isString(e.ty)) return true;
  if (e.kind === "Call" && isOwned(e.ty)) {
    if (e.callee.kind === "userFunc") return true;
    // Builtin calls flagged `producesOwnedDirectly` (e.g. `size(t)`,
    // `reshape(t, …)`, `zeros(N, M)`) return a fully-formed owned
    // value from a single C call and need ANF hoisting just like
    // userFunc calls. Elementwise lifts materialize per-slot via the
    // parent Assign's iter loop, so they are NOT owned producers in
    // the ANF sense.
    if (
      e.callee.kind === "builtin" &&
      e.callee.sig.producesOwnedDirectly === true
    ) {
      return true;
    }
  }
  return false;
}

/** Mutate `prog` in place, A-normalizing main's body and every
 *  function's body. Synthetic temps are registered in the relevant
 *  `assignedVars` map so codegen predeclares them and the
 *  scope-exit / early-free walks reclaim their buffers automatically. */
export function anfNormalize(prog: IRProgram): void {
  const counter: AnfCounter = { value: 0 };
  for (const fn of prog.functions) {
    fn.body = anfStmts(fn.body, fn.assignedVars, counter);
  }
  prog.stmts = anfStmts(prog.stmts, prog.assignedVars, counter);
}

function anfStmts(
  stmts: ReadonlyArray<IRStmt>,
  assignedVars: Map<string, VarBinding>,
  counter: AnfCounter
): IRStmt[] {
  const out: IRStmt[] = [];
  for (const s of stmts) {
    for (const lowered of anfStmt(s, assignedVars, counter)) out.push(lowered);
  }
  return out;
}

/** Normalize a single statement. Returns the (possibly multi-stmt)
 *  replacement — synthetic Assigns prepend in source-evaluation order
 *  before the transformed original. */
function anfStmt(
  s: IRStmt,
  av: Map<string, VarBinding>,
  c: AnfCounter
): IRStmt[] {
  switch (s.kind) {
    case "Assign": {
      const pre: IRStmt[] = [];
      // If the RHS is itself an owned producer matching the LHS, it's
      // already at a direct consume site — recurse into its children
      // but don't lift the RHS itself. Otherwise treat the RHS like
      // any other expression position and lift any owned producers
      // anywhere inside.
      const direct = isOwnedProducer(s.rhs) && isOwned(s.ty);
      const newRhs = direct
        ? anfExprChildren(s.rhs, pre, av, c)
        : anfExpr(s.rhs, pre, av, c);
      return [...pre, { ...s, rhs: newRhs }];
    }
    case "ExprStmt": {
      const pre: IRStmt[] = [];
      const newExpr = anfExpr(s.expr, pre, av, c);
      return [...pre, { ...s, expr: newExpr }];
    }
    case "Disp": {
      const pre: IRStmt[] = [];
      const newArg = anfExpr(s.arg, pre, av, c);
      return [...pre, { ...s, arg: newArg }];
    }
    case "Error": {
      const pre: IRStmt[] = [];
      const newArg = anfExpr(s.arg, pre, av, c);
      return [...pre, { ...s, arg: newArg }];
    }
    case "Assert": {
      const pre: IRStmt[] = [];
      const newCond = anfExpr(s.cond, pre, av, c);
      const newMsg = s.msg === null ? null : anfExpr(s.msg, pre, av, c);
      return [...pre, { ...s, cond: newCond, msg: newMsg }];
    }
    case "If": {
      const pre: IRStmt[] = [];
      const newCond = anfExpr(s.cond, pre, av, c);
      // Lifts in an `elseif` cond also hoist to before the entire If
      // — the synthetic call happens unconditionally, but user-func
      // calls in mtoc are pure (no observable side effects beyond
      // their return value), so this is semantically fine; the cost
      // is one extra eval when the cond would have short-circuited.
      const newElseifs = s.elseifs.map(eif => ({
        cond: anfExpr(eif.cond, pre, av, c),
        body: anfStmts(eif.body, av, c),
      }));
      const newThen = anfStmts(s.thenBody, av, c);
      const newElse = s.elseBody === null ? null : anfStmts(s.elseBody, av, c);
      return [
        ...pre,
        {
          ...s,
          cond: newCond,
          elseifs: newElseifs,
          thenBody: newThen,
          elseBody: newElse,
        },
      ];
    }
    case "While": {
      // The cond is re-evaluated per iteration; hoisting a lift to
      // before the loop would only call the helper once. The lowering
      // rejects multi-element conds (cond must be scalar) and there's
      // no scalar owned producer in numbl's surface (strings can't be
      // compared, scalar user-func returns are not owned), so in
      // practice this path never sees an owned producer. We still
      // recurse into the body normally.
      const newBody = anfStmts(s.body, av, c);
      return [{ ...s, body: newBody }];
    }
    case "For": {
      // start/step/end are scalar reals — owned producers can't appear
      // there in numbl's surface. Defensive ANF still descends so any
      // future relaxation lifts correctly.
      const pre: IRStmt[] = [];
      const newStart = anfExpr(s.start, pre, av, c);
      const newStep = anfExpr(s.step, pre, av, c);
      const newEnd = anfExpr(s.end, pre, av, c);
      const newBody = anfStmts(s.body, av, c);
      return [
        ...pre,
        { ...s, start: newStart, step: newStep, end: newEnd, body: newBody },
      ];
    }
    case "IndexStore": {
      const pre: IRStmt[] = [];
      const newIndices = s.indices.map(i => anfExpr(i, pre, av, c));
      const newRhs = anfExpr(s.rhs, pre, av, c);
      return [...pre, { ...s, indices: newIndices, rhs: newRhs }];
    }
    case "IndexSliceStore": {
      const pre: IRStmt[] = [];
      let newIndex = s.index;
      if (s.index.kind === "Range") {
        newIndex = {
          ...s.index,
          start: anfExpr(s.index.start, pre, av, c),
          step: anfExpr(s.index.step, pre, av, c),
          end: anfExpr(s.index.end, pre, av, c),
        };
      }
      const newRhs = anfExpr(s.rhs, pre, av, c);
      return [...pre, { ...s, index: newIndex, rhs: newRhs }];
    }
    case "MultiAssignCall": {
      const pre: IRStmt[] = [];
      const newArgs = s.args.map(a => anfExpr(a, pre, av, c));
      return [...pre, { ...s, args: newArgs }];
    }
    case "Break":
    case "Continue":
    case "ReturnFromFunction":
      return [s];
  }
}

/** Recurse into an expression's children (without considering the
 *  expression itself for lifting). Used when the caller knows the
 *  outer node is already at a valid consume site — typically the RHS
 *  of an owned-LHS Assign. */
function anfExprChildren(
  e: IRExpr,
  pre: IRStmt[],
  av: Map<string, VarBinding>,
  c: AnfCounter
): IRExpr {
  switch (e.kind) {
    case "Binary":
      return {
        ...e,
        left: anfExpr(e.left, pre, av, c),
        right: anfExpr(e.right, pre, av, c),
      };
    case "Unary":
      return { ...e, operand: anfExpr(e.operand, pre, av, c) };
    case "Call":
      return { ...e, args: e.args.map(a => anfExpr(a, pre, av, c)) };
    case "TensorLit":
      return {
        ...e,
        elements: e.elements.map(row =>
          row.map(cell => anfExpr(cell, pre, av, c))
        ),
      };
    case "IndexLoad":
      return { ...e, indices: e.indices.map(i => anfExpr(i, pre, av, c)) };
    case "IndexSlice":
      if (e.index.kind === "Colon") return e;
      return {
        ...e,
        index: {
          ...e.index,
          start: anfExpr(e.index.start, pre, av, c),
          step: anfExpr(e.index.step, pre, av, c),
          end: anfExpr(e.index.end, pre, av, c),
        },
      };
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "Var":
    case "EndRef":
      return e;
  }
}

/** Rewrite an expression: recurse into its children first, then if
 *  the resulting node is an owned producer, hoist it to a fresh
 *  `_mtoc_anf_<N>` temp and return a `Var` reading the temp. */
function anfExpr(
  e: IRExpr,
  pre: IRStmt[],
  av: Map<string, VarBinding>,
  c: AnfCounter
): IRExpr {
  const recursed = anfExprChildren(e, pre, av, c);
  if (!isOwnedProducer(recursed)) return recursed;
  return liftToTemp(recursed, pre, av, c);
}

/** Emit a synthetic `Assign` of `producer` to a fresh `_mtoc_anf_<N>`
 *  C variable; register the temp in `assignedVars`; return a `Var`
 *  reading the temp at the producer's original span. */
function liftToTemp(
  producer: IRExpr,
  pre: IRStmt[],
  av: Map<string, VarBinding>,
  c: AnfCounter
): IRExpr {
  const cName = `_mtoc_anf_${c.value++}`;
  const ty: MType = producer.ty;
  av.set(cName, { cName, ty });
  pre.push({
    kind: "Assign",
    name: cName,
    cName,
    rhs: producer,
    ty,
    span: producer.span,
  });
  return {
    kind: "Var",
    name: cName,
    cName,
    ty,
    span: producer.span,
  };
}
