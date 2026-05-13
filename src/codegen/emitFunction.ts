/**
 * User-defined function emission.
 *
 * Each `IRFunction` produces:
 *   - a header comment (source location, mangled name, type signature)
 *   - a C signature with the right ABI for 0 / 1 / N≥2 outputs
 *   - a body with predeclarations, the lowered statements, scope-exit
 *     frees, and the implicit fall-through return shape.
 *
 * The 0/1/N output split is documented inline; see also
 * `docs/specialization.md` for the language-side contract.
 */

import type { IRFunction, IRStmt } from "../lowering/ir.js";
import {
  cTypeFor,
  isNumeric,
  isOwned,
  typeToString,
} from "../lowering/types.js";
import { computeFutureTouches } from "./liveness.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useSnippet, type EmitState } from "./emitState.js";
import {
  emitDeclarations,
  emitScopeExitFrees,
  functionFreeOnExitSet,
} from "./emitOwned.js";

/** Per-function scope-exit free set with output cNames removed. Owned
 *  return values transfer to the caller — for a 1-output function the
 *  struct is returned by value; for an N-output function the callee
 *  hands the buffer off via `mtoc_<kind>_assign(_mtoc_o<i>, <local>)`.
 *  Either way the callee must NOT free the output's heap buffer, so we
 *  strip those cNames from the otherwise-routine `functionFreeOnExitSet`
 *  (which still releases owned tensor params and other locals). */
export function scopeExitFreeSet(
  fn: IRFunction
): ReadonlyMap<string, import("../lowering/ir.js").VarBinding> {
  const base = functionFreeOnExitSet(fn);
  // Strip every output cName that holds an owned value.
  const out = new Map(base);
  for (const o of fn.outputs) {
    if (isOwned(o.ty)) out.delete(o.cName);
  }
  return out;
}

/** Write each multi-output sret slot from the corresponding output's
 *  post-body live cName. Owned slots route through the kind's
 *  consume-replace `assign` helper so the caller's prior buffer at the
 *  lvalue is freed before the new handle lands; scalar slots use a
 *  plain pointer store. Activates the helpers it depends on. */
export function emitOwnedAwareSretWrites(
  state: EmitState,
  level: number,
  outputs: ReadonlyArray<IRFunction["outputs"][number]>
): void {
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    const owned = ownedOps(o.ty);
    if (owned !== null) {
      useSnippet(state, owned.structSnippet);
      useSnippet(state, owned.assign);
      pushStmt(state, level, `${owned.assign.name}(_mtoc_o${i}, ${o.cName});`);
    } else {
      pushStmt(state, level, `*_mtoc_o${i} = ${o.cName};`);
    }
  }
}

/** Emit the body of a user-defined function (predeclarations + body
 *  stmts + scope-exit frees + final return) into a fresh local-line
 *  buffer. The frees pair with `emitDeclarations`'s heap allocations
 *  AND with the caller-side `mtoc_tensor_copy` for every tensor
 *  parameter: every tensor local AND every owned tensor param is
 *  freed before the implicit fall-through return — except cNames that
 *  hold a return value (those transfer to the caller). Every
 *  `IRStmt.ReturnFromFunction` early exit picks up the same free
 *  preamble (driven by `state.currentScopeVars`). */
export function emitFunctionBody(
  state: EmitState,
  fn: IRFunction,
  emitStmt: (state: EmitState, level: number, s: IRStmt) => void
): { lines: string[] } {
  // Swap in a fresh `lines` buffer so the function's body lines don't
  // intermix with main's. Other state (runtime / needMath) is shared.
  const outerLines = state.lines;
  const outerScopeVars = state.currentScopeVars;
  const outerLiveness = state.futureTouches;
  const outerFreed = state.freedOwned;
  const outerOutputs = state.currentFunctionOutputs;
  state.lines = [];
  // Predecls cover assignedVars only — params are declared by the C
  // signature. Scope-exit frees cover both: locals from the body and
  // owned tensor params from the call site — EXCEPT for cNames that
  // hold a return value, since those buffers transfer to the caller
  // (either by return-by-value on the 1-output path, or by an
  // `mtoc_<kind>_assign` sret write on the multi-output path).
  const freeOnExit = scopeExitFreeSet(fn);
  state.currentScopeVars = freeOnExit;
  state.futureTouches = computeFutureTouches(fn.body, fn.outputs);
  state.freedOwned = new Set();
  state.currentFunctionOutputs = fn.outputs;

  emitDeclarations(state, 1, fn.assignedVars);
  for (const s of fn.body) emitStmt(state, 1, s);
  // Implicit fall-through return at the end of the function. Order:
  //   - Multi-output: write each output's sret slot FIRST (using the
  //     consume-replace `mtoc_<kind>_assign` for owned outputs so the
  //     caller's prior buffer is freed before the handoff). Then free
  //     non-output locals. Then `return;`.
  //   - Single-output owned: free non-output locals first, then
  //     `return <cName>;` returns the struct by value. The output's
  //     cName is excluded from `freeOnExit`, so its buffers survive.
  //   - Single-output scalar / 0-output: just free + return.
  // Early-exit `return` paths emitted by `IRStmt.ReturnFromFunction`
  // carry their own copy of the same free + write preamble.
  if (fn.outputs.length >= 2) {
    emitOwnedAwareSretWrites(state, 1, fn.outputs);
  }
  emitScopeExitFrees(state, 1, freeOnExit, state.freedOwned);
  if (fn.outputs.length === 0) {
    // 0-output: C `void` function; no fall-through write or return
    // value is needed. Skip the trailing `return;` — falling off the
    // end of a `void` function is well-defined.
  } else if (fn.outputs.length === 1) {
    // Classic single-output convention: return-by-value of the
    // post-body live binding's C name. For owned types (including
    // handles) the struct copy hands the buffers to the caller; the
    // callee skipped freeing this cName above.
    pushStmt(state, 1, `return ${fn.outputs[0].cName};`);
  } else {
    // Multi-output sret writes already emitted above; just return.
    pushStmt(state, 1, `return;`);
  }

  const bodyLines = state.lines;
  state.lines = outerLines;
  state.currentScopeVars = outerScopeVars;
  state.futureTouches = outerLiveness;
  state.freedOwned = outerFreed;
  state.currentFunctionOutputs = outerOutputs;
  return { lines: bodyLines };
}

/** Render the per-specialization header comment that goes above each
 *  emitted user function. Includes source location, mangled name, and
 *  the inferred type signature so the generated C is self-explanatory. */
function functionHeaderComment(fn: IRFunction): string[] {
  const labelWidth = Math.max(
    "returns".length,
    ...fn.params.map(p => p.name.length),
    ...fn.outputs.map(o => o.name.length)
  );
  const pad = (s: string) => s.padEnd(labelWidth);
  const argSummary = fn.params.map(p => p.name).join(", ");
  const loc = fn.sourceLocation;
  const lineRange =
    loc.startLine === loc.endLine
      ? `${loc.startLine}`
      : `${loc.startLine}-${loc.endLine}`;
  const lines: string[] = [];
  lines.push(
    `/* User function specialization: ${fn.matlabName}(${argSummary})`
  );
  lines.push(` *   defined : ${loc.file}:${lineRange}`);
  lines.push(` *   mangled : ${fn.mangledName}`);
  for (const p of fn.params) {
    lines.push(` *   ${pad(p.name)} : ${typeToString(p.ty)}`);
  }
  if (fn.outputs.length === 0) {
    lines.push(` *   ${pad("returns")} : (none)`);
  } else if (fn.outputs.length === 1) {
    lines.push(` *   ${pad("returns")} : ${typeToString(fn.outputs[0].ty)}`);
  } else {
    // Multi-output: render each output on its own line so the C ABI
    // (out-pointer per output) is readable.
    for (const o of fn.outputs) {
      lines.push(` *   ${pad(o.name)} : ${typeToString(o.ty)} (out)`);
    }
  }
  lines.push(` */`);
  return lines;
}

export function emitFunction(
  state: EmitState,
  fn: IRFunction,
  emitStmt: (state: EmitState, level: number, s: IRStmt) => void
): string[] {
  // C return-type and outputs:
  //   - 0 outputs   : `void` return type, no out-pointer params.
  //   - 1 output    : classic return-by-value (scalar real → `double`,
  //                   scalar complex → `double _Complex`, owned kinds →
  //                   their struct type; ownership transfers via the
  //                   struct copy and the callee skips freeing the
  //                   output's cName).
  //   - N outputs   : `void` return type plus one trailing
  //                   `T_i *_mtoc_o<i>` parameter per output. Owned
  //                   outputs write through `mtoc_<kind>_assign` so
  //                   the caller's prior buffer at the lvalue is
  //                   released before the new handle lands.
  let returnCTy: string;
  if (fn.outputs.length === 1) {
    const cTy = cTypeFor(fn.outputs[0].ty);
    if (cTy === null) {
      throw new Error(
        `codegen: function '${fn.matlabName}' has unsupported return type ` +
          `${typeToString(fn.outputs[0].ty)}`
      );
    }
    returnCTy = cTy;
    // Activate the owned-kind typedef when the return type needs it so
    // the function's signature is valid C wherever it appears.
    const owned = ownedOps(fn.outputs[0].ty);
    if (owned !== null) useSnippet(state, owned.structSnippet);
    if (isNumeric(fn.outputs[0].ty) && fn.outputs[0].ty.isComplex) {
      state.needComplex.value = true;
    }
  } else {
    returnCTy = "void";
  }
  // Per param: `cTypeFor` picks the C representation — `double` for
  // real scalars, `double _Complex` for complex scalars, and the
  // `mtoc_tensor_t` struct for any multi-element tensor (real or
  // complex; the struct's `imag` buffer carries the complex half).
  // Tensor params are owned by the callee: the caller wraps each
  // tensor argument in `mtoc_tensor_copy(...)` (see emitExpr's Call
  // case), so the param's buffer is the callee's responsibility to
  // release. The scope-exit free walk in `emitFunctionBody` adds
  // every multi-element tensor param to the free set.
  const paramParts: string[] = [];
  for (const p of fn.params) {
    const cTy = cTypeFor(p.ty);
    if (cTy === null) {
      throw new Error(
        `codegen: function '${fn.matlabName}' parameter '${p.name}' has ` +
          `unsupported type ${typeToString(p.ty)}`
      );
    }
    // Activate the param's owned-kind typedef so its declaration is
    // valid C. Scalar params have no struct typedef; the registry
    // returns null for them.
    const owned = ownedOps(p.ty);
    if (owned !== null) useSnippet(state, owned.structSnippet);
    if (isNumeric(p.ty) && p.ty.isComplex) state.needComplex.value = true;
    paramParts.push(`${cTy} ${p.cName}`);
  }
  // Multi-output convention: append `T_i *_mtoc_o<i>` per output
  // after the user params, in declaration order.
  if (fn.outputs.length >= 2) {
    for (let i = 0; i < fn.outputs.length; i++) {
      const o = fn.outputs[i];
      const cTy = cTypeFor(o.ty);
      if (cTy === null) {
        throw new Error(
          `codegen: function '${fn.matlabName}' output '${o.name}' has ` +
            `unsupported type ${typeToString(o.ty)}`
        );
      }
      // Owned outputs need their typedef visible in the signature.
      const owned = ownedOps(o.ty);
      if (owned !== null) useSnippet(state, owned.structSnippet);
      if (isNumeric(o.ty) && o.ty.isComplex) state.needComplex.value = true;
      paramParts.push(`${cTy} *_mtoc_o${i}`);
    }
  }
  const paramList = paramParts.join(", ");
  const sig = `static ${returnCTy} ${fn.mangledName}(${paramList || "void"}) {`;
  const { lines } = emitFunctionBody(state, fn, emitStmt);
  return [...functionHeaderComment(fn), sig, ...lines, "}"];
}
