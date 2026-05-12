/**
 * Shared C-build options for mtoc's `run` paths.
 *
 * The CLI's `mtoc run` ([cli.ts](./cli.ts)) and the execution
 * server's `/run` endpoint ([../server/execution-service.ts](../server/execution-service.ts))
 * both translate numbl source to C, write it to a temp file, invoke
 * a C compiler, then execute the resulting binary. They differ only
 * in their I/O model (synchronous stdio for the CLI; an SSE stream
 * for the server). The translation pipeline is shared via
 * `translateProject`; this module shares the compile-flag side so
 * both paths produce the same binary for a given set of build
 * options.
 *
 * Adding a new build option (e.g. `--sanitize-thread`, `-Og`, etc.)
 * lands in one place here and both surfaces pick it up uniformly.
 */
export interface BuildOptions {
  /** Build with `-fsanitize=address -g`. AddressSanitizer +
   *  LeakSanitizer flag any unfreed buffer at exit. ~2x slowdown.
   *  Default false; the cross-runner enables this for every script. */
  checkLeaks?: boolean;
  /** Build with `-ffast-math`. Lets the C compiler reassociate
   *  floating-point ops so hot loops vectorize more aggressively.
   *  NOT IEEE-754 strict; numerics may drift in the last few ulps.
   *  Default false to keep run output bit-stable with the
   *  cross-runner oracle. */
  fastMath?: boolean;
  /** Run the tensor-expression inlining pass before codegen.
   *  Substitutes every single-use multi-element tensor Assign's RHS
   *  into its unique consumer, eliminating large intermediate
   *  tensors that thrash cache between separate loops. Default
   *  false during rollout; see
   *  `src/codegen/inline/inlinePass.ts`. */
  enableTempInlining?: boolean;
  /** Max threads to use for parallelizable loops.
   *  - `1` (or omitted): pure serial. No `#pragma omp` lines emitted,
   *    no `<omp.h>` include, no `-fopenmp` on the link. Bit-identical
   *    to today's output.
   *  - `"auto"`: OpenMP picks the thread count at runtime (typically
   *    `OMP_NUM_THREADS` env var, falling back to # cores). The emitted
   *    main() does NOT call `omp_set_num_threads`.
   *  - a number `>= 2`: emitted main() calls
   *    `omp_set_num_threads(N)` once at startup; OpenMP caps each
   *    `parallel for` region at N threads.
   *  The pragmas use a runtime `if(...)` clause so small loops stay
   *  serial regardless of this setting (avoids fork overhead on
   *  trivially-small tensors). */
  threads?: number | "auto";
}

/** Build the argv array for the C compiler. Both `mtoc run` and the
 *  execution server's `/run` endpoint go through this so a binary
 *  built one way is bit-identical to one built the other way for the
 *  same `BuildOptions`. `-O3 -march=native` is unconditional — the
 *  CLI's `mtoc run` and the execution server are both meant to
 *  represent "what users will ship," not debug builds. */
export function buildCcArgs(
  cFile: string,
  exeFile: string,
  opts: BuildOptions = {}
): string[] {
  const args = [cFile, "-o", exeFile, "-lm", "-O3", "-march=native"];
  if (opts.checkLeaks) args.push("-fsanitize=address", "-g");
  if (opts.fastMath) args.push("-ffast-math");
  // `-fopenmp` is only added when the user has opted into parallel
  // loops. With threads=1 (the default) the emitted C has no `#pragma
  // omp` lines and no `<omp.h>` include, so the build stays toolchain-
  // identical to today's serial output.
  if (isParallelThreadsOption(opts.threads)) args.push("-fopenmp");
  return args;
}

/** True when `threads` requests parallel codegen — i.e. anything other
 *  than `undefined` / `1`. Centralized so the CLI, server, codegen, and
 *  build-flag layer all agree on the "is parallel" predicate. */
export function isParallelThreadsOption(
  threads: number | "auto" | undefined
): boolean {
  return threads !== undefined && threads !== 1;
}

/** Optimization level for the WASM build. Native always uses `-O3 -march=native`,
 *  but for WASM we expose `-O2` (faster compile, decent code) and `-O3` (slower
 *  compile, better code) as separate choices. */
export type WasmOptLevel = "O0" | "O2" | "O3";

export interface WasmBuildOptions {
  /** `-ffast-math`. Same semantics as the native build — reassociates FP ops,
   *  may drift in the last few ulps. Default false. */
  fastMath?: boolean;
  /** `-msimd128`. Enables WebAssembly SIMD128 vectorization. Default false.
   *  Browsers without SIMD support (or Node without `--experimental-wasm-simd`,
   *  though Node 16+ has it on by default) will fail to instantiate the module. */
  simd?: boolean;
  /** Optimization level. Default `O2`. */
  optLevel?: WasmOptLevel;
}

/** Build the argv for `emcc` to compile a single C file into a `.mjs`
 *  glue + sibling `.wasm`. The glue is emitted as an ES module that
 *  default-exports a `createMtocModule(overrides)` factory; the
 *  browser/Node host imports it and passes `wasmBinary`, `print`, and
 *  `printErr` to wire stdout/stderr into the host's console plumbing.
 *
 *  `outBase` is the path without extension — emcc will produce
 *  `<outBase>.mjs` and `<outBase>.wasm`.
 *
 *  Threads/OpenMP are intentionally NOT supported here: the upstream
 *  emsdk does not currently ship `omp.h`, so `#include <omp.h>` from the
 *  mtoc runtime fails to compile. Callers must pass `threads=1` to
 *  translation when targeting WASM so no `<omp.h>` include is emitted.
 *  See `docs/web.md` for the long-term plan. */
export function buildEmccArgs(
  cFile: string,
  outBase: string,
  opts: WasmBuildOptions = {}
): string[] {
  const optLevel = opts.optLevel ?? "O2";
  const args = [
    cFile,
    "-o",
    `${outBase}.mjs`,
    "-lm",
    `-${optLevel}`,
    // ES-module glue that the browser loads via dynamic `import()` of a
    // Blob URL. `EXPORT_NAME` is the factory's default-export name (not
    // a global), so its value mostly affects internal symbol names.
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createMtocModule",
    // The glue auto-detects web/worker/Node so the same artifact runs in
    // the browser and in the cross-runner harness under Node.
    "-sENVIRONMENT=web,worker,node",
    "-sINITIAL_MEMORY=16777216",
    "-sALLOW_MEMORY_GROWTH=1",
    // `exit(N)` from the runtime's error helpers must flush stdout/stderr
    // and propagate the code to `Module.onExit`. Without EXIT_RUNTIME=1
    // emscripten treats `exit` as a noisy abort.
    "-sEXIT_RUNTIME=1",
    // INVOKE_RUN=1 (the default) means `_main` runs at module-factory time;
    // the host doesn't have to call it manually.
    "-sINVOKE_RUN=1",
    // No filesystem support — mtoc-emitted C only uses stdio.
    "-sFILESYSTEM=0",
  ];
  if (opts.simd) args.push("-msimd128");
  if (opts.fastMath) args.push("-ffast-math");
  return args;
}
