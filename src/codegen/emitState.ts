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
import type { InlinedFromMap } from "./inline/inlinePass.js";
import type { SnippetActivation } from "./ownedKinds.js";
import { RUNTIME_HELPERS, type RuntimeSnippet } from "./runtime.js";

/** A frame on the per-element-loop stack. `flat` is the same-shape
 *  case where every multi-element operand has identical layout and
 *  shares one iter variable. `broadcast` is the implicit-expansion
 *  case where each multi-element operand has its own precomputed
 *  linear index variable — keyed by C name — so a size-1 axis on one
 *  operand reads the same element while the others advance. */
export type IterFrame =
  | { kind: "flat"; iter: string }
  | { kind: "broadcast"; perVarIndex: ReadonlyMap<string, string> };

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
  /** Map from each surviving consumer Assign's cName to the ordered
   *  list of pre-inlining comment strings for every producer that
   *  was inlined into it. Populated by `inlinePass` when inlining is
   *  enabled; empty (default) when inlining is off. `emitStmt` reads
   *  this when emitting the per-stmt source-line comment and
   *  prefixes one `/* inlined: <comment> *\/` line per entry so the
   *  C reader can see every collapsed numbl statement, in source
   *  order. */
  inlinedFrom: InlinedFromMap;
  /** Max threads to use for parallelizable loops; see
   *  [../build.ts::BuildOptions.threads](../build.ts). Read by the
   *  tensor-loop emitters (and the reduction helpers) to decide
   *  whether to emit `#pragma omp parallel for if(_mtoc_n >
   *  MTOC_PARALLEL_MIN_N)` lines, and by `emitC` to decide whether
   *  to include `<omp.h>` and emit a startup `omp_set_num_threads`
   *  call. */
  threads: number | "auto";
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
 *  to a helper that doesn't exist. Used for runtime-only helpers
 *  whose activation key is the same as the C identifier the codegen
 *  emits (libm wrappers, the `mtoc_*` runtime library). For owned-
 *  kind helpers (which may be either runtime-registered or program-
 *  emitted in the same pass), prefer `useSnippet`. */
export function useRuntimeByName(state: EmitState, name: string): void {
  const snippet = RUNTIME_HELPERS.get(name);
  if (!snippet) {
    throw new Error(`codegen: unknown runtime helper '${name}'`);
  }
  useRuntime(state, name, snippet);
}

/** Activate an owned-kind helper. `registered` looks the snippet up in
 *  the runtime registry and pulls it (plus dependencies) into the
 *  emission. `programEmitted` is a deliberate no-op: the helper is
 *  defined inline by `emitStruct.ts` / `emitHandle.ts` during the same
 *  pass, ahead of the user-function bodies, so no registry lookup is
 *  needed.
 *
 *  The discriminated-union form replaces a prior string-sentinel
 *  convention (`__struct__:`/`_mtoc_handle…` prefix sniffing) — call
 *  sites no longer need to know whether a helper is in the registry. */
export function useSnippet(state: EmitState, snip: SnippetActivation): void {
  if (snip.kind === "programEmitted") return;
  useRuntimeByName(state, snip.name);
}

export function indent(level: number): string {
  return "  ".repeat(level);
}

export function pushStmt(state: EmitState, level: number, s: string): void {
  state.lines.push(`${indent(level)}${s}`);
}
