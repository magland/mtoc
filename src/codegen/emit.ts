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
import { pushStmt, type EmitState } from "./emitState.js";
import { analyzeStmts } from "./emitAnalysis.js";
import { emitStmt } from "./emitStmt.js";
import { emitDeclarations, emitScopeExitFrees } from "./emitOwned.js";
import { emitFunction } from "./emitFunction.js";
import { emitOwnedTypedefBlocks } from "./emitOwnedTypedefs.js";
import { inlinePass } from "./inline/inlinePass.js";
import { isParallelThreadsOption } from "../build.js";

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
  /** When true, run the tensor-expression inlining pass before
   *  codegen. Substitutes every single-use multi-element Assign's
   *  RHS into its unique consumer, eliminating large intermediates
   *  that would otherwise thrash cache between the producer's and
   *  consumer's loops. Off by default during rollout; flip on per-
   *  call once you're happy with the byte-for-byte numerics. See
   *  `src/codegen/inline/inlinePass.ts`. */
  enableTempInlining?: boolean;
  /** Max threads to use for parallelizable loops. See
   *  [../build.ts::BuildOptions.threads](../build.ts). `1`/undefined
   *  → no pragmas emitted; `"auto"` → pragmas + no
   *  `omp_set_num_threads()`; number `>= 2` → pragmas + startup
   *  `omp_set_num_threads(N)`. */
  threads?: number | "auto";
}

export function emitC(prog: IRProgram, opts: EmitOptions = {}): string {
  const includeRuntime = opts.includeRuntime ?? true;
  const enableTempInlining = opts.enableTempInlining ?? false;
  const threads = opts.threads ?? 1;

  // Tensor-expression inlining: pure IR-to-IR rewrite. Runs before
  // any codegen analysis so liveness, runtime-helper activation,
  // and emission all see the post-inlining shape. The returned
  // `inlinedFrom` map keys each surviving consumer to the ordered
  // list of pre-inlining comment strings so emitStmt can emit
  // `/* inlined: <src> */` lines above the consumer's source-line
  // comment.
  const inlinedFrom = enableTempInlining ? inlinePass(prog) : new Map();

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
    inlinedFrom,
    threads,
  };

  // One-pass pre-walk: activates runtime helpers referenced by the
  // program (main + every function body) AND sets `state.needMath`
  // for every node that forces <math.h>. Walking everything before
  // emitting keeps the helper ordering stable.
  for (const fn of prog.functions) analyzeStmts(state, fn.body);
  analyzeStmts(state, prog.stmts);

  // Per-shape typedefs + helpers for every owned kind (struct,
  // handle, tuple cell, homogeneous cell), unified by a cross-kind
  // topological sort so a struct field holding a homogeneous-cell
  // value precedes the cell's typedef AND a cell elem holding a
  // struct precedes the struct's typedef. Emitted ahead of the user-
  // function bodies and main.
  const typedefBlocks = emitOwnedTypedefBlocks(state, prog);

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
  // When the user has requested a specific thread count (anything
  // other than "auto" or 1), pin OpenMP to that count at startup.
  // The pinning applies to every subsequent `#pragma omp parallel
  // for` region in the process (main and user functions alike), so
  // one call here suffices.
  if (typeof threads === "number" && threads > 1) {
    pushStmt(state, 1, `omp_set_num_threads(${threads});`);
  }
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
  // `<omp.h>` is only needed when parallel pragmas have been emitted.
  // Add it whenever the threads option is non-serial — that matches
  // the predicate `emitTensor.ts::parallelForPragma` uses to decide
  // whether to emit a `#pragma omp parallel for` and the predicate
  // `buildCcArgs` uses to decide whether to link `-fopenmp`.
  if (isParallelThreadsOption(threads)) headerSet.add("<omp.h>");
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
  if (typedefBlocks.length > 0) {
    out.push(...typedefBlocks);
  }
  for (const fnLines of functionBlocks) {
    out.push(...fnLines, "");
  }
  out.push("int main(void) {", ...state.lines, "  return 0;", "}", "");
  return out.join("\n");
}
