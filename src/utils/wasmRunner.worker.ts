/**
 * Web Worker that owns the WASM execution loop.
 *
 * The main thread builds the wasm artifact (translate locally + POST C to
 * the compile service) and hands it over here for instantiation and run.
 * Running off the main thread is what makes the Stop button instantaneous
 * for long-running numbl programs: the user-visible cancel path is
 * `worker.terminate()`, which kills the in-flight wasm regardless of
 * whatever loop it's spinning on.
 *
 * The worker speaks the same `RunEvent`-shaped messages the main-thread
 * runner used to deliver via callback, so `wasmExecution.runWasm` can
 * forward them straight to the existing console code.
 */
/// <reference lib="webworker" />

export interface WasmRunRequest {
  type: "run";
  wasm: Uint8Array;
  glue: string;
}

export type WasmRunMessage =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };

interface EmModuleOverrides {
  wasmBinary: Uint8Array;
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

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WasmRunMessage): void {
  ctx.postMessage(msg);
}

async function loadGlue(glueSource: string): Promise<GlueModule> {
  const blob = new Blob([glueSource], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ url)) as GlueModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runOnce(req: WasmRunRequest): Promise<void> {
  let factory: EmModuleFactory;
  try {
    const mod = await loadGlue(req.glue);
    factory = mod.default;
    if (typeof factory !== "function") {
      post({ type: "error", message: "WASM glue is missing default export" });
      return;
    }
  } catch (error) {
    post({
      type: "error",
      message:
        error instanceof Error
          ? `Failed to load WASM glue: ${error.message}`
          : "Failed to load WASM glue",
    });
    return;
  }

  let exitCode: number | undefined;
  try {
    await factory({
      wasmBinary: req.wasm,
      locateFile: path => path,
      print: text => post({ type: "stdout", text: `${text}\n` }),
      printErr: text => post({ type: "stderr", text: `${text}\n` }),
      noExitRuntime: false,
      onExit: code => {
        exitCode = code;
      },
      onAbort: reason => {
        post({
          type: "stderr",
          text: `[mtoc-wasm] abort: ${String(reason)}\n`,
        });
      },
    });
  } catch (error) {
    // Emscripten's `exit(N)` throws an `ExitStatus` which propagates here.
    // The `onExit` handler already captured the code, so on a genuine
    // non-zero exit we fall through to the normal `done` path.
    if (exitCode === undefined) {
      const message = error instanceof Error ? error.message : String(error);
      post({ type: "stderr", text: `${message}\n` });
      post({ type: "done", exitCode: 1 });
      return;
    }
  }

  post({ type: "done", exitCode: exitCode ?? 0 });
}

ctx.addEventListener("message", (event: MessageEvent<WasmRunRequest>) => {
  const data = event.data;
  if (data && data.type === "run") {
    void runOnce(data);
  }
});
