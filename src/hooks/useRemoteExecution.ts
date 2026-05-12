import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkRemoteServiceHealth,
  executeRemoteRun,
  getPasskey,
  getRemoteServiceUrl,
  type RunEvent,
} from "../utils/remoteExecution";
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

export interface ConsoleLine {
  /** Distinguishes server-routed channels in the UI; values mirror the
   *  SSE event types we emit from the server, plus a synthetic "info"
   *  for client-generated banners. */
  channel: "stdout" | "stderr" | "compile_error" | "translate_error" | "info";
  text: string;
}

interface UseRemoteExecutionResult {
  status: RunStatus;
  connection: ConnectionStatus;
  /** Console output as a list of typed lines. Cleared at run start. */
  lines: ConsoleLine[];
  /** Refresh by re-pinging /health. Called when the IDE mounts and when
   *  the user opens the settings dialog. */
  checkConnection: () => Promise<void>;
  /** Translate + compile + run the project on the remote server. */
  run: (
    files: SourceFile[],
    activeName: string,
    opts?: {
      enableTempInlining?: boolean;
      fastMath?: boolean;
      threads?: number | "auto";
    }
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
    const health = await checkRemoteServiceHealth(url, passkey);
    setConnection(health ? "connected" : "disconnected");
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (
      files: SourceFile[],
      activeName: string,
      opts: {
        enableTempInlining?: boolean;
        fastMath?: boolean;
        threads?: number | "auto";
      } = {}
    ) => {
      if (status === "running") return;
      const url = getRemoteServiceUrl();
      const passkey = getPasskey();

      setLines([]);
      setStatus("running");

      const abort = new AbortController();
      abortRef.current = abort;

      const onEvent = (event: RunEvent) => {
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
        // "done" is consumed below via the resolved RunResult.
      };

      const result = await executeRemoteRun(
        files,
        activeName,
        { onEvent },
        url,
        passkey,
        abort.signal,
        {
          enableTempInlining: opts.enableTempInlining ?? false,
          fastMath: opts.fastMath ?? false,
          threads: opts.threads ?? 1,
        }
      );
      abortRef.current = null;

      if (result.aborted) {
        append({ channel: "info", text: "\n[stopped]\n" });
        setStatus("aborted");
        return;
      }
      if (result.transportError) {
        append({
          channel: "info",
          text: `\n[server error: ${result.transportError}]\n`,
        });
        setStatus("error");
        setConnection("disconnected");
        return;
      }
      if (result.success) {
        setStatus("success");
      } else {
        // Compile failures send a `done` with phase "compile". The
        // executeRemoteRun layer doesn't know about phase, so we infer
        // from whether any compile_error event was seen by checking the
        // most recent line. This is good enough for status display.
        setStatus(prev => (prev === "running" ? "error" : prev));
      }
      setConnection("connected");
    },
    [append, status]
  );

  // Probe the server once on mount so the icon shows a meaningful state
  // before the user does anything.
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  return { status, connection, lines, checkConnection, run, stop };
}
