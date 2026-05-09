/**
 * Statement-level codegen.
 *
 * `emitStmt` is the dispatch that takes one IRStmt and pushes the
 * corresponding C lines into `state.lines`. It dispatches on
 * `stmt.kind`, with the `Assign` arm doing further dispatch on
 * `(rhs.kind, ty)` to pick between scalar / owned / TensorLit /
 * elementwise-loop emission paths.
 *
 * Co-located here:
 *   - `analyzeStmts`: pre-walk that flips header flags for every
 *     `analyzeExpr` reachable from a stmt tree.
 *   - `deadAfterStmt` / `emitEarlyFrees`: liveness-driven free
 *     emission anchored to one stmt's program point.
 *   - `emitTensorAssignFromExpr` / `emitTensorLitAssign`: the two
 *     tensor-only Assign paths.
 *   - `findShapeSourceVar` / `findCharLitShapeSource` /
 *     `collectMultiElementVarsByCName`: shape-inference walkers used
 *     by the elementwise-loop emission.
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import {
  cTypeFor,
  isCharScalar,
  isColVec,
  isMultiElement,
  isNumeric,
  isOwned,
  isRowVec,
  isScalarComplex,
  isScalarReal,
  typeToString,
  type NumericType,
} from "../lowering/types.js";
import {
  findInExpr,
  forEachStmtInTree,
  forEachSubExpr,
  forEachTopLevelExpr,
} from "../lowering/walk.js";
import { topLevelOwnedDefs, topLevelOwnedUses } from "./liveness.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import { emitScopeExitFrees } from "./emitOwned.js";
import { analyzeExpr, emitExpr, wrapOwnedArgCopy } from "./emitExpr.js";
import { formatNumLit } from "./emitFormat.js";

/**
 * Statement-level companion to `analyzeExpr`. Visits every stmt in the
 * tree (parents before bodies via `forEachStmtInTree`), runs
 * `analyzeExpr` over each stmt's directly-held expressions, and sets
 * `needMath` for stmt kinds whose codegen always emits a math.h call:
 *   - For: the iteration-count formula uses `floor()`.
 *   - MultiAssignCall: mirrors the `Call` case in `analyzeExpr` —
 *     every user-function call we currently emit pulls in <math.h>.
 */
export function analyzeStmts(
  state: EmitState,
  stmts: ReadonlyArray<IRStmt>
): void {
  forEachStmtInTree(stmts, s => {
    if (s.kind === "For" || s.kind === "MultiAssignCall") {
      state.needMath.value = true;
    }
    forEachTopLevelExpr(s, e => analyzeExpr(state, e));
  });
}

/** Owned C-names (tensors and strings) that should be freed
 *  immediately after `s`, computed from the future-touch set produced
 *  by the dataflow pass. A name is "dead-after" iff it appears in
 *  `s`'s top-level uses or defs but is NOT touched (read or written)
 *  at any successor — i.e. `s` was its last touch on this level.
 *  Returns sorted (stable C output) and excludes names already freed
 *  on this linear path. */
function deadAfterStmt(state: EmitState, s: IRStmt): string[] {
  if (state.futureTouches === null) return [];
  const futureTouchOut = state.futureTouches.get(s);
  if (futureTouchOut === undefined) return [];
  const touched = topLevelOwnedUses(s);
  for (const d of topLevelOwnedDefs(s)) touched.add(d);
  const out: string[] = [];
  for (const v of touched) {
    if (futureTouchOut.has(v)) continue;
    if (state.freedOwned.has(v)) continue;
    out.push(v);
  }
  out.sort();
  return out;
}

/** Emit a free line for every name in `vars`, picking the appropriate
 *  free helper from the owned-kind registry for each variable's type
 *  (`mtoc_tensor_free` / `mtoc_char_tensor_free` / `mtoc_string_free`),
 *  mark them as freed on the current linear path, and activate the
 *  matching helper snippet on first use. The caller has already
 *  filtered against the current `freedOwned` set (see
 *  `deadAfterStmt`). */
function emitEarlyFrees(
  state: EmitState,
  level: number,
  vars: ReadonlyArray<string>
): void {
  if (vars.length === 0) return;
  if (state.currentScopeVars === null) {
    throw new Error(
      "codegen internal: emitEarlyFrees called outside an emission scope"
    );
  }
  for (const v of vars) {
    const binding = state.currentScopeVars.get(v);
    if (binding === undefined) {
      throw new Error(
        `codegen internal: early-free for unknown var '${v}'; ` +
          `not in the current scope's free-on-exit set`
      );
    }
    const owned = ownedOps(binding.ty);
    if (owned === null) {
      throw new Error(
        `codegen internal: early-free for non-owned var '${v}' ` +
          `(${typeToString(binding.ty)})`
      );
    }
    useRuntimeByName(state, owned.free);
    pushStmt(state, level, `${owned.free}(&${v});`);
    state.freedOwned.add(v);
  }
}

export function emitStmt(state: EmitState, level: number, s: IRStmt): void {
  switch (s.kind) {
    case "Assign": {
      // `state.needMath` and runtime activations were set up by the
      // analyzeStmt pre-pass; this function only generates lines.
      // Three RHS shapes:
      //   - TensorLit: codegen writes literal values directly into
      //     `<cName>.real[idx]` slots (no runtime loop).
      //   - scalar: a single `<cName> = <expr>;` assignment.
      //   - any other multi-element expression: emit a per-element
      //     loop that walks the RHS body once per slot, with multi-
      //     element `Var`s inside reading from `<varCName>.real[<iter>]`
      //     (see `emitExpr.Var`).
      // Assigning to an owned name re-installs its buffer via
      // `mtoc_tensor_assign` / `mtoc_string_assign`, so the new
      // lifetime starts here — drop the LHS from the freed set so a
      // subsequent dead-after pass can free it again on its own terms.
      if (isOwned(s.ty)) {
        state.freedOwned.delete(s.cName);
      }
      if (s.rhs.kind === "TensorLit") {
        emitTensorLitAssign(state, level, s.cName, s.rhs);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (s.rhs.kind === "IndexSlice") {
        emitIndexSliceAssign(state, level, s.cName, s.rhs);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharScalar(s.ty)) {
        // Scalar char assigns directly — the RHS is always a CharLit
        // whose emitExpr renders as a C char literal (e.g. `'a'`).
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarReal(s.ty) || isScalarComplex(s.ty)) {
        pushStmt(state, level, `${s.cName} = ${emitExpr(state, s.rhs, 0)};`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      const owned = ownedOps(s.ty);
      if (owned !== null) {
        // Owned-LHS assignment goes through the kind's `assign` helper,
        // which frees the prior buffer (or no-ops on an empty/literal
        // handle) and installs the new value in one step.
        //
        // The tensor case (multi-element double) splits on RHS kind:
        // a non-Var, non-TensorLit RHS materializes elementwise via a
        // per-slot loop. Strings and char arrays accept a Var
        // (deep-copy) or any owned-producing expression directly
        // (`StringLit`, `mtoc_string_concat(...)`,
        // `mtoc_char_tensor_from_literal(...)`).
        if (
          isNumeric(s.ty) &&
          isMultiElement(s.ty) &&
          s.ty.elem === "double" &&
          s.rhs.kind !== "Var"
        ) {
          emitTensorAssignFromExpr(state, level, s.cName, s.rhs);
          emitEarlyFrees(state, level, deadAfterStmt(state, s));
          break;
        }
        useRuntimeByName(state, owned.structSnippet);
        useRuntimeByName(state, owned.assign);
        let rhsExpr: string;
        if (s.rhs.kind === "Var") {
          const copyHelper = owned.copy(s.rhs.ty);
          useRuntimeByName(state, copyHelper);
          rhsExpr = `${copyHelper}(${s.rhs.cName})`;
        } else {
          rhsExpr = emitExpr(state, s.rhs, 0);
        }
        pushStmt(state, level, `${owned.assign}(&${s.cName}, ${rhsExpr});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      throw new Error(
        `codegen: assignment to '${s.name}' with type ${typeToString(s.ty)} ` +
          `is not yet supported`
      );
    }

    case "ExprStmt": {
      pushStmt(state, level, `(void)(${emitExpr(state, s.expr, 0)});`);
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "IndexStore": {
      // `<base>(idx) = rhs;` — write one slot of the base's heap
      // buffer in place. Lowering already validated:
      //   - base is a multi-element double tensor (real or complex)
      //   - the indices are real scalars (1 or 2)
      //   - the RHS is a numeric scalar; complex into real has been
      //     rejected, so the only widening case is real RHS into a
      //     complex base (sets imag[off] = 0).
      const baseCName = s.base.cName;
      const baseTy = s.base.ty as NumericType;
      const offsetExpr =
        s.indices.length === 1
          ? `(long)(${emitExpr(state, s.indices[0], 0)}) - 1L`
          : `(long)(${emitExpr(state, s.indices[0], 0)}) - 1L + ` +
            `((long)(${emitExpr(state, s.indices[1], 0)}) - 1L) * ` +
            `${baseCName}.rows`;
      const rhsExpr = emitExpr(state, s.rhs, 0);
      if (baseTy.isComplex) {
        // Stash the offset and (for a complex RHS) the value into
        // locals so creal/cimag don't double-evaluate the RHS, and
        // so an offset expression with an embedded function call
        // doesn't run twice.
        pushStmt(state, level, `{`);
        pushStmt(state, level + 1, `long _mtoc_off = ${offsetExpr};`);
        if (isNumeric(s.rhs.ty) && s.rhs.ty.isComplex) {
          pushStmt(state, level + 1, `double _Complex _mtoc_rhs = ${rhsExpr};`);
          pushStmt(
            state,
            level + 1,
            `${baseCName}.real[_mtoc_off] = creal(_mtoc_rhs);`
          );
          pushStmt(
            state,
            level + 1,
            `${baseCName}.imag[_mtoc_off] = cimag(_mtoc_rhs);`
          );
        } else {
          // Real RHS into complex base — write real, zero imag.
          pushStmt(
            state,
            level + 1,
            `${baseCName}.real[_mtoc_off] = ${rhsExpr};`
          );
          pushStmt(state, level + 1, `${baseCName}.imag[_mtoc_off] = 0.0;`);
        }
        pushStmt(state, level, `}`);
      } else {
        pushStmt(
          state,
          level,
          `${baseCName}.real[${offsetExpr}] = ${rhsExpr};`
        );
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "Disp": {
      const ty = s.arg.ty;
      const owned = ownedOps(ty);
      if (owned !== null) {
        // Owned-kind disp: same shape across strings / char arrays /
        // tensors — activate the typedef snippet and the kind-specific
        // disp helper, pass the arg by value. The lowering pass
        // restricts each kind's accepted arg shapes (Var or
        // literal-handle for strings; Var-only for tensors); emitExpr
        // renders each safely.
        useRuntimeByName(state, owned.structSnippet);
        const helper = owned.disp(ty);
        useRuntimeByName(state, helper);
        pushStmt(state, level, `${helper}(${emitExpr(state, s.arg, 0)});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isCharScalar(ty)) {
        // Scalar char: print the single character + newline.
        useRuntimeByName(state, "mtoc_disp_char");
        pushStmt(state, level, `mtoc_disp_char(${emitExpr(state, s.arg, 0)});`);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarReal(ty)) {
        useRuntimeByName(state, "mtoc_disp_double");
        // Non-variadic call — `int` operands auto-promote to `double`,
        // so no manual cast is needed (unlike `printf("%g", ...)`).
        pushStmt(
          state,
          level,
          `mtoc_disp_double(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      if (isScalarComplex(ty)) {
        useRuntimeByName(state, "mtoc_disp_complex");
        pushStmt(
          state,
          level,
          `mtoc_disp_complex(${emitExpr(state, s.arg, 0)});`
        );
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      throw new Error(
        `codegen: disp of ${typeToString(ty)} is not yet supported`
      );
    }

    case "If": {
      // Each arm is emitted with a snapshot of `freedOwned`; after
      // all arms finish, the post-If freed set is the intersection
      // (a var is "definitely freed" only if every arm freed it).
      // Implicit else (no `s.elseBody`) contributes the pre-If
      // snapshot — the implicit fall-through arm freed nothing — so
      // its intersection forces vars freed only in some arms back
      // out of the post-If freed set, and the scope-exit safety net
      // catches them.
      const preFreed = new Set(state.freedOwned);
      const armFreedSets: Set<string>[] = [];

      pushStmt(state, level, `if (${emitExpr(state, s.cond, 0)}) {`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.thenBody) emitStmt(state, level + 1, t);
      armFreedSets.push(state.freedOwned);

      for (const eif of s.elseifs) {
        pushStmt(state, level, `} else if (${emitExpr(state, eif.cond, 0)}) {`);
        state.freedOwned = new Set(preFreed);
        for (const t of eif.body) emitStmt(state, level + 1, t);
        armFreedSets.push(state.freedOwned);
      }

      if (s.elseBody) {
        pushStmt(state, level, `} else {`);
        state.freedOwned = new Set(preFreed);
        for (const t of s.elseBody) emitStmt(state, level + 1, t);
        armFreedSets.push(state.freedOwned);
      } else {
        // Implicit fall-through arm freed nothing on top of `preFreed`.
        armFreedSets.push(preFreed);
      }
      pushStmt(state, level, `}`);

      // Intersection of arm freed sets — the post-If linear path.
      const merged = new Set<string>(armFreedSets[0]);
      for (let i = 1; i < armFreedSets.length; i++) {
        const next = armFreedSets[i];
        for (const v of merged) if (!next.has(v)) merged.delete(v);
      }
      state.freedOwned = merged;

      // After the If, free anything in the cond that's now dead.
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "While": {
      // Snapshot: vars freed inside the loop body don't graduate to
      // the post-loop linear path because the loop may have iterated
      // zero times. The per-iteration frees still run at runtime —
      // mtoc_tensor_free is idempotent on a zeroed struct, so a
      // post-loop scope-exit free of the same var (via the safety
      // net) is sound.
      const preFreed = new Set(state.freedOwned);
      pushStmt(state, level, `while (${emitExpr(state, s.cond, 0)}) {`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.body) emitStmt(state, level + 1, t);
      pushStmt(state, level, `}`);
      state.freedOwned = preFreed;
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "Error": {
      // `error(s)` lowers to a direct call into the runtime helper.
      // The helper prints to stderr and `exit(1)`s, so any code after
      // this statement is unreachable at runtime. We don't try to
      // free heap-owned tensors / strings before the call: the OS
      // reclaims everything on `exit`, and matching numbl's behavior
      // is what we care about for cross-runner parity.
      useRuntimeByName(state, "mtoc_string_t");
      useRuntimeByName(state, "mtoc_error_string");
      pushStmt(
        state,
        level,
        `mtoc_error_string(${emitExpr(state, s.arg, 0)});`
      );
      break;
    }

    case "Break":
      pushStmt(state, level, `break;`);
      break;

    case "Continue":
      pushStmt(state, level, `continue;`);
      break;

    case "ReturnFromFunction": {
      // Free every tensor backing in the enclosing function's scope
      // before we return — but skip ones already freed earlier on
      // this linear path so the same var doesn't get a redundant
      // free emit. `currentScopeVars` is set to `fn.assignedVars` (+
      // tensor params) by `emitFunctionBody`. Lowering only emits
      // this kind inside a function body, so the field is always
      // non-null here.
      if (
        state.currentScopeVars === null ||
        state.currentFunctionOutputs === null
      ) {
        throw new Error(
          "codegen internal: ReturnFromFunction reached emit outside a " +
            "function scope; should have been rejected at lowering"
        );
      }
      emitScopeExitFrees(
        state,
        level,
        state.currentScopeVars,
        state.freedOwned
      );
      const outputs = state.currentFunctionOutputs;
      if (outputs.length === 0) {
        // Zero-output function: no value to carry back, no out-pointer
        // writes. Emit a bare `return;` so the C control-flow path is
        // explicit. Falls through cleanly to the `void` return type
        // emitted by `emitFunction`.
        pushStmt(state, level, `return;`);
      } else if (outputs.length === 1) {
        // Classic single-output convention: return-by-value of the
        // local that holds the output's current value at this exit
        // point. The lowerer captured that live cName when it built
        // the IR node.
        pushStmt(state, level, `return ${s.outputCNames[0]};`);
      } else {
        // Multi-output convention: write each output's local into
        // the corresponding `_mtoc_o<i>` out-pointer (declared as a
        // C parameter by `emitFunction`), then `return;`.
        for (let i = 0; i < outputs.length; i++) {
          pushStmt(state, level, `*_mtoc_o${i} = ${s.outputCNames[i]};`);
        }
        pushStmt(state, level, `return;`);
      }
      break;
    }

    case "MultiAssignCall": {
      // Multi-output / 0-output user-function call. The invariant set
      // by `lowerMultiAssignCall`:
      //   - `outputs.length === 0`           → 0-output bare statement
      //   - `outputs.length >= 2`            → either an N-output
      //     `[a, b, ~] = foo(x);` or the drop-all bare form
      //     `foo(x);` (every slot.binding is null).
      // The call site never appears with `outputs.length === 1`
      // because that case routes to `Assign` / `ExprStmt(Call)` in
      // lowering (1-output is return-by-value).
      // Copy-on-arg-pass for tensor / char-array args, mirroring the
      // regular `Call` path in `emitExpr`.
      const argStrs = s.args.map(a =>
        wrapOwnedArgCopy(state, a.ty, emitExpr(state, a, 0))
      );
      if (s.outputs.length === 0) {
        // Zero-output: simplest form — bare `<mangled>(args);`. No
        // discard temps, no surrounding block.
        pushStmt(state, level, `${s.mangled}(${argStrs.join(", ")});`);
        // An owned LHS reassigned via the call's outputs would have
        // been recorded already (see the freedOwned bookkeeping
        // below); 0-output calls have nothing to reset.
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      // N≥2-output: open a `{}` block so any discard temps stay
      // scoped to the call. For each ignored slot, declare a typed
      // `_mtoc_discard_<callIdx>_<slot>` local and pass its address;
      // for each named slot, pass the address of the lowered
      // binding's predeclared local. Per-call counter on the
      // EmitState gives each call a unique suffix for its temps,
      // even though they're structurally scoped — handy when reading
      // the emitted C diff for unrelated calls.
      const callIdx = state.multiAssignCallCounter++;
      pushStmt(state, level, `{`);
      const outArgs: string[] = [];
      for (let i = 0; i < s.outputs.length; i++) {
        const slot = s.outputs[i];
        const cTy = cTypeFor(slot.ty);
        if (cTy === null) {
          throw new Error(
            `codegen internal: MultiAssignCall slot ${i} of '${s.name}' ` +
              `has unsupported type ${typeToString(slot.ty)}`
          );
        }
        if (slot.binding === null) {
          const tmp = `_mtoc_discard_${callIdx}_${i}`;
          pushStmt(state, level + 1, `${cTy} ${tmp};`);
          outArgs.push(`&${tmp}`);
        } else {
          outArgs.push(`&${slot.binding.cName}`);
        }
      }
      pushStmt(
        state,
        level + 1,
        `${s.mangled}(${[...argStrs, ...outArgs].join(", ")});`
      );
      pushStmt(state, level, `}`);
      // Reassigning to an owned LHS via the call clears its freed
      // marker on the current linear path, mirroring `Assign` to an
      // owned LHS. Today user-function outputs must be scalars (so
      // never owned), but the bookkeeping stays consistent for the
      // day they can be.
      for (const slot of s.outputs) {
        if (slot.binding !== null && isOwned(slot.ty)) {
          state.freedOwned.delete(slot.binding.cName);
        }
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "For": {
      // Step is guaranteed to be a NumLit by lowering.
      if (s.step.kind !== "NumLit") {
        throw new Error(
          "codegen internal: for-loop step must be a NumLit; " +
            "should have been caught at lowering"
        );
      }
      const v = s.cVar;
      const startStr = emitExpr(state, s.start, 0);
      const endStr = emitExpr(state, s.end, 0);
      const stepStr = formatNumLit(s.step.value);

      // MATLAB semantics: after the loop, the loop variable holds the
      // LAST in-bounds value, not one step past it. We compute the
      // iteration count up front and derive `var = start + step * i`
      // each iteration so it never advances past that last value.
      // Wrapped in a block so `_mtoc_*` helpers are scoped per-loop;
      // nested for-loops shadow them without collision.
      // Linear-path freedOwned: snapshot/restore around the body
      // for the same reason as `While` — body may iterate zero
      // times, so frees inside don't graduate to the post-loop set.
      const preFreed = new Set(state.freedOwned);
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
      pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
      pushStmt(
        state,
        level + 1,
        `long _mtoc_n = (long)floor((_mtoc_end - _mtoc_start) / ${stepStr}) + 1;`
      );
      pushStmt(state, level + 1, `if (_mtoc_n < 0) _mtoc_n = 0;`);
      pushStmt(
        state,
        level + 1,
        `for (long _mtoc_i = 0; _mtoc_i < _mtoc_n; _mtoc_i++) {`
      );
      pushStmt(state, level + 2, `${v} = _mtoc_start + ${stepStr} * _mtoc_i;`);
      state.freedOwned = new Set(preFreed);
      for (const t of s.body) emitStmt(state, level + 2, t);
      pushStmt(state, level + 1, `}`);
      pushStmt(state, level, `}`);
      state.freedOwned = preFreed;
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }
  }
}

/** Walk an IR expression and return the first multi-element `Var`
 *  encountered — the "shape source" for an elementwise assign whose
 *  RHS isn't a TensorLit. After the dim coarsening, the assignment-
 *  site allocation reads its size and rows/cols from this Var at
 *  runtime. Returns null if no multi-element Var is reachable; in
 *  practice every multi-element non-TensorLit RHS that the lowerer
 *  accepts contains at least one such Var (TensorLit is rejected
 *  nested, and Calls don't return tensors). */
function findShapeSourceVar(
  e: IRExpr
): Extract<IRExpr, { kind: "Var" }> | null {
  return findInExpr(
    e,
    (sub): sub is Extract<IRExpr, { kind: "Var" }> =>
      sub.kind === "Var" && isMultiElement(sub.ty)
  );
}

/** Walk an IR expression and return the first multi-element CharLit
 *  encountered — the fallback shape-source for elementwise assigns
 *  where the RHS contains no multi-element Var (e.g. `'abc' + 1` or
 *  `'abc' == 'def'`). The CharLit's `.value.length` gives the static
 *  column count; rows are always 1 for char arrays. */
function findCharLitShapeSource(
  e: IRExpr
): Extract<IRExpr, { kind: "CharLit" }> | null {
  return findInExpr(
    e,
    (sub): sub is Extract<IRExpr, { kind: "CharLit" }> =>
      sub.kind === "CharLit" && isMultiElement(sub.ty)
  );
}

/** Walk an IR expression and collect every distinct multi-element
 *  `Var` on its RHS, keyed by C identifier so duplicates collapse
 *  (the canonical `v .* v` case yields a single entry). The walk
 *  order matches `findShapeSourceVar`'s left-first DFS, so the
 *  shape-source picked there is also the first entry in the returned
 *  Map — a nice property for emitting stable shape-check pairs.
 *  Scalars (NumLit, ImagLit, scalar Vars) are skipped: broadcast
 *  handles any shape, so they have nothing to check against. */
function collectMultiElementVarsByCName(
  e: IRExpr,
  out: Map<string, Extract<IRExpr, { kind: "Var" }>>
): void {
  forEachSubExpr(e, sub => {
    if (sub.kind === "Var" && isMultiElement(sub.ty) && !out.has(sub.cName)) {
      out.set(sub.cName, sub);
    }
  });
}

/** Emit an Assign whose multi-element RHS is NOT a TensorLit and not
 *  a bare Var. Pattern: read shape from a deterministic shape-source
 *  `Var`, allocate a fresh tensor via `mtoc_tensor_alloc{,_complex}`
 *  (so reads from the target inside the body see the OLD buffer —
 *  important when the RHS aliases the target, e.g. `M = M + 1`),
 *  evaluate the body into the staging tensor's slots, then
 *  `mtoc_tensor_assign(&target, _mtoc_t)` to consume-replace the
 *  target. Wrapped in `{}` so the staging local is scoped per
 *  Assign. */
function emitTensorAssignFromExpr(
  state: EmitState,
  level: number,
  cTarget: string,
  rhs: IRExpr
): void {
  const src = findShapeSourceVar(rhs);
  // When there is no multi-element Var in the RHS (e.g. `'abc' + 1`
  // or `'abc' == 'def'`), fall back to a CharLit whose length gives
  // the static shape.  If neither is found the lowerer has let through
  // something the codegen cannot handle yet.
  const charLitSrc = src === null ? findCharLitShapeSource(rhs) : null;
  if (src === null && charLitSrc === null) {
    throw new Error(
      `codegen internal: cannot determine runtime shape for elementwise ` +
        `assignment target '${cTarget}' (rhs ${typeToString(rhs.ty)}); ` +
        `RHS contains no multi-element variable or char literal to read shape from`
    );
  }
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");

  const isComplex = isNumeric(rhs.ty) && rhs.ty.isComplex;
  const allocHelper = isComplex
    ? "mtoc_tensor_alloc_complex"
    : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);

  const iterId = state.elemwiseLoopCounter++;
  const iterName = iterId === 0 ? "_mtoc_i" : `_mtoc_i${iterId}`;
  // Single-purpose name for the staging tensor — distinct from the
  // `_mtoc_t<n>` per-cell complex temp in `emitTensorLitAssign`, which
  // never appears in this function's emission.
  const stagingName = "_mtoc_t";

  // Collect every distinct multi-element Var in the RHS (keyed by
  // cName so duplicates like `v .* v` collapse). The shape source
  // already picked by `findShapeSourceVar` is the first entry; for
  // every other Var we emit one `mtoc_check_shape(<source>, <other>)`
  // before the staging-buffer alloc. Same-Var and scalar-broadcast
  // cases produce zero checks. The check is once-per-assign — once
  // the source is shape-compatible with every other operand, every
  // per-element read inside the loop is in bounds.
  // When the shape source is a CharLit, no runtime shape checks are
  // emitted for other CharLit operands (their lengths are statically
  // known; the dim lattice already admitted them as compatible).
  const multiVars = new Map<string, Extract<IRExpr, { kind: "Var" }>>();
  collectMultiElementVarsByCName(rhs, multiVars);
  const checkPairs: Array<Extract<IRExpr, { kind: "Var" }>> = [];
  if (src !== null) {
    for (const [cName, v] of multiVars) {
      if (cName === src.cName) continue;
      checkPairs.push(v);
    }
  }
  if (checkPairs.length > 0) {
    useRuntimeByName(state, "mtoc_check_shape");
  }

  // Shape args: either from a Var's runtime rows/cols, or from the
  // static length of a CharLit (always a 1×N row vector).
  const shapeArgs =
    src !== null
      ? `${src.cName}.rows, ${src.cName}.cols`
      : `1, ${charLitSrc!.value.length}`;

  pushStmt(state, level, `{`);
  if (src !== null) {
    for (const other of checkPairs) {
      pushStmt(
        state,
        level + 1,
        `mtoc_check_shape(${src.cName}, ${other.cName});`
      );
    }
  }
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t ${stagingName} = ${allocHelper}(${shapeArgs});`
  );
  pushStmt(
    state,
    level + 1,
    `long _mtoc_n = ${stagingName}.rows * ${stagingName}.cols;`
  );
  pushStmt(
    state,
    level + 1,
    `for (long ${iterName} = 0; ${iterName} < _mtoc_n; ${iterName}++) {`
  );
  state.iterStack.push(iterName);
  const bodyStr = emitExpr(state, rhs, 0);
  state.iterStack.pop();
  if (isComplex) {
    pushStmt(state, level + 2, `double _Complex _mtoc_c = ${bodyStr};`);
    pushStmt(
      state,
      level + 2,
      `${stagingName}.real[${iterName}] = creal(_mtoc_c);`
    );
    pushStmt(
      state,
      level + 2,
      `${stagingName}.imag[${iterName}] = cimag(_mtoc_c);`
    );
  } else {
    pushStmt(
      state,
      level + 2,
      `${stagingName}.real[${iterName}] = ${bodyStr};`
    );
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_assign(&${cTarget}, ${stagingName});`
  );
  pushStmt(state, level, `}`);
}

/** Emit a tensor-literal assignment. The runtime helpers
 *  (`mtoc_tensor_from_row` / `_complex` / `mtoc_tensor_from_matrix` /
 *  `_complex`) take a flat column-major data pointer and return a
 *  freshly-allocated tensor; `mtoc_tensor_assign` consumes that
 *  result and replaces the target's backing in one shot.
 *
 *  Real cells go straight into a C99 compound literal — `(double[])
 *  {1.0, 2.0, x, x*y}` — so the emitted C matches the numbl source
 *  one-for-one.
 *
 *  Complex literals build the staging tensor first (`mtoc_tensor_alloc_complex`),
 *  fill its `.real` / `.imag` slots in column-major order, then
 *  consume-replace via `mtoc_tensor_assign`. This handles arbitrary
 *  per-cell shapes (NumLit, ImagLit, real-scalar exprs, and full
 *  complex exprs needing creal/cimag splits) uniformly. Reads from
 *  the target (e.g. `M = [1, sum(M)]`) see the OLD buffer up until
 *  the final assign call, since the staging tensor is a separate
 *  allocation. */
function emitTensorLitAssign(
  state: EmitState,
  level: number,
  target: string,
  lit: Extract<IRExpr, { kind: "TensorLit" }>
): void {
  if (!isNumeric(lit.ty)) {
    throw new Error(
      "codegen internal: tensor literal must produce a tensor type; " +
        "should have been caught at lowering"
    );
  }
  const ty = lit.ty as NumericType;
  // The IR node carries the literal's row-major nested elements; cell
  // counts come straight off that array (independent of the type's
  // coarse dim shape). Columns are uniform by lowerTensorLiteral's
  // row-uniformity check.
  const rows = lit.elements.length;
  const cols = rows > 0 ? lit.elements[0].length : 0;
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");

  if (!ty.isComplex) {
    // Real path: every cell is a real-scalar C expression. Drop them
    // straight into a compound literal in column-major order, then
    // hand to the matching from_row / from_matrix helper.
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        cells.push(emitExpr(state, lit.elements[r][c], 0));
      }
    }
    const helper =
      rows === 1 ? "mtoc_tensor_from_row" : "mtoc_tensor_from_matrix";
    useRuntimeByName(state, helper);
    const shapeArgs = rows === 1 ? `${cols}` : `${rows}, ${cols}`;
    pushStmt(
      state,
      level,
      `mtoc_tensor_assign(&${target}, ${helper}((double[]){${cells.join(", ")}}, ${shapeArgs}));`
    );
    return;
  }

  // Complex path: build the staging tensor up front and write each
  // cell's (real, imag) parts into its `.real`/`.imag` slots in
  // column-major order. Complex-typed cells (e.g. `x + 1` where x is
  // complex, or a complex Binary) need a per-cell `double _Complex`
  // temp so creal/cimag don't double-evaluate the expression.
  useRuntimeByName(state, "mtoc_tensor_alloc_complex");
  pushStmt(state, level, `{`);
  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc_complex(${rows}, ${cols});`
  );
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cellExpr = lit.elements[r][c];
      const idx = r + c * rows;
      if (cellExpr.kind === "NumLit") {
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.real[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        pushStmt(state, level + 1, `_mtoc_t.imag[${idx}] = 0.0;`);
        continue;
      }
      if (cellExpr.kind === "ImagLit") {
        pushStmt(state, level + 1, `_mtoc_t.real[${idx}] = 0.0;`);
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.imag[${idx}] = ${formatNumLit(cellExpr.value)};`
        );
        continue;
      }
      const cellTy = cellExpr.ty;
      if (isNumeric(cellTy) && !cellTy.isComplex) {
        // Real scalar expression; promotes to (cell, 0i).
        pushStmt(
          state,
          level + 1,
          `_mtoc_t.real[${idx}] = ${emitExpr(state, cellExpr, 0)};`
        );
        pushStmt(state, level + 1, `_mtoc_t.imag[${idx}] = 0.0;`);
        continue;
      }
      // Generic complex cell: stash into a temp and split with
      // creal/cimag. The temp is scoped per-cell with a `{}` block so
      // adjacent cells don't collide.
      const tmp = `_mtoc_c${state.elemwiseLoopCounter++}`;
      const cellStr = emitExpr(state, cellExpr, 0);
      pushStmt(state, level + 1, `{`);
      pushStmt(state, level + 2, `double _Complex ${tmp} = ${cellStr};`);
      pushStmt(state, level + 2, `_mtoc_t.real[${idx}] = creal(${tmp});`);
      pushStmt(state, level + 2, `_mtoc_t.imag[${idx}] = cimag(${tmp});`);
      pushStmt(state, level + 1, `}`);
    }
  }
  pushStmt(state, level + 1, `mtoc_tensor_assign(&${target}, _mtoc_t);`);
  pushStmt(state, level, `}`);
}

/** Emit a range/colon-indexed read: `target = base(a:b)`,
 *  `target = base(a:s:b)`, or `target = base(:)`. The slice
 *  allocates a fresh result tensor sized by the index range,
 *  fills it via a counted loop, and consume-replaces the target.
 *
 *  The result-shape rules match `lowerIndexSlice`:
 *    - `Colon`        → column tensor of `base.rows * base.cols`.
 *    - `Range`, base is row-vec → row tensor of count.
 *    - `Range`, otherwise       → column tensor of count.
 *
 *  For complex bases the result is a complex tensor; the codegen
 *  copies both `.real` and `.imag` per slot. Char ranges are
 *  rejected at lowering, so this function only handles double. */
function emitIndexSliceAssign(
  state: EmitState,
  level: number,
  target: string,
  rhs: Extract<IRExpr, { kind: "IndexSlice" }>
): void {
  const base = rhs.base;
  const baseTy = base.ty;
  if (!isNumeric(baseTy) || baseTy.elem !== "double") {
    throw new Error(
      `codegen internal: emitIndexSliceAssign called with non-double base ` +
        `(${typeToString(baseTy)}); should have been rejected at lowering`
    );
  }
  const isComplex = baseTy.isComplex;
  useRuntimeByName(state, "mtoc_tensor_t");
  useRuntimeByName(state, "mtoc_tensor_assign");
  const allocHelper = isComplex
    ? "mtoc_tensor_alloc_complex"
    : "mtoc_tensor_alloc";
  useRuntimeByName(state, allocHelper);

  // Render the source-index expression for iteration k:
  //   - Colon:  k          (already 0-based; reads base.real[k])
  //   - Range:  start + step*k - 1   (1-based MATLAB → 0-based C)
  //
  // Plus a count-and-shape preamble that depends on the slot kind.
  // The whole emission is wrapped in `{ … }` so per-slice locals
  // (`_mtoc_n`, `_mtoc_t`, `_mtoc_k`, `_mtoc_start`, `_mtoc_step`)
  // are scoped to this statement.
  pushStmt(state, level, `{`);

  let count: string;
  let srcIndexFor: (kVar: string) => string;
  let resultRows: string;
  let resultCols: string;

  if (rhs.index.kind === "Colon") {
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = ${base.cName}.rows * ${base.cName}.cols;`
    );
    count = "_mtoc_n";
    srcIndexFor = k => k;
    resultRows = "_mtoc_n";
    resultCols = "1";
  } else {
    // Range slot. Step is guaranteed to be a numeric literal by
    // lowering; render as a `double` expression for the count
    // formula, then cast inside the per-iteration source-index
    // expression.
    if (rhs.index.step.kind !== "NumLit") {
      throw new Error(
        "codegen internal: IndexSlice range step must be a NumLit; " +
          "should have been caught at lowering"
      );
    }
    const startStr = emitExpr(state, rhs.index.start, 0);
    const endStr = emitExpr(state, rhs.index.end, 0);
    const stepStr = formatNumLit(rhs.index.step.value);
    pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
    pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
    pushStmt(
      state,
      level + 1,
      `long _mtoc_n = (long)floor((_mtoc_end - _mtoc_start) / ${stepStr}) + 1;`
    );
    pushStmt(state, level + 1, `if (_mtoc_n < 0) _mtoc_n = 0;`);
    count = "_mtoc_n";
    srcIndexFor = k => `(long)(_mtoc_start + ${stepStr} * (double)${k}) - 1L`;
    // Result orientation:
    //   - row-vec base → row (preserves)
    //   - col-vec base → col (preserves)
    //   - matrix base  → row (linear-indexed `a:b` is itself a row,
    //                     and the index orientation wins for a
    //                     matrix base; matches numbl).
    if (isRowVec(baseTy)) {
      resultRows = "1";
      resultCols = "_mtoc_n";
    } else if (isColVec(baseTy)) {
      resultRows = "_mtoc_n";
      resultCols = "1";
    } else {
      resultRows = "1";
      resultCols = "_mtoc_n";
    }
    // Range arithmetic involves floor() — make sure <math.h> is in.
    state.needMath.value = true;
  }

  pushStmt(
    state,
    level + 1,
    `mtoc_tensor_t _mtoc_t = ${allocHelper}(${resultRows}, ${resultCols});`
  );
  pushStmt(
    state,
    level + 1,
    `for (long _mtoc_k = 0; _mtoc_k < ${count}; _mtoc_k++) {`
  );
  const srcIdx = srcIndexFor("_mtoc_k");
  if (isComplex) {
    pushStmt(
      state,
      level + 2,
      `_mtoc_t.real[_mtoc_k] = ${base.cName}.real[${srcIdx}];`
    );
    pushStmt(
      state,
      level + 2,
      `_mtoc_t.imag[_mtoc_k] = ${base.cName}.imag[${srcIdx}];`
    );
  } else {
    pushStmt(
      state,
      level + 2,
      `_mtoc_t.real[_mtoc_k] = ${base.cName}.real[${srcIdx}];`
    );
  }
  pushStmt(state, level + 1, `}`);
  pushStmt(state, level + 1, `mtoc_tensor_assign(&${target}, _mtoc_t);`);
  pushStmt(state, level, `}`);
}
