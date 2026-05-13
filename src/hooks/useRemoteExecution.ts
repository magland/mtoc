import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkRemoteServiceHealth,
  executeRemoteRun,
  getPasskey,
  getRemoteServiceUrl,
  getWasmServiceUrl,
  type RunEvent,
} from "../utils/remoteExecution";
import { buildWasm, runWasm, type WasmOptLevel } from "../utils/wasmExecution";
import { evictExpiredWasm } from "../db/wasmCache";
import type { SourceFile } from "../translate";

export type ConnectionStatus =
  | "unknown"
  | "checking"
  | "connected"
  | "disconnected";

export type RunStatus =
  | "idle"
  /** Wasm-mode only: the translated C is in flight to the public
   *  compile service and we're waiting on the wasm bytes back.
   *  Separate from "running" so the UI can tell the user that the
   *  current latency is the network round trip, not anything the
   *  program itself is doing. */
  | "compiling"
  | "running"
  | "success"
  | "error"
  | "aborted"
  | "compile_error";

/** Where execution physically happens.
 *
 *  - `native`: the local `mtoc serve` translates + compiles with `cc` and
 *    runs the binary, streaming stdio over SSE. Requires the local server
 *    to be reachable.
 *  - `wasm`: the browser translates locally, POSTs the resulting C to a
 *    public C-to-wasm compile service (default `https://wasm.numbl.org`),
 *    and instantiates the returned module in-process. Always available
 *    as long as the compile service is reachable. */
export type ExecutionMode = "native" | "wasm";

export interface ConsoleLine {
  /** Distinguishes server-routed channels in the UI; values mirror the
   *  SSE event types we emit from the server, plus a synthetic "info"
   *  for client-generated banners. */
  channel: "stdout" | "stderr" | "compile_error" | "translate_error" | "info";
  text: string;
}

export interface RunOptions {
  enableTempInlining?: boolean;
  fastMath?: boolean;
  threads?: number | "auto";
  /** WASM-mode-only knobs. Ignored in native mode. */
  simd?: boolean;
  optLevel?: WasmOptLevel;
}

interface UseRemoteExecutionResult {
  status: RunStatus;
  /** Status of the local `mtoc serve` server. Only relevant to native
   *  mode — wasm mode talks to a separate public service. */
  connection: ConnectionStatus;
  /** Console output as a list of typed lines. Cleared at run start. */
  lines: ConsoleLine[];
  /** Refresh by re-pinging the local server's /health. Called when the
   *  IDE mounts and when the user opens the settings dialog. */
  checkConnection: () => Promise<void>;
  /** Translate + compile + run the project, routing through the
   *  selected mode's pipeline. */
  run: (
    files: SourceFile[],
    activeName: string,
    mode: ExecutionMode,
    opts?: RunOptions
  ) => Promise<void>;
  /** Abort the currently-running execution. */
  stop: () => void;
}

export function useRemoteExecution(): UseRemoteExecutionResult {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [connection, setConnection] = useState<ConnectionStatus>("unknown");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const append = useCallback((line: ConsoleLine) => {
    setLines(prev => [...prev, line]);
  }, []);

  const checkConnection = useCallback(async () => {
    setConnection("checking");
    const url = getRemoteServiceUrl();
    const passkey = getPasskey();
    const result = await checkRemoteServiceHealth(url, passkey);
    setConnection(result ? "connected" : "disconnected");
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (event.type === "stdout" || event.type === "stderr") {
        append({ channel: event.type, text: event.text });
      } else if (event.type === "compile_error") {
        append({ channel: "compile_error", text: event.text });
      } else if (event.type === "translate_error") {
        const where = event.fileName ? ` (${event.fileName})` : "";
        append({
          channel: "translate_error",
          text: `${event.kind}${where}: ${event.message}\n`,
        });
      }
      // "done" is consumed by the caller via the resolved RunResult.
    },
    [append]
  );

  const run = useCallback(
    async (
      files: SourceFile[],
      activeName: string,
      mode: ExecutionMode,
      opts: RunOptions = {}
    ) => {
      if (status === "running" || status === "compiling") return;

      setLines([]);
      setStatus("running");

      const abort = new AbortController();
      abortRef.current = abort;

      const finish = (next: RunStatus) => {
        abortRef.current = null;
        setStatus(next);
      };

      if (mode === "wasm") {
        const wasmUrl = getWasmServiceUrl();
        const build = await buildWasm(
          files,
          activeName,
          {
            enableTempInlining: opts.enableTempInlining ?? false,
            fastMath: opts.fastMath ?? false,
            simd: opts.simd ?? false,
            optLevel: opts.optLevel ?? "O3",
          },
          wasmUrl,
          abort.signal,
          {
            // Flip to "compiling" only when the build actually goes to
            // the network. On a cache hit this never fires and we stay
            // on "running" — the worker will be spawned almost
            // instantly so the user never sees the intermediate state.
            onCompileStart: () => {
              setStatus("compiling");
              append({ channel: "info", text: "[compiling WASM…]\n" });
            },
          }
        );
        if (!build.ok) {
          if (build.kind === "aborted") {
            append({ channel: "info", text: "\n[stopped]\n" });
            finish("aborted");
            return;
          }
          if (build.kind === "transport") {
            append({
              channel: "info",
              text: `\n[wasm service error: ${build.message}]\n`,
            });
            finish("error");
            return;
          }
          if (build.kind === "translate") {
            const where = build.error.fileName
              ? ` (${build.error.fileName})`
              : "";
            append({
              channel: "translate_error",
              text: `${build.error.kind}${where}: ${build.error.message}\n`,
            });
            finish("error");
            return;
          }
          // compile error
          append({ channel: "compile_error", text: build.stderr });
          finish("compile_error");
          return;
        }

        // Compile leg done (or skipped on cache hit). Back to the
        // "running" pill while the worker drives the wasm — important
        // for the cache-miss path where status is currently "compiling".
        setStatus("running");
        const result = await runWasm(
          build.artifact,
          { onEvent: handleEvent },
          abort.signal
        );
        if (result.aborted) {
          append({ channel: "info", text: "\n[stopped]\n" });
          finish("aborted");
          return;
        }
        if (result.transportError) {
          append({
            channel: "info",
            text: `\n[wasm error: ${result.transportError}]\n`,
          });
          finish("error");
          return;
        }
        finish(result.success ? "success" : "error");
        return;
      }

      // Native path.
      const url = getRemoteServiceUrl();
      const passkey = getPasskey();
      const result = await executeRemoteRun(
        files,
        activeName,
        { onEvent: handleEvent },
        url,
        passkey,
        abort.signal,
        {
          enableTempInlining: opts.enableTempInlining ?? false,
          fastMath: opts.fastMath ?? false,
          threads: opts.threads ?? 1,
        }
      );

      if (result.aborted) {
        append({ channel: "info", text: "\n[stopped]\n" });
        finish("aborted");
        return;
      }
      if (result.transportError) {
        append({
          channel: "info",
          text: `\n[server error: ${result.transportError}]\n`,
        });
        finish("error");
        setConnection("disconnected");
        return;
      }
      if (result.success) {
        finish("success");
      } else {
        // Compile failures send a `done` with phase "compile". The
        // executeRemoteRun layer doesn't know about phase, so we infer
        // from whether any compile_error event was seen by checking the
        // most recent line. This is good enough for status display.
        finish("error");
      }
      setConnection("connected");
    },
    [append, handleEvent, status]
  );

  // Probe the local server once on mount so the icon shows a meaningful
  // state before the user does anything. Wasm mode doesn't need this
  // (it talks to a separate public service that's effectively always up).
  // Same mount also kicks off one wasm-cache sweep so expired entries
  // from previous sessions don't sit forever — get/put are fast either
  // way, but a multi-MB stale cache is wasteful and slightly slower to
  // open the DB.
  useEffect(() => {
    checkConnection();
    void evictExpiredWasm();
  }, [checkConnection]);

  return { status, connection, lines, checkConnection, run, stop };
}
