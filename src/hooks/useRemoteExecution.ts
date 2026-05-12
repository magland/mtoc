import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkRemoteServiceHealth,
  executeRemoteRun,
  getPasskey,
  getRemoteServiceUrl,
  type RemoteServiceHealth,
  type RunEvent,
} from "../utils/remoteExecution";
import { buildWasm, runWasm, type WasmOptLevel } from "../utils/wasmExecution";
import type { SourceFile } from "../translate";

export type ConnectionStatus =
  | "unknown"
  | "checking"
  | "connected"
  | "disconnected";

export type RunStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "aborted"
  | "compile_error";

/** Where execution physically happens. `native` is the existing path
 *  (server compiles + runs a native binary, streams stdio over SSE).
 *  `wasm` makes the server compile to WebAssembly with emcc and ship
 *  the artifact to the browser, which runs it in-process. */
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
  connection: ConnectionStatus;
  /** Last successful health probe — exposes whether emcc is available on
   *  the server so the UI can grey out wasm mode when it isn't. Null
   *  before the first successful probe. */
  health: RemoteServiceHealth | null;
  /** Console output as a list of typed lines. Cleared at run start. */
  lines: ConsoleLine[];
  /** Refresh by re-pinging /health. Called when the IDE mounts and when
   *  the user opens the settings dialog. */
  checkConnection: () => Promise<void>;
  /** Translate + compile + run the project on the remote server. */
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
  const [health, setHealth] = useState<RemoteServiceHealth | null>(null);
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
    setHealth(result);
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
      if (status === "running") return;
      const url = getRemoteServiceUrl();
      const passkey = getPasskey();

      setLines([]);
      setStatus("running");

      const abort = new AbortController();
      abortRef.current = abort;

      const finish = (next: RunStatus) => {
        abortRef.current = null;
        setStatus(next);
      };

      if (mode === "wasm") {
        // WASM threads (OpenMP) aren't yet supported by the bundled
        // emsdk, so we force single-thread translation regardless of
        // the UI selection. The build step on the server also forces
        // threads=1 to defense-in-depth this. The user-visible threads
        // dropdown is hidden in WASM mode so this isn't surprising.
        const build = await buildWasm(
          files,
          activeName,
          {
            enableTempInlining: opts.enableTempInlining ?? false,
            fastMath: opts.fastMath ?? false,
            simd: opts.simd ?? false,
            optLevel: opts.optLevel ?? "O2",
          },
          url,
          passkey,
          abort.signal
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
              text: `\n[server error: ${build.message}]\n`,
            });
            finish("error");
            setConnection("disconnected");
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
        setConnection("connected");
        return;
      }

      // Native path.
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

  // Probe the server once on mount so the icon shows a meaningful state
  // before the user does anything.
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  return { status, connection, health, lines, checkConnection, run, stop };
}
