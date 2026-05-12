/**
 * Emit-time state shared across the codegen pipeline.
 *
 * `EmitState` carries every mutable piece the per-stmt / per-expr
 * helpers need: header flags, runtime-helper activation tables, the
 * line buffer, the iter-stack, scope-level liveness inputs, and the
 * per-function output convention. It is created once by the top-level
 * `emitC` driver and threaded through every helper.
 *
 * Sibling modules (`emitExpr`, `emitStmt`, `emitOwned`, `emitFunction`)
 * import the type and the small set of state-aware helpers
 * (`useRuntime`, `useRuntimeByName`, `pushStmt`, `indent`,
 * `builtinEmitFacade`) from this file.
 */

import type { VarBinding } from "../lowering/ir.js";
import type { MType } from "../lowering/types.js";
import type { BuiltinEmitState } from "../workspace/builtins.js";
import type { FutureTouchMap } from "./liveness.js";
import type { FusionPlan } from "./opt/fuseSameShape.js";
import type { ColumnSlicePlan } from "./opt/inlineColumnSlice.js";
import type { TransposePlan } from "./opt/inlineTranspose.js";
import { RUNTIME_HELPERS, type RuntimeSnippet } from "./runtime.js";

/** Per-slice emit-time info for a slice that has been inlined into
 *  the consumer currently in this iter frame. The Var-read for the
 *  slice's cName at `emitExpr` consults this map and substitutes a
 *  direct read into the base tensor; the slice handle itself is
 *  never populated.
 *
 *   - `baseCName`: C identifier for the base tensor struct.
 *   - `axis`: ranging axis (0 = column slice / axis 0 ranges;
 *             1 = row slice / axis 1 ranges).
 *   - `fixedIndexCName`: name of a `long` local declared at the
 *             top of the consumer's emission block; holds the
 *             0-based fixed-axis index. */
export interface InlinedSliceFrameInfo {
  baseCName: string;
  axis: 0 | 1;
  fixedIndexCName: string;
}

/** Per-transpose emit-time info for a transpose that has been
 *  inlined into the consumer currently in this iter frame. The
 *  Var-read for the transpose's cName at `emitExpr` consults this
 *  map and substitutes a direct read into the base tensor with
 *  swapped axes; the transpose handle itself is never populated.
 *
 *   - `baseCName`: C identifier for the base tensor struct.
 *   - `outputAxisKinds`: static dim lattice of the transpose's
 *             OUTPUT (axes already swapped relative to the base).
 *             Drives per-axis term selection at the substitution
 *             site, exactly mirroring what the broadcast emitter
 *             would have done for a materialized transpose. */
export interface InlinedTransposeFrameInfo {
  baseCName: string;
  outputAxisKinds: readonly [
    import("../lowering/types.js").DimInfo,
    import("../lowering/types.js").DimInfo,
  ];
}

/** A frame on the per-element-loop stack. `flat` is the same-shape
 *  case where every multi-element operand has identical layout and
 *  shares one iter variable. `broadcast` is the implicit-expansion
 *  case where each multi-element operand has its own precomputed
 *  linear index variable — keyed by C name — so a size-1 axis on one
 *  operand reads the same element while the others advance.
 *
 *  Both kinds carry an optional `inlinedSlices` map for the
 *  column-slice inlining peephole (`opt/inlineColumnSlice.ts`):
 *  when a slice has been inlined into this consumer, the map keys
 *  its cName to the emit-time info needed by the Var-read
 *  substitution at `emitExpr`. The `broadcast` frame additionally
 *  carries its `loopVars` (one per output axis) so the substitution
 *  can pick the correct ranging-axis loop variable. */
export type IterFrame =
  | {
      kind: "flat";
      iter: string;
      inlinedSlices?: ReadonlyMap<string, InlinedSliceFrameInfo>;
      inlinedTransposes?: ReadonlyMap<string, InlinedTransposeFrameInfo>;
    }
  | {
      kind: "broadcast";
      perVarIndex: ReadonlyMap<string, string>;
      loopVars: ReadonlyArray<string>;
      inlinedSlices?: ReadonlyMap<string, InlinedSliceFrameInfo>;
      inlinedTransposes?: ReadonlyMap<string, InlinedTransposeFrameInfo>;
    };

export interface EmitState {
  /** Boxed so the `BuiltinSig.emit` closure (which receives a small
   *  facade view, not the whole EmitState) can flip it. */
  needMath: { value: boolean };
  /** True when any complex value (literal, declaration, or operation)
   *  has been emitted — drives `<complex.h>` inclusion. Boxed for the
   *  same reason as `needMath`. */
  needComplex: { value: boolean };
  /** True when the emitted code calls `abort()` directly (e.g. the
   *  range-write count-mismatch path), requiring `<stdlib.h>`. With
   *  `includeRuntime: true` this header is already pulled in
   *  transitively by the alloc helper; with `includeRuntime: false`
   *  snippets are stripped so we must emit it explicitly. */
  needStdlib: { value: boolean };
  /** The indentation level of the statement currently being emitted.
   *  Set at the top of each `emitStmt` call and restored before any
   *  condition expression that follows body processing (e.g. `else if`).
   *  Used by `emitComplexCmpOrLogical` and the `Unary Not` complex path
   *  to push hoisted temp declarations at the right scope level. */
  currentLevel: number;
  /** Counter for synthetic complex-temp names emitted by
   *  `emitComplexCmpOrLogical` and the complex `Unary Not` path to
   *  avoid double-evaluating a Call-bearing complex operand. Each use
   *  takes the next available index and increments. */
  complexTmpCounter: number;
  /** Runtime helpers used by the program, in stable order. */
  runtime: RuntimeSnippet[];
  /** Names of helpers already added to `runtime` (dedup). */
  runtimeNames: Set<string>;
  lines: string[];
  /** Stack of per-element loop frames. emit pushes one when it opens a
   *  per-element loop for a multi-element `Assign` RHS; the top of the
   *  stack is the innermost frame. When the stack is non-empty,
   *  multi-element `Var`s render as `<cName>.real[<idx>]` instead of
   *  `<cName>` (scalar `Var`s and `NumLit`s broadcast unchanged). The
   *  index expression comes from the frame: a single flat iter name
   *  in the same-shape case, or a per-operand precomputed index in
   *  the broadcasting case. Empty at the top level — scalar codegen
   *  contexts reject multi-element sub-exprs as before. */
  iterStack: IterFrame[];
  /** Counter for synthetic loop-index names so nested elementwise
   *  loops don't shadow each other. */
  elemwiseLoopCounter: number;
  /** assignedVars of the scope currently being emitted (main's vars
   *  while emitting `prog.stmts`, or the function's vars while
   *  emitting a function body). Used by the scope-exit cleanup helper
   *  to know which heap backings to free at `return` sites, and by
   *  `emitEarlyFrees` to look up an owned var's type so it can pick
   *  between `mtoc_tensor_free` and `mtoc_string_free`. */
  currentScopeVars: ReadonlyMap<string, VarBinding> | null;
  /** Per-statement future-touch sets for the scope currently being
   *  emitted. Drives the "early free" walk: an owned `v` whose last
   *  touch is statement `s` (i.e. `v` is in `(uses ∪ defs)(s)` but
   *  NOT in `futureTouchOut(s)`) gets a free call (tensor or string,
   *  picked from `v`'s type) immediately after the statement's C
   *  output. Null at the very top before any scope is entered. */
  futureTouches: FutureTouchMap | null;
  /** Owned C-names (tensors and strings; see `isOwned`) that have
   *  already been freed on the current linear emission path. Drives
   *  two things:
   *    - the scope-exit / `ReturnFromFunction` walk skips any var
   *      already in this set (avoids the redundant double-free emit),
   *    - branch merges in `If` take the intersection of the
   *      per-arm freed sets so a var freed only on some paths still
   *      gets the scope-exit safety-net free.
   *  Loop bodies snapshot-and-restore around themselves: vars freed
   *  inside the body don't graduate to the post-loop freed set,
   *  because the loop may have iterated zero times. */
  freedOwned: Set<string>;
  /** The outputs[] array of the user function currently being emitted,
   *  or null at script scope. Drives the codegen for
   *  `IRStmt.ReturnFromFunction`:
   *    - null   : script scope. (Lowering rejects `return` here, so a
   *               ReturnFromFunction reaching emit means a lowerer escape.)
   *    - length 0: zero-output function — emit a bare `return;` (no
   *               value).
   *    - length 1: classic single-output function — emit
   *               `return <cName>;` (return-by-value).
   *    - length ≥ 2: multi-output function — emit `*_mtoc_o<i> = <cName>;`
   *               for each output, then `return;`. */
  currentFunctionOutputs: ReadonlyArray<{
    name: string;
    cName: string;
    ty: MType;
  }> | null;
  /** Counter for synthetic discard-temp suffixes used at multi-output
   *  call sites (`_mtoc_discard_<N>_<slot>`). Each `MultiAssignCall`
   *  takes the next available index and bumps the counter, so two
   *  adjacent calls don't collide even though the temps are scoped
   *  inside per-call `{}` blocks. */
  multiAssignCallCounter: number;
  /** Optimizer fusion plan for the scope currently being emitted, or
   *  `null` when fusion is disabled or no scope is active. The plan
   *  is a value-typed read-only record: a set of producer `Assign`s
   *  to skip, plus a map of consumer `Assign`s to their rewritten
   *  RHSes (with fused producers' RHSes inlined). Hook points in
   *  `emitStmt.ts` and `emitAnalysis.ts` consult this field; a `null`
   *  plan returns the codegen to its pre-fusion behavior. See
   *  `src/codegen/opt/fuseSameShape.ts`. */
  fusionPlan: FusionPlan | null;
  /** Column-slice inlining plan for the scope currently being
   *  emitted, or `null` when disabled or no scope is active. Hook
   *  points in `emitStmt.ts` (skip slice producers; pass the
   *  consumer's inline map down to `emitTensor`), `emitTensor.ts`
   *  (resolve axis sizes from the base, skip per-operand precompute,
   *  attach inline info to the iter frame), and `emitExpr.ts`
   *  (substitute slice Var reads) consult this field. See
   *  `src/codegen/opt/inlineColumnSlice.ts`. */
  columnSlicePlan: ColumnSlicePlan | null;
  /** Transpose inlining plan for the scope currently being emitted,
   *  or `null` when disabled or no scope is active. Same hook
   *  structure as the column-slice plan: skip producers, override
   *  per-operand axis sizes (swap base dims), skip per-operand
   *  precompute, attach inline info to the iter frame, substitute
   *  the Var read at emitExpr. See
   *  `src/codegen/opt/inlineTranspose.ts`. */
  transposePlan: TransposePlan | null;
  /** When true, every per-scope plan-build site substitutes the
   *  empty plan (no fusion). Mirrors the
   *  `EmitOptions.disableOptimizations` knob; carried on the state
   *  so `emitFunctionBody`'s plan-build call doesn't need an extra
   *  parameter. */
  disableOptimizations: boolean;
}

/** Build the small facade view passed to `BuiltinSig.emit` closures.
 *  Hides the full `EmitState`; exposes only what the closures need
 *  (boxed needMath + a useRuntime function). */
export function builtinEmitFacade(state: EmitState): BuiltinEmitState {
  return {
    needMath: state.needMath,
    useRuntime: name => useRuntimeByName(state, name),
  };
}

/** Activate a registered runtime snippet, pulling its dependency
 *  closure in transitively so each helper definition appears above
 *  its callers in the emitted output. Idempotent: a name already in
 *  `state.runtimeNames` is a no-op. */
export function useRuntime(
  state: EmitState,
  name: string,
  snippet: RuntimeSnippet
): void {
  if (state.runtimeNames.has(name)) return;
  state.runtimeNames.add(name);
  // Pull in dependencies first so their definitions precede ours.
  for (const dep of snippet.deps) {
    const depSnippet = RUNTIME_HELPERS.get(dep);
    if (depSnippet) useRuntime(state, dep, depSnippet);
  }
  state.runtime.push(snippet);
}

/** Activate a snippet looked up from the registry by name. Throws if
 *  the name isn't registered — that means a codegen path is referring
 *  to a helper that doesn't exist. */
export function useRuntimeByName(state: EmitState, name: string): void {
  const snippet = RUNTIME_HELPERS.get(name);
  if (!snippet) {
    throw new Error(`codegen: unknown runtime helper '${name}'`);
  }
  useRuntime(state, name, snippet);
}

export function indent(level: number): string {
  return "  ".repeat(level);
}

export function pushStmt(state: EmitState, level: number, s: string): void {
  state.lines.push(`${indent(level)}${s}`);
}
