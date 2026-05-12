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
import type { RunEvent, RunResult } from "./remoteExecution";

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
export async function buildWasm(
  files: SourceFile[],
  activeName: string,
  opts: WasmBuildOpts,
  wasmServiceUrl: string,
  abortSignal?: AbortSignal
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

  // Step 2: POST to the compile service.
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
  return {
    ok: true,
    artifact: {
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
    },
  };
}

/** Minimal type for the Emscripten module factory we expect from the
 *  glue. We only call the parts we control; emscripten's public surface
 *  is much larger but unstable across versions. */
interface EmModuleOverrides {
  wasmBinary: Uint8Array;
  /** Short-circuits the Emscripten glue's default URL-resolution path
   *  for the sibling `.wasm`. We need this because the glue runs
   *  `new URL("out.wasm", import.meta.url)` even when `wasmBinary` is
   *  provided, and `import.meta.url` is a `blob:` URL (which browsers
   *  reject as a base for relative URL resolution). Returning the path
   *  unchanged is fine — the actual binary fetch is short-circuited by
   *  `wasmBinary`, so the returned string is only used as the cache key
   *  in `getBinarySync(file == wasmBinaryFile)`. */
  locateFile: (path: string) => string;
  print: (text: string) => void;
  printErr: (text: string) => void;
  noExitRuntime?: boolean;
  onExit?: (code: number) => void;
  onAbort?: (reason: unknown) => void;
}

type EmModuleFactory = (overrides: EmModuleOverrides) => Promise<unknown>;

interface GlueModule {
  default: EmModuleFactory;
}

/** Load the Emscripten glue via Blob-URL dynamic import.
 *
 *  Why Blob and not a `data:` URL: dynamic `import("data:text/javascript;...")`
 *  is blocked by some browsers' CSPs and has no clear base URL for
 *  `import.meta.url` to anchor against. A Blob URL behaves like any other
 *  same-origin script.
 *
 *  We pass `wasmBinary` directly so the glue never tries to fetch the
 *  sibling `.wasm` by URL — that fetch would fail for a Blob-URL host. */
async function loadGlue(glueSource: string): Promise<GlueModule> {
  const blob = new Blob([glueSource], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    // The /* @vite-ignore */ comment keeps Vite from trying to statically
    // analyze the dynamic import target (which would fail since the URL
    // is a runtime blob).
    return (await import(/* @vite-ignore */ url)) as GlueModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface RunWasmCallbacks {
  onEvent: (event: RunEvent) => void;
}

export async function runWasm(
  artifact: WasmBuildArtifact,
  callbacks: RunWasmCallbacks,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  if (abortSignal?.aborted) {
    return { success: false, aborted: true };
  }

  let factory: EmModuleFactory;
  try {
    const mod = await loadGlue(artifact.glue);
    factory = mod.default;
    if (typeof factory !== "function") {
      return {
        success: false,
        transportError: "WASM glue is missing default export",
      };
    }
  } catch (error) {
    return {
      success: false,
      transportError:
        error instanceof Error
          ? `Failed to load WASM glue: ${error.message}`
          : "Failed to load WASM glue",
    };
  }

  let exitCode: number | undefined;
  let aborted = false;
  const abortHandler = () => {
    aborted = true;
  };
  abortSignal?.addEventListener("abort", abortHandler, { once: true });

  try {
    // Emscripten's `print`/`printErr` are line-buffered (fire once per
    // newline); mtoc's `disp` always ends in `\n` so this matches the
    // SSE path's chunk shape closely. We append a trailing newline to
    // restore the byte the buffer stripped, so cross-runner byte-for-byte
    // parity with native stdout still holds.
    await factory({
      wasmBinary: artifact.wasm,
      locateFile: path => path,
      print: text => {
        callbacks.onEvent({ type: "stdout", text: `${text}\n` });
      },
      printErr: text => {
        callbacks.onEvent({ type: "stderr", text: `${text}\n` });
      },
      noExitRuntime: false,
      onExit: code => {
        exitCode = code;
      },
      onAbort: reason => {
        callbacks.onEvent({
          type: "stderr",
          text: `[mtoc-wasm] abort: ${String(reason)}\n`,
        });
      },
    });
  } catch (error) {
    // Emscripten's `exit(N)` throws an `ExitStatus` which propagates up
    // here. The `onExit` handler already captured the code, so on a
    // genuine non-zero exit we want to fall through to the normal `done`
    // path rather than report it as a transport error.
    if (exitCode === undefined) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onEvent({ type: "stderr", text: `${message}\n` });
      callbacks.onEvent({ type: "done", phase: "run", exitCode: 1 });
      abortSignal?.removeEventListener("abort", abortHandler);
      return aborted
        ? { success: false, aborted: true }
        : { success: false, exitCode: 1 };
    }
  }
  abortSignal?.removeEventListener("abort", abortHandler);

  const finalCode = exitCode ?? 0;
  callbacks.onEvent({ type: "done", phase: "run", exitCode: finalCode });
  if (aborted) return { success: false, aborted: true };
  return { success: finalCode === 0, exitCode: finalCode };
}
