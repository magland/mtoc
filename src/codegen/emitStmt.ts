/**
 * Statement-level codegen.
 *
 * `emitStmt` is the dispatch that takes one IRStmt and pushes the
 * corresponding C lines into `state.lines`. It dispatches on
 * `stmt.kind`, with the `Assign` arm doing further dispatch on
 * `(rhs.kind, ty)` to pick between scalar / owned / TensorLit /
 * elementwise-loop emission paths.
 *
 * Analysis helpers, tensor-assign emitters, and slice read/write
 * emitters have been split into focused companion modules:
 *   - `emitAnalysis.ts` — `analyzeStmts`, `deadAfterStmt`,
 *     `emitEarlyFrees`, `formatArgInit`.
 *   - `emitTensor.ts`   — `emitTensorAssignFromExpr`,
 *     `emitTensorLitAssign`, and the shape-source walkers.
 *   - `emitSlice.ts`    — `emitIndexSliceAssign`,
 *     `emitIndexSliceStore`, `emitNdScalarOffset`, and helpers.
 */

import type { IRExpr, IRStmt } from "../lowering/ir.js";
import { isDirectOwnedCall } from "../lowering/anf.js";
import {
  cTypeFor,
  isCharScalar,
  isMultiElement,
  isNumeric,
  isOwned,
  isScalarComplex,
  isScalarReal,
  typeToString,
  type NumericType,
} from "../lowering/types.js";
import { dispEmitterFor } from "./dispKinds.js";
import { ownedOps } from "./ownedKinds.js";
import {
  pushStmt,
  useRuntimeByName,
  useSnippet,
  type EmitState,
} from "./emitState.js";
import {
  emitOwnedAssign,
  emitOwnedAwareSretWrites,
  emitOwnedEmptyDecl,
  emitScopeExitFrees,
} from "./emitOwned.js";
import {
  emitExpr,
  emitNdScalarOffset,
  wrapOwnedArgCopy,
  wrapTextView,
} from "./emitExpr.js";
import { formatNumLit } from "./emitFormat.js";
import { renderStmt, sanitizeForBlockComment } from "./irRender.js";
import {
  deadAfterStmt,
  emitEarlyFrees,
  formatArgInit,
} from "./emitAnalysis.js";
import { emitTensorAssignFromExpr, emitTensorLitAssign } from "./emitTensor.js";
import { emitIndexSliceAssign, emitIndexSliceStore } from "./emitSlice.js";
import { emitMakeRangeAssign } from "./emitRange.js";

export { analyzeStmts } from "./emitAnalysis.js";

/** Render a scalar IRExpr in a boolean-context position (an `if`,
 *  `elseif`, `while`, or `assert(cond)`). Real-valued conds render
 *  exactly as the underlying expression (numbl's toBool on real is
 *  `x != 0`, which C's `if(x)` already implements bit-for-bit modulo
 *  NaN — numbl rejects NaN at `assert`, which the runtime helper
 *  handles separately, while `if`/`while` treat NaN as truthy in
 *  both numbl and C).
 *
 *  Complex conds expand to numbl's toBool rule
 *  `creal(z) != 0.0 || cimag(z) != 0.0`. For the top-level `if` cond
 *  `allowHoist=true` lifts a non-Var operand to a `_mtoc_cx_tmp_<N>`
 *  at the current statement level (same pattern as the complex `Unary
 *  Not` path) so a caller-side Call is evaluated once. `elseif` and
 *  `while` conds set `allowHoist=false`: for `elseif` a hoisted decl
 *  would land inside the prior arm's `{...}` scope and not be visible;
 *  for `while` the cond must be re-evaluated per iteration. Numbl
 *  funcs are pure, so double-eval is benign in both no-hoist cases. */
function emitBoolCond(
  state: EmitState,
  level: number,
  cond: IRExpr,
  allowHoist: boolean
): string {
  if (!isScalarComplex(cond.ty)) {
    return emitExpr(state, cond, 0);
  }
  let s = emitExpr(state, cond, 0);
  if (allowHoist && cond.kind !== "Var") {
    const tmp = `_mtoc_cx_tmp_${state.complexTmpCounter++}`;
    pushStmt(state, level, `double _Complex ${tmp} = ${s};`);
    s = tmp;
    return `(creal(${s}) != 0.0 || cimag(${s}) != 0.0)`;
  }
  // No hoist — re-inline the operand expression on each lane access.
  // For a Var this is a pure read and matches the hoisted form; for a
  // non-Var while-cond the duplication is intentional (per-iteration
  // re-evaluation matches numbl).
  return `(creal(${s}) != 0.0 || cimag(${s}) != 0.0)`;
}

export function emitStmt(state: EmitState, level: number, s: IRStmt): void {
  // Track the current statement level so that expression-level helpers
  // (emitComplexCmpOrLogical, complex Unary Not) can push hoisted temp
  // declarations at the right indentation without needing a `level` param.
  state.currentLevel = level;
  // Drop a numbl-style comment above each emitted statement so a
  // reader of the generated C can follow the original program shape
  // without bouncing back to the `.m` source. `renderStmt` returns
  // null for kinds where the C line is already identical to the numbl
  // form (`break`, `continue`).
  //
  // When tensor-expression inlining fired, every consumer carries an
  // ordered list of pre-inlining source-line comments from the
  // producers that got inlined into it. Emit those FIRST (oldest
  // producer first), then the consumer's own (post-inlining) source
  // line. This way the reader sees the original numbl shape and the
  // collapsed form side by side. See
  // `src/codegen/inline/inlinePass.ts`.
  const inlined = state.inlinedFrom.get(s);
  if (inlined !== undefined) {
    for (const comment of inlined) {
      pushStmt(
        state,
        level,
        `/* inlined: ${sanitizeForBlockComment(comment)} */`
      );
    }
  }
  const srcLine = renderStmt(s);
  if (srcLine !== null) {
    pushStmt(state, level, `/* ${sanitizeForBlockComment(srcLine)} */`);
  }
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
      if (s.rhs.kind === "MakeRange") {
        emitMakeRangeAssign(state, level, s.cName, s.rhs);
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
        // a non-Var, non-MemberLoad, non-direct-Call RHS materializes
        // elementwise via a per-slot loop. A direct-Call RHS (user
        // function, or a non-elementwise builtin like `size` /
        // `reshape`) returns a fully-formed owned tensor by value —
        // the direct `mtoc_tensor_assign(&lhs, foo(args))` path
        // consumes that handle without re-allocating. A MemberLoad RHS
        // reads a tensor handle from a struct field and is handled
        // like Var-of-tensor: deep-copy via the kind's `copy` helper.
        // Strings and char arrays accept a Var (deep-copy) or any
        // owned-producing expression directly (`StringLit`,
        // `mtoc_string_concat(...)`, `mtoc_char_tensor_from_literal(...)`,
        // user-function call).
        if (
          isNumeric(s.ty) &&
          isMultiElement(s.ty) &&
          s.ty.elem === "double" &&
          s.rhs.kind !== "Var" &&
          s.rhs.kind !== "MemberLoad" &&
          s.rhs.kind !== "HandleCaptureLoad" &&
          !isDirectOwnedCall(s.rhs)
        ) {
          emitTensorAssignFromExpr(state, level, s.cName, s.rhs);
          emitEarlyFrees(state, level, deadAfterStmt(state, s));
          break;
        }
        let rhsExpr: string;
        if (s.rhs.kind === "Var") {
          const copyHelper = owned.copy(s.rhs.ty);
          useSnippet(state, copyHelper);
          rhsExpr = `${copyHelper.name}(${s.rhs.cName})`;
        } else if (
          s.rhs.kind === "MemberLoad" ||
          s.rhs.kind === "HandleCaptureLoad"
        ) {
          // Struct-field or handle-capture read: deep-copy so the
          // assignment owns its own buffer (same shape as Var read).
          const copyHelper = owned.copy(s.rhs.ty);
          useSnippet(state, copyHelper);
          rhsExpr = `${copyHelper.name}(${emitExpr(state, s.rhs, 0)})`;
        } else {
          rhsExpr = emitExpr(state, s.rhs, 0);
        }
        emitOwnedAssign(state, level, owned, `&${s.cName}`, rhsExpr);
        emitEarlyFrees(state, level, deadAfterStmt(state, s));
        break;
      }
      throw new Error(
        `codegen internal: assignment to '${s.name}' with type ` +
          `${typeToString(s.ty)} reached emitStmt with no matching arm ` +
          `(should have been rejected at lowering)`
      );
    }

    case "ExprStmt": {
      pushStmt(state, level, `(void)(${emitExpr(state, s.expr, 0)});`);
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "IndexSliceStore": {
      // `<base>(slice) = rhs;` — write multiple slots of the base's
      // heap buffer in place. Lowering already validated:
      //   - base is a multi-element double tensor (real or complex)
      //   - the slice is a single-slot Range (literal step) or Colon
      //   - the RHS is numeric; a complex RHS into a real base has
      //     been rejected, so the only widening case is real RHS into
      //     a complex base (zeros .imag per slot).
      //
      // The codegen runs a per-slot loop. For a tensor RHS, slot k
      // reads `rhs.real[k]` (and `.imag[k]` when complex); a runtime
      // count check protects against buffer overruns. For a scalar
      // RHS, the value is broadcast — same expression evaluated per
      // slot (or stashed into a temp if it's complex / could
      // double-evaluate side effects).
      emitIndexSliceStore(state, level, s);
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "MemberStore": {
      // Walk the fieldPath to build the C lvalue: `s.f1.f2....fn`.
      const lhsAccess = `${s.base.cName}.${s.fieldPath.join(".")}`;
      const owned = ownedOps(s.leafTy);
      let rhsExpr: string;
      if (owned !== null) {
        // Owned leaf field: free the prior buffer / install the new
        // value via the kind's `assign` helper. If the RHS is a `Var`
        // of the same owned type, we deep-copy first so the field
        // gets its own buffer (value semantics).
        if (s.rhs.kind === "Var") {
          const copyHelper = owned.copy(s.rhs.ty);
          useSnippet(state, copyHelper);
          rhsExpr = `${copyHelper.name}(${s.rhs.cName})`;
        } else {
          rhsExpr = emitExpr(state, s.rhs, 0);
        }
        emitOwnedAssign(state, level, owned, `&${lhsAccess}`, rhsExpr);
      } else {
        // Scalar leaf field: plain assignment. The RHS may also need
        // a struct-typed write for a nested field path where the
        // entire nested struct gets re-assigned (rare but legal).
        rhsExpr = emitExpr(state, s.rhs, 0);
        pushStmt(state, level, `${lhsAccess} = ${rhsExpr};`);
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "IndexStore": {
      // `<base>(idx) = rhs;` — write one slot of the base's heap
      // buffer in place. Lowering already validated:
      //   - base is a multi-element double tensor (real or complex)
      //   - the indices are real scalars (1, 2, or ndim — matching
      //     lowerIndexStore's arity rules)
      //   - the RHS is a numeric scalar; complex into real has been
      //     rejected, so the only widening case is real RHS into a
      //     complex base (sets imag[off] = 0).
      const baseCName = s.base.cName;
      const baseTy = s.base.ty as NumericType;
      const offsetExpr = emitNdScalarOffset(
        state,
        s.indices,
        baseCName,
        baseTy
      );
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
      // Dispatch through `dispEmitterFor` — one registry maps each
      // ValueShape to its disp helper (text → mtoc_disp_text; tensor
      // → mtoc_disp_tensor[_complex]; scalar char/real/complex →
      // dedicated helpers). New value kinds (cells, structs, classes)
      // plug in by adding an arm there, not by editing this switch.
      const ty = s.arg.ty;
      const dispEmit = dispEmitterFor(ty);
      if (dispEmit === null) {
        throw new Error(
          `codegen internal: disp of ${typeToString(ty)} reached emitStmt ` +
            `with no matching arm (should have been rejected at lowering)`
        );
      }
      dispEmit(state, level, emitExpr(state, s.arg, 0));
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
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

      pushStmt(
        state,
        level,
        `if (${emitBoolCond(state, level, s.cond, true)}) {`
      );
      state.freedOwned = new Set(preFreed);
      for (const t of s.thenBody) emitStmt(state, level + 1, t);
      armFreedSets.push(state.freedOwned);

      for (const eif of s.elseifs) {
        // Reset currentLevel so any complex temp hoisted by the condition
        // expression is pushed at the outer scope level, not the thenBody level.
        state.currentLevel = level;
        // No hoist for elseif: a hoisted decl would land textually inside
        // the prior arm's `{...}` scope (between its last stmt and its `}`)
        // and the elseif wouldn't see it. Numbl funcs are pure (see anf.ts),
        // so double-eval of the cond on both lanes is benign.
        pushStmt(
          state,
          level,
          `} else if (${emitBoolCond(state, level, eif.cond, false)}) {`
        );
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
      pushStmt(
        state,
        level,
        `while (${emitBoolCond(state, level, s.cond, false)}) {`
      );
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
      // is what we care about for cross-runner parity. Strings and
      // char arrays funnel through the same text-view helper.
      useRuntimeByName(state, "mtoc_error_text");
      const view = wrapTextView(state, s.arg.ty, emitExpr(state, s.arg, 0));
      pushStmt(state, level, `mtoc_error_text(${view});`);
      break;
    }

    case "Assert": {
      // `assert(cond)` and `assert(cond, msg)` lower to runtime
      // helpers that print on stderr and exit(1) when `cond` is zero
      // or NaN. On success the helper is a no-op so anything after
      // this stmt runs normally — unlike Error, we still need to
      // free dead-after vars on the success path. The 2-arg form
      // routes through the text-view helper, accepting either a
      // string or a char-array msg uniformly.
      //
      // Complex conds reduce to a real 0.0/1.0 via numbl's toBool
      // (`creal(z) != 0 || cimag(z) != 0`); the resulting bool is
      // never NaN, so the existing real-side helpers fail correctly
      // on a both-lanes-zero value and pass on anything else. The
      // `emitBoolCond` helper hoists a non-Var complex cond to a
      // temp so a Call-bearing condition isn't double-evaluated.
      const condC = emitBoolCond(state, level, s.cond, true);
      if (s.msg === null) {
        useRuntimeByName(state, "mtoc_assert_double");
        pushStmt(state, level, `mtoc_assert_double(${condC});`);
      } else {
        useRuntimeByName(state, "mtoc_assert_double_msg_text");
        const view = wrapTextView(state, s.msg.ty, emitExpr(state, s.msg, 0));
        pushStmt(
          state,
          level,
          `mtoc_assert_double_msg_text(${condC}, ${view});`
        );
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
      break;
    }

    case "Fprintf": {
      // Build a C99 compound-literal array of `mtoc_fprintf_arg_t`
      // entries, one per value arg, then pass it to the runtime
      // helper. The helper does the format walk (numbl-compatible
      // engine — see `runtime/format_engine.h`) and writes to stdout.
      // Activates the umbrella `mtoc_fprintf` snippet; deps pull in
      // the engine, text view, tensor struct, and complex formatter.
      useRuntimeByName(state, "mtoc_fprintf");
      const fmtView = wrapTextView(state, s.fmt.ty, emitExpr(state, s.fmt, 0));
      if (s.args.length === 0) {
        // No value args — pass a NULL pointer and count 0 so the
        // helper still walks the format string (which may contain
        // escape sequences like `\n` we need to interpret).
        pushStmt(
          state,
          level,
          `mtoc_fprintf(stdout, ${fmtView}, 0, (const mtoc_fprintf_arg_t *)0);`
        );
      } else {
        const initList = s.args.map(a => formatArgInit(state, a)).join(", ");
        pushStmt(
          state,
          level,
          `mtoc_fprintf(stdout, ${fmtView}, ${s.args.length}, ` +
            `(mtoc_fprintf_arg_t[]){${initList}});`
        );
      }
      emitEarlyFrees(state, level, deadAfterStmt(state, s));
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
      // free emit. `currentScopeVars` is set to the function's
      // owned-locals + tensor-params set (with output cNames already
      // excluded for the body-end binding) by `emitFunctionBody`.
      // Lowering only emits this kind inside a function body, so
      // the field is always non-null here.
      if (
        state.currentScopeVars === null ||
        state.currentFunctionOutputs === null
      ) {
        throw new Error(
          "codegen internal: ReturnFromFunction reached emit outside a " +
            "function scope; should have been rejected at lowering"
        );
      }
      const outputs = state.currentFunctionOutputs;
      // Mark each owned output's per-return cName as "already freed"
      // so the scope-exit walk leaves it alone — the buffer transfers
      // to the caller (return-by-value for the 1-output path,
      // `mtoc_<kind>_assign` sret write for the N-output path). The
      // post-body cName captured in `currentScopeVars`'s exclude list
      // may differ from `s.outputCNames[i]` after a top-level
      // variable split inside the function body, so we mark both
      // here via the per-return list.
      for (let i = 0; i < outputs.length; i++) {
        if (isOwned(outputs[i].ty)) {
          state.freedOwned.add(s.outputCNames[i]);
        }
      }
      // Multi-output: write sret slots BEFORE the free walk. Owned
      // slots route through `mtoc_<kind>_assign` so the caller's
      // prior buffer at the lvalue is consumed; scalar slots use a
      // plain pointer store. The cName per slot is the LIVE
      // post-body binding captured on the IR node (which may differ
      // from outputs[i].cName after a top-level reassignment split).
      if (outputs.length >= 2) {
        emitOwnedAwareSretWrites(
          state,
          level,
          outputs.map((o, i) => ({ ty: o.ty, cName: s.outputCNames[i] }))
        );
      }
      emitScopeExitFrees(
        state,
        level,
        state.currentScopeVars,
        state.freedOwned
      );
      if (outputs.length === 0) {
        // Zero-output function: no value to carry back, no out-pointer
        // writes. Emit a bare `return;` so the C control-flow path is
        // explicit. Falls through cleanly to the `void` return type
        // emitted by `emitFunction`.
        pushStmt(state, level, `return;`);
      } else if (outputs.length === 1) {
        if (outputs[0].ty.kind === "Handle") {
          // Phantom handle output: the function was emitted with
          // `void` return type; emit a bare `return;` instead of
          // `return <cName>;`.
          pushStmt(state, level, `return;`);
        } else {
          // Classic single-output convention: return-by-value of the
          // local that holds the output's current value at this exit
          // point. The lowerer captured that live cName when it built
          // the IR node.
          pushStmt(state, level, `return ${s.outputCNames[0]};`);
        }
      } else {
        // Multi-output sret writes already emitted above; just return.
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
      // Copy-on-arg-pass for owned-kind args (tensor / char-array /
      // struct / handle-with-captures), mirroring the regular `Call`
      // path in `emitExpr`. `wrapOwnedArgCopy` returns the input
      // unchanged for non-owned types.
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
      //
      // Owned discard slots (tensors / char tensors / strings) need
      // (1) initialization to an empty handle before the call so the
      // callee's `mtoc_<kind>_assign` sees a freeable starting value,
      // and (2) a `mtoc_<kind>_free` after the call so the freshly
      // installed buffer doesn't leak.
      const callIdx = state.multiAssignCallCounter++;
      pushStmt(state, level, `{`);
      const outArgs: string[] = [];
      const ownedDiscards: {
        cName: string;
        owned: ReturnType<typeof ownedOps>;
      }[] = [];
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
          const owned = ownedOps(slot.ty);
          if (owned !== null) {
            emitOwnedEmptyDecl(state, level + 1, owned, tmp);
            ownedDiscards.push({ cName: tmp, owned });
          } else {
            pushStmt(state, level + 1, `${cTy} ${tmp};`);
          }
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
      // Release owned discard temps before closing the block. The
      // callee's `mtoc_<kind>_assign` consumed the empty handle and
      // installed a fresh buffer; we free it here so it doesn't leak.
      for (const d of ownedDiscards) {
        useSnippet(state, d.owned!.free);
        pushStmt(state, level + 1, `${d.owned!.free.name}(&${d.cName});`);
      }
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
      useRuntimeByName(state, "mtoc_loop_count");
      const preFreed = new Set(state.freedOwned);
      pushStmt(state, level, `{`);
      pushStmt(state, level + 1, `double _mtoc_start = ${startStr};`);
      pushStmt(state, level + 1, `double _mtoc_end = ${endStr};`);
      pushStmt(
        state,
        level + 1,
        `long _mtoc_n = mtoc_loop_count(_mtoc_start, _mtoc_end, ${stepStr});`
      );
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
