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
  isMultiElement,
  isNumeric,
  typeToString,
} from "../lowering/types.js";
import { computeFutureTouches } from "./liveness.js";
import { ownedOps } from "./ownedKinds.js";
import { pushStmt, useRuntimeByName, type EmitState } from "./emitState.js";
import {
  emitDeclarations,
  emitScopeExitFrees,
  functionFreeOnExitSet,
} from "./emitOwned.js";

/** Emit the body of a user-defined function (predeclarations + body
 *  stmts + scope-exit frees + final return) into a fresh local-line
 *  buffer. The frees pair with `emitDeclarations`'s heap allocations
 *  AND with the caller-side `mtoc_tensor_copy` for every tensor
 *  parameter: every tensor local AND every owned tensor param is
 *  freed before the implicit fall-through return, and every
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
  // owned tensor params from the call site.
  const freeOnExit = functionFreeOnExitSet(fn);
  state.currentScopeVars = freeOnExit;
  state.futureTouches = computeFutureTouches(fn.body);
  state.freedOwned = new Set();
  state.currentFunctionOutputs = fn.outputs;

  emitDeclarations(state, 1, fn.assignedVars);
  for (const s of fn.body) emitStmt(state, 1, s);
  // Implicit fall-through return at the end of the function: free every
  // tensor backing not already released earlier on the linear path,
  // then carry the output(s) back. Early-exit `return` paths emitted
  // by `IRStmt.ReturnFromFunction` carry their own copy of the free
  // preamble + output write (see `emitStmt`).
  emitScopeExitFrees(state, 1, freeOnExit, state.freedOwned);
  if (fn.outputs.length === 0) {
    // 0-output: C `void` function; no fall-through write or return
    // value is needed. Skip the trailing `return;` — falling off the
    // end of a `void` function is well-defined.
  } else if (fn.outputs.length === 1) {
    // Classic single-output convention: return-by-value of the
    // post-body live binding's C name.
    pushStmt(state, 1, `return ${fn.outputs[0].cName};`);
  } else {
    // Multi-output convention: write each output's local through the
    // matching `_mtoc_o<i>` out-pointer, then `return;`. Out-pointers
    // are declared as C parameters by `emitFunction`.
    for (let i = 0; i < fn.outputs.length; i++) {
      pushStmt(state, 1, `*_mtoc_o${i} = ${fn.outputs[i].cName};`);
    }
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
  //                   scalar complex → `double _Complex`).
  //   - N outputs   : `void` return type plus one trailing
  //                   `T_i *_mtoc_o<i>` parameter per output.
  // Lowering rejects tensor outputs per-output (sret is a future
  // stage); any tensor shape reaching here is a lowerer escape.
  for (const o of fn.outputs) {
    if (isMultiElement(o.ty)) {
      throw new Error(
        `codegen: function '${fn.matlabName}' output '${o.name}' has ` +
          `unsupported type ${typeToString(o.ty)}`
      );
    }
  }
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
    if (owned !== null) useRuntimeByName(state, owned.structSnippet);
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
      if (isNumeric(o.ty) && o.ty.isComplex) state.needComplex.value = true;
      paramParts.push(`${cTy} *_mtoc_o${i}`);
    }
  }
  const paramList = paramParts.join(", ");
  const sig = `static ${returnCTy} ${fn.mangledName}(${paramList || "void"}) {`;
  const { lines } = emitFunctionBody(state, fn, emitStmt);
  return [...functionHeaderComment(fn), sig, ...lines, "}"];
}
