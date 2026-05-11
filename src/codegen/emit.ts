/**
 * C code generator — typed IR → self-contained C source string.
 *
 * `emitC` is the top-level orchestrator: it builds an `EmitState`,
 * runs the analysis pre-walk over every body in the program (to
 * activate runtime helpers and set header flags in the right order),
 * emits each user-function specialization, emits the `main` body,
 * and finally assembles the headers + runtime snippets + function
 * blocks + main into a single C source string.
 *
 * The actual emission logic lives in topical sibling modules:
 *   - `emitFormat.ts`   — pure formatters (NumLit, StringLit, op tables, precedence).
 *   - `emitState.ts`    — `EmitState` + runtime-helper activation + line plumbing.
 *   - `emitExpr.ts`     — `emitExpr` / `analyzeExpr` / complex helper / arg-copy wrapper.
 *   - `emitAnalysis.ts` — `analyzeStmts` / `deadAfterStmt` / `emitEarlyFrees` / `formatArgInit`.
 *   - `emitStmt.ts`     — `emitStmt` dispatch over IRStmt kinds.
 *   - `emitTensor.ts`   — tensor-literal and elementwise-loop Assign emitters.
 *   - `emitSlice.ts`    — indexed read (`IndexSlice`) and write (`IndexSliceStore`) emitters.
 *   - `emitOwned.ts`    — owned-kind declarations + scope-exit frees + per-fn free set.
 *   - `emitFunction.ts` — `emitFunction` + body-emission + header comment.
 *   - `ownedKinds.ts`   — registry mapping owned MType → C helper names.
 *
 * Note: C-name mangling lives in lower.ts (`cNameFor`). Every IR.Var,
 * IR.Assign, IR.For, IR.ReturnFromFunction and IRFunction param /
 * output / assignedVars entry already carries the C identifier the
 * codegen emits. The only names synthesized here (and in the helpers)
 * are scope-local helpers (`_mtoc_i`, `_mtoc_n`, `_mtoc_t`, …) for
 * loop counters and elementwise staging temporaries.
 */

import type { IRProgram } from "../lowering/ir.js";
import { computeFutureTouches } from "./liveness.js";
import { type EmitState } from "./emitState.js";
import { analyzeStmts } from "./emitAnalysis.js";
import { emitStmt } from "./emitStmt.js";
import { emitDeclarations, emitScopeExitFrees } from "./emitOwned.js";
import { emitFunction } from "./emitFunction.js";

/** Options for `emitC`. */
export interface EmitOptions {
  /** When false, the runtime-helper bodies (`mtoc_format_double`,
   *  `mtoc_disp_double`, `mtoc_tensor_t` typedef, etc.) are omitted
   *  from the output. Headers contributed solely by those snippets
   *  are likewise omitted; standard headers needed by the user code
   *  itself (`<math.h>` for `floor()` in for-loops, `<complex.h>`
   *  when complex appears) stay. The caller is then responsible for
   *  providing `mtoc_*` symbols at link time — useful when embedding
   *  mtoc output into a project that supplies its own runtime.
   *  Default: true (full self-contained translation unit). */
  includeRuntime?: boolean;
}

export function emitC(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;

  const state: EmitState = {
    needMath: { value: false },
    needComplex: { value: false },
    needStdlib: { value: false },
    runtime: [],
    runtimeNames: new Set(),
    lines: [],
    iterStack: [],
    elemwiseLoopCounter: 0,
    currentLevel: 1,
    complexTmpCounter: 0,
    currentScopeVars: null,
    futureTouches: null,
    freedOwned: new Set(),
    currentFunctionOutputs: null,
    multiAssignCallCounter: 0,
  };

  // One-pass pre-walk: activates runtime helpers referenced by the
  // program (main + every function body) AND sets `state.needMath`
  // for every node that forces <math.h>. Walking everything before
  // emitting keeps the helper ordering stable.
  for (const fn of prog.functions) analyzeStmts(state, fn.body);
  analyzeStmts(state, prog.stmts);

  // Emit user-function bodies first into separate buffers; we paste
  // them into the output below, before main.
  const functionBlocks: string[][] = prog.functions.map(fn =>
    emitFunction(state, fn, emitStmt)
  );

  // Predeclare every assigned variable at the top of main. Hoisting
  // keeps the C valid even when an `if` branch introduces a new
  // variable that is read after the block.
  state.currentScopeVars = prog.assignedVars;
  state.futureTouches = computeFutureTouches(prog.stmts);
  state.freedOwned = new Set();
  emitDeclarations(state, 1, prog.assignedVars);
  for (const s of prog.stmts) emitStmt(state, 1, s);
  // Free every tensor backing allocated for top-level vars not
  // already released earlier on the linear path before `return 0;`.
  // (Process exit would reclaim it anyway, but the free keeps memory
  // tooling clean and matches the function-body pattern.)
  emitScopeExitFrees(state, 1, prog.assignedVars, state.freedOwned);
  state.currentScopeVars = null;
  state.futureTouches = null;

  // Headers: explicit needs from user code, plus runtime-snippet
  // headers when those snippets are part of the output. With
  // `includeRuntime: false`, only the user-code-level needs survive
  // — the caller's link environment supplies whatever the runtime
  // helpers would have brought in.
  const headerSet = new Set<string>(["<stdio.h>"]);
  if (state.needMath.value) headerSet.add("<math.h>");
  if (state.needComplex.value) headerSet.add("<complex.h>");
  if (state.needStdlib.value) headerSet.add("<stdlib.h>");
  if (includeRuntime) {
    for (const snippet of state.runtime) {
      for (const h of snippet.headers) headerSet.add(h);
    }
  }
  const headers = [...headerSet].map(h => `#include ${h}`);

  const runtimeBlocks = includeRuntime ? state.runtime.map(s => s.code) : [];

  const out: string[] = [...headers, ""];
  for (const block of runtimeBlocks) {
    out.push(block, "");
  }
  for (const fnLines of functionBlocks) {
    out.push(...fnLines, "");
  }
  out.push("int main(void) {", ...state.lines, "  return 0;", "}", "");
  return out.join("\n");
}
