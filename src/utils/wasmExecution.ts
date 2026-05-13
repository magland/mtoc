/**
 * Browser-side WASM-mode pipeline: translate locally, compile remotely,
 * run in-process.
 *
 * Unlike the native path (which sends numbl source to the local
 * `mtoc serve` and lets the server translate + compile + run), the wasm
 * path splits responsibilities:
 *
 *   1. The browser translates numbl → C with `translateProject` (same
 *      pipeline used for the live C-output panel).
 *   2. The translated C is POSTed to a public C-to-wasm service
 *      (defaults to `https://wasm.numbl.org/compile`). The service is
 *      stateless — no `.m` understanding, no auth, just `emcc`. See
 *      `../../numbl-wasm-service/` for its implementation.
 *   3. The wasm bytes + Emscripten ES-module glue come back; the browser
 *      instantiates the module and routes stdout/stderr into the same
 *      `RunEvent` stream the native (SSE) path uses.
 *
 * Since the compile service speaks raw C, the IDE can always run in wasm
 * mode without `mtoc serve` being up. Native mode still requires the
 * local server for the C compiler + binary launcher.
 */
import {
  translateProject,
  type SourceFile,
  type TranslateError,
} from "../translate";
import { computeCacheKey, getCachedWasm, putCachedWasm } from "../db/wasmCache";
import type { RunEvent, RunResult } from "./remoteExecution";
import WasmRunnerWorker from "./wasmRunner.worker.ts?worker";
import type { WasmRunMessage } from "./wasmRunner.worker";

export type WasmOptLevel = "O0" | "O2" | "O3";

export interface WasmBuildOpts {
  enableTempInlining?: boolean;
  fastMath?: boolean;
  simd?: boolean;
  optLevel?: WasmOptLevel;
}

export interface WasmBuildArtifact {
  /** Raw wasm bytes. Passed to the Emscripten module factory as
   *  `Module.wasmBinary` so the glue never tries to fetch by URL. */
  wasm: Uint8Array;
  /** Emscripten-generated ES-module glue (a `.mjs` blob). The factory
   *  default-export is `createMtocModule`. */
  glue: string;
  meta: {
    simd: boolean;
    fastMath: boolean;
    optLevel: WasmOptLevel;
  };
}

export type BuildWasmResult =
  | { ok: true; artifact: WasmBuildArtifact }
  | { ok: false; kind: "translate"; error: TranslateError }
  | { ok: false; kind: "compile"; stderr: string }
  | { ok: false; kind: "transport"; message: string }
  | { ok: false; kind: "aborted" };

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Translate the project to C in-browser, then POST the C to the public
 * compile service. The compile service has no concept of `.m` files —
 * it's a generic C-to-wasm endpoint — so translation must happen here.
 *
 * Translation forces `threads = 1`: emcc currently has no libomp port
 * shipped with the upstream emsdk, so any `<omp.h>` include in the C
 * source breaks the build. The native path keeps the user's threads
 * choice; wasm-mode display also forces threads=1 (see IDEWorkspace).
 */
export interface BuildWasmHooks {
  /** Fires once we've determined a network compile is necessary —
   *  i.e. translation succeeded and the cache lookup missed. Used by
   *  the IDE to flip the run state into "compiling" so the user sees
   *  that the latency is the wasm-service round trip, not local work. */
  onCompileStart?: () => void;
}

export async function buildWasm(
  files: SourceFile[],
  activeName: string,
  opts: WasmBuildOpts,
  wasmServiceUrl: string,
  abortSignal?: AbortSignal,
  hooks?: BuildWasmHooks
): Promise<BuildWasmResult> {
  // Step 1: translate in-browser. Any UnsupportedConstruct / TypeError
  // raised by the lowerer surfaces here, before we touch the network.
  const translateResult = translateProject(files, activeName, {
    enableTempInlining: opts.enableTempInlining ?? false,
    threads: 1,
  });
  if (translateResult.error) {
    return { ok: false, kind: "translate", error: translateResult.error };
  }
  const cSource = translateResult.c!;

  // Step 2: cache lookup. Computed on the *translated* C so changes to
  // numbl source that compile to identical C are cache hits, and so
  // user-source-side bugs in the cache key are impossible.
  const cacheKey = await computeCacheKey(cSource, opts).catch(() => null);
  if (cacheKey) {
    const cached = await getCachedWasm(cacheKey);
    if (cached) return { ok: true, artifact: cached };
  }
  if (abortSignal?.aborted) return { ok: false, kind: "aborted" };

  // About to hit the network — tell the caller so it can show the user
  // that the wait is the compile service, not local work.
  hooks?.onCompileStart?.();

  // Step 3: POST to the compile service.
  let response: Response;
  try {
    response = await fetch(`${wasmServiceUrl}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: cSource,
        fastMath: opts.fastMath ?? false,
        simd: opts.simd ?? false,
        optLevel: opts.optLevel ?? "O3",
      }),
      signal: abortSignal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, kind: "aborted" };
    }
    return {
      ok: false,
      kind: "transport",
      message: error instanceof Error ? error.message : "Connection failed",
    };
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data && typeof data.error === "string") detail = data.error;
    } catch {
      /* ignore */
    }
    return { ok: false, kind: "transport", message: detail };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      kind: "transport",
      message: error instanceof Error ? error.message : "Invalid response",
    };
  }

  if (!body || typeof body !== "object") {
    return { ok: false, kind: "transport", message: "Invalid response" };
  }
  const r = body as Record<string, unknown>;
  if (r.ok === false) {
    if (r.phase === "compile") {
      return {
        ok: false,
        kind: "compile",
        stderr: typeof r.stderr === "string" ? r.stderr : "compile error",
      };
    }
    return { ok: false, kind: "transport", message: "Unknown build error" };
  }
  if (
    r.ok !== true ||
    typeof r.wasm !== "string" ||
    typeof r.glue !== "string"
  ) {
    return {
      ok: false,
      kind: "transport",
      message: "Malformed build response",
    };
  }
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  const artifact: WasmBuildArtifact = {
    wasm: base64ToUint8Array(r.wasm),
    glue: r.glue,
    meta: {
      simd: meta.simd === true,
      fastMath: meta.fastMath === true,
      optLevel:
        meta.optLevel === "O0" ||
        meta.optLevel === "O2" ||
        meta.optLevel === "O3"
          ? meta.optLevel
          : "O2",
    },
  };
  // Best-effort cache store. Fire-and-forget so a slow IDB write
  // doesn't delay handing the artifact off to the runner.
  if (cacheKey) {
    void putCachedWasm(cacheKey, artifact);
  }
  return { ok: true, artifact };
}

export interface RunWasmCallbacks {
  onEvent: (event: RunEvent) => void;
}

/**
 * Run the built wasm artifact in a dedicated Web Worker.
 *
 * Off-main-thread execution is what makes the Stop button actually work
 * for long-running numbl programs: a tight loop in the wasm would
 * otherwise block the main thread (including the UI's own click handler),
 * so a cooperative abort flag is useless. With a worker, the cancel path
 * is `worker.terminate()`, which kills the wasm regardless of what it's
 * doing.
 *
 * The worker emits the same `stdout` / `stderr` / `done` events the
 * original in-process runner used to emit via callback, so callers
 * (`useRemoteExecution`) wire up unchanged.
 */
export async function runWasm(
  artifact: WasmBuildArtifact,
  callbacks: RunWasmCallbacks,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  if (abortSignal?.aborted) {
    return { success: false, aborted: true };
  }

  return new Promise<RunResult>(resolve => {
    const worker = new WasmRunnerWorker();
    let settled = false;
    let aborted = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener("abort", abortHandler);
      worker.terminate();
      resolve(result);
    };

    const abortHandler = () => {
      aborted = true;
      // Emit a synthetic `done` so the console transitions cleanly —
      // the worker is being killed mid-execution and won't get to send
      // its own. Phase stays "run" because that's where we were.
      callbacks.onEvent({ type: "done", phase: "run", exitCode: 130 });
      finish({ success: false, aborted: true });
    };
    abortSignal?.addEventListener("abort", abortHandler, { once: true });

    worker.onmessage = (event: MessageEvent<WasmRunMessage>) => {
      if (aborted) return;
      const msg = event.data;
      if (msg.type === "stdout" || msg.type === "stderr") {
        callbacks.onEvent({ type: msg.type, text: msg.text });
        return;
      }
      if (msg.type === "error") {
        callbacks.onEvent({ type: "stderr", text: `${msg.message}\n` });
        callbacks.onEvent({ type: "done", phase: "run", exitCode: 1 });
        finish({ success: false, transportError: msg.message });
        return;
      }
      // "done"
      callbacks.onEvent({ type: "done", phase: "run", exitCode: msg.exitCode });
      finish({ success: msg.exitCode === 0, exitCode: msg.exitCode });
    };

    worker.onerror = event => {
      if (aborted) return;
      const message = event.message || "worker error";
      callbacks.onEvent({ type: "stderr", text: `${message}\n` });
      callbacks.onEvent({ type: "done", phase: "run", exitCode: 1 });
      finish({ success: false, transportError: message });
    };

    // Default structured-clone (no transfer): keeps `artifact.wasm`
    // usable on the main thread for any concurrent IDB cache write
    // that may still be in flight from `buildWasm`.
    worker.postMessage({
      type: "run",
      wasm: artifact.wasm,
      glue: artifact.glue,
    });
  });
}
