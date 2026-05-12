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
  /** Run the tensor-expression fusion pass before codegen. Collapses
   *  chains of single-use elementwise tensor Assigns into one fused
   *  loop. Default false during rollout; see
   *  `src/codegen/fuse/inlinePass.ts`. */
  enableTensorFusion?: boolean;
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
  return args;
}
