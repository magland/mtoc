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

import type {
  IRExpr,
  IRProgram,
  IRStmt,
  IndexSliceArg,
  VarBinding,
} from "./ir.js";
import {
  isMultiElement,
  isOwned,
  isString,
  isStruct,
  type MType,
} from "./types.js";
import { isElementwiseBuiltin } from "./lowerFuncCall.js";

/** Counter shared across the whole program so synthetic temp names
 *  stay deterministic and unique. Boxed in an object so passes can
 *  mutate it without threading a return value. */
interface AnfCounter {
  value: number;
}

/** Discriminated kinds of "owned producer" expression — used by
 *  `classifyOwnedExpr` so the post-ANF validator can render kind-
 *  specific error messages when an owned producer slips past the
 *  hoist. */
export type OwnedExprKind =
  | "tensor-lit"
  | "string-concat"
  | "index-slice"
  | "make-range"
  | "user-call"
  | "builtin-call"
  | "struct-lit";

/** Classify `e` as an "owned producer" — an expression that, when
 *  evaluated, returns a freshly-allocated heap-backed value (tensor /
 *  char tensor / string) — or return `null` if it is not one. Single
 *  source of truth for owned-producer recognition; consumed by the
 *  ANF pass (lifting decision) and the post-ANF validator (error
 *  message). After ANF every such expression sits as the full RHS of
 *  an owned-LHS `Assign`. */
export function classifyOwnedExpr(e: IRExpr): OwnedExprKind | null {
  if (e.kind === "TensorLit") return "tensor-lit";
  if (e.kind === "Binary" && isString(e.ty)) return "string-concat";
  if (e.kind === "IndexSlice") return "index-slice";
  if (e.kind === "MakeRange") return "make-range";
  if (e.kind === "StructLit") return "struct-lit";
  if (e.kind === "Call" && isOwned(e.ty)) {
    if (e.callee.kind === "userFunc") return "user-call";
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
      return "builtin-call";
    }
  }
  return null;
}

/** Boolean shim over `classifyOwnedExpr` for sites that just need to
 *  decide "is this an owned producer?" without caring which kind. */
export function isOwnedProducer(e: IRExpr): boolean {
  return classifyOwnedExpr(e) !== null;
}

/** True when `e` is an owned-producing `Call` that codegen consumes
 *  directly into an owned LHS via `mtoc_<kind>_assign(&lhs, foo(...))`
 *  — i.e. a user-function call or a builtin Call flagged
 *  `producesOwnedDirectly`. Used by emitExpr / emitStmt to detect the
 *  "direct consume" path that bypasses the iter-loop materialization
 *  machinery. */
export function isDirectOwnedCall(e: IRExpr): boolean {
  if (e.kind !== "Call") return false;
  if (e.callee.kind === "userFunc") return true;
  return (
    e.callee.kind === "builtin" && e.callee.sig.producesOwnedDirectly === true
  );
}

/** Human-readable explanation for an `OwnedExprKind` that survived the
 *  ANF pass — used by the post-ANF validator's `UnsupportedConstruct`
 *  throws. Marked `"internal:"` because the ANF pass should have
 *  hoisted these; arriving here is an mtoc bug, not a user error. */
export function ownedExprMessage(kind: OwnedExprKind): string {
  switch (kind) {
    case "tensor-lit":
      return (
        "internal: tensor literal still nested inside another expression " +
        "after ANF; ANF pass should have hoisted it"
      );
    case "string-concat":
      return (
        "internal: string concatenation still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
    case "index-slice":
      return (
        "internal: range/colon index slice still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
    case "make-range":
      return (
        "internal: bare range expression still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
    case "user-call":
      return (
        "internal: owned-returning user-function call still nested " +
        "inside another expression after ANF; ANF pass should have " +
        "hoisted it"
      );
    case "builtin-call":
      return (
        "internal: owned-returning builtin call still nested inside " +
        "another expression after ANF; ANF pass should have hoisted it"
      );
    case "struct-lit":
      return (
        "internal: struct literal still nested inside another " +
        "expression after ANF; ANF pass should have hoisted it"
      );
  }
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
      const newArg = anfRequireHandle(s.arg, pre, av, c);
      return [...pre, { ...s, arg: newArg }];
    }
    case "Error": {
      const pre: IRStmt[] = [];
      const newArg = anfRequireHandle(s.arg, pre, av, c);
      return [...pre, { ...s, arg: newArg }];
    }
    case "Assert": {
      const pre: IRStmt[] = [];
      const newCond = anfExpr(s.cond, pre, av, c);
      const newMsg =
        s.msg === null ? null : anfRequireHandle(s.msg, pre, av, c);
      return [...pre, { ...s, cond: newCond, msg: newMsg }];
    }
    case "Fprintf": {
      const pre: IRStmt[] = [];
      const newFmt = anfRequireHandle(s.fmt, pre, av, c);
      const newArgs = s.args.map(a => anfRequireHandle(a, pre, av, c));
      return [...pre, { ...s, fmt: newFmt, args: newArgs }];
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
      const newIndex = s.index.map(slot => anfSliceArg(slot, pre, av, c));
      const newRhs = anfExpr(s.rhs, pre, av, c);
      return [...pre, { ...s, index: newIndex, rhs: newRhs }];
    }
    case "MemberStore": {
      // The RHS may be any owned producer — a struct literal, a
      // tensor literal, a string concat, a user-func call returning
      // an owned kind, etc. We treat MemberStore as a "consume site"
      // for those: hoist any nested owned producer to a temp, then
      // let codegen route the temp through `mtoc_<kind>_assign` (for
      // owned fields) or a bare assignment (for scalar fields).
      const pre: IRStmt[] = [];
      const newRhs = anfRequireHandle(s.rhs, pre, av, c);
      return [...pre, { ...s, rhs: newRhs }];
    }
    case "MultiAssignCall": {
      // User-function multi-output call: every tensor arg lands in
      // the callee via copy-on-arg-pass, which requires a full
      // struct handle. Multi-element non-Var args must be hoisted.
      const pre: IRStmt[] = [];
      const newArgs = s.args.map(a => anfRequireHandle(a, pre, av, c));
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
    case "Call": {
      // Elementwise builtins lift their args slot-by-slot inside the
      // surrounding iter loop, so multi-element Binary/Unary/Call
      // args are fine as-is. Every other Call (reductions, user-
      // functions, direct-owned builtins like size/reshape) consumes
      // its args as full struct handles — multi-element non-Var args
      // must be hoisted to a temp.
      const isElementwise =
        e.callee.kind === "builtin" && isElementwiseBuiltin(e.callee.sig);
      const liftArg = isElementwise ? anfExpr : anfRequireHandle;
      return { ...e, args: e.args.map(a => liftArg(a, pre, av, c)) };
    }
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
      return {
        ...e,
        index: e.index.map(slot => anfSliceArg(slot, pre, av, c)),
      };
    case "MakeRange":
      return {
        ...e,
        start: anfExpr(e.start, pre, av, c),
        step: anfExpr(e.step, pre, av, c),
        end: anfExpr(e.end, pre, av, c),
      };
    case "StructLit":
      // Each field value gets the standard ANF treatment — owned
      // producers (tensor lits, nested struct lits, user-func calls
      // returning an owned kind) get lifted to a temp; multi-element
      // expressions that aren't owned producers get hoisted via the
      // handle-lift path so codegen can consume an addressable Var.
      return {
        ...e,
        fields: e.fields.map(f => ({
          name: f.name,
          value: anfRequireHandle(f.value, pre, av, c),
        })),
      };
    case "MemberLoad":
      return { ...e, base: anfExpr(e.base, pre, av, c) };
    case "NumLit":
    case "ImagLit":
    case "StringLit":
    case "CharLit":
    case "Var":
    case "EndRef":
      return e;
  }
}

/** Recurse into an `IndexSliceArg` slot, normalizing any owned
 *  producers inside its sub-expressions. `Colon` is a leaf — return
 *  unchanged. */
function anfSliceArg(
  arg: IndexSliceArg,
  pre: IRStmt[],
  av: Map<string, VarBinding>,
  c: AnfCounter
): IndexSliceArg {
  if (arg.kind === "Colon") return arg;
  if (arg.kind === "Scalar") {
    return { ...arg, expr: anfExpr(arg.expr, pre, av, c) };
  }
  return {
    ...arg,
    start: anfExpr(arg.start, pre, av, c),
    step: anfExpr(arg.step, pre, av, c),
    end: anfExpr(arg.end, pre, av, c),
  };
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

/** Rewrite an expression and additionally hoist any resulting multi-
 *  element value that codegen needs as an addressable struct handle
 *  (`Var`). Use this at consume sites — `disp(arg)`, `error(arg)`,
 *  `assert(_, msg)`, `Fprintf` args, and `Call` args to anything
 *  except an elementwise-lifting builtin — where codegen can't walk
 *  the value slot-by-slot. After this pass returns, the input either
 *  has a scalar type or sits at one of the handle-shapes codegen
 *  accepts directly (`Var`, `CharLit`, `StringLit`, `NumLit`-on-scalar,
 *  `TensorLit`/`IndexSlice`/`MakeRange` already hoisted by the owned-
 *  producer rule).
 *
 *  The lift target is the entire `recursed` expression — a synthetic
 *  `_mtoc_anf_<N> = <expr>;` Assign is appended to `pre`, and a `Var`
 *  reading that temp replaces the original use. Codegen then handles
 *  the synthetic Assign via the standard elementwise-loop emit path
 *  (the temp's type is multi-element, so `emitTensorAssignFromExpr`
 *  iterates slot-by-slot, reading any inner Vars per-slot). */
function anfRequireHandle(
  e: IRExpr,
  pre: IRStmt[],
  av: Map<string, VarBinding>,
  c: AnfCounter
): IRExpr {
  const recursed = anfExpr(e, pre, av, c);
  if (!needsHandleLift(recursed)) return recursed;
  return liftToTemp(recursed, pre, av, c);
}

/** True when a fully-anf'd `IRExpr` still needs to be hoisted to a
 *  Var for its consumer. Multi-element non-Var non-handle shapes
 *  (Binary, Unary, elementwise-builtin Call) are the target.
 *  Structs are always handle-like — non-Var struct expressions
 *  (`MemberLoad`, `StructLit`) get hoisted at consume sites so
 *  codegen always sees a Var or a direct-consume StructLit. */
function needsHandleLift(e: IRExpr): boolean {
  if (isStruct(e.ty)) {
    // A bare Var of a struct type is already a handle — consume
    // sites can read from it directly. StructLit is an owned producer
    // and gets lifted by the owned-producer path. Anything else
    // (MemberLoad on a struct field) needs hoisting because codegen
    // can't pass a field-load expression by value through a
    // copy-on-arg-pass wrapper.
    return e.kind !== "Var" && e.kind !== "StructLit";
  }
  if (!isMultiElement(e.ty)) return false;
  switch (e.kind) {
    case "Var":
    case "CharLit":
    case "TensorLit":
    case "IndexSlice":
    case "MakeRange":
      // Either already a handle, or an owned producer that the
      // standard anfExpr path has already hoisted to a Var by this
      // point (so we never see these post-anfExpr — but keep them
      // here for clarity / belt-and-suspenders).
      return false;
    default:
      return true;
  }
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
