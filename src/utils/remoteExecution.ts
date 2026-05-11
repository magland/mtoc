/**
 * Client for the mtoc local execution server (`mtoc serve`).
 *
 * The browser IDE cannot shell out to a compiler. This module wraps the
 * server's HTTP+SSE protocol: persists URL/passkey/enabled flag, exposes
 * a health check, and streams stdout/stderr from `POST /run` back to
 * the caller.
 *
 * The IDE sends numbl source files (not the translated C); the server
 * runs the same `translateProject` we do. That keeps `cc` from ever
 * seeing arbitrary client-supplied C — only the constrained subset that
 * mtoc itself emits.
 */
import type { SourceFile } from "../translate";

const URL_KEY = "mtoc_remote_service_url";
const ENABLED_KEY = "mtoc_remote_execution_enabled";
const PASSKEY_KEY = "mtoc_passkey";

export const DEFAULT_REMOTE_SERVICE_URL = "http://localhost:3002";

export function getRemoteServiceUrl(): string {
  return localStorage.getItem(URL_KEY) || DEFAULT_REMOTE_SERVICE_URL;
}

export function setRemoteServiceUrl(url: string): void {
  localStorage.setItem(URL_KEY, url);
}

export function isRemoteExecutionEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === "true";
}

export function setRemoteExecutionEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled));
}

/** The passkey persists in localStorage so the user doesn't have to
 *  re-paste the `mtoc serve` command after closing the browser; it sticks
 *  around until the browser's site data is cleared or until the user
 *  explicitly regenerates it via the settings dialog. */
export function getPasskey(): string {
  let key = localStorage.getItem(PASSKEY_KEY);
  if (!key) {
    key = generatePasskey();
    localStorage.setItem(PASSKEY_KEY, key);
  }
  return key;
}

export function regeneratePasskey(): string {
  const key = generatePasskey();
  localStorage.setItem(PASSKEY_KEY, key);
  return key;
}

function generatePasskey(): string {
  // 16 hex chars = 64 bits of entropy. Plenty for a localhost auth
  // token; short enough to be paste-friendly.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export interface RemoteServiceHealth {
  status: string;
  activeExecutions: number;
  cc: string;
}

export async function checkRemoteServiceHealth(
  serviceUrl: string,
  passkey: string
): Promise<RemoteServiceHealth | null> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${passkey}` },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export type RunEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "compile_error"; text: string }
  | {
      type: "translate_error";
      kind: string;
      message: string;
      fileName?: string;
    }
  | {
      type: "done";
      phase: "translate" | "compile" | "run";
      exitCode: number;
      signal?: string;
    };

export interface RunResult {
  /** True iff we received a `done` event with exitCode === 0. False on
   *  compile failure, non-zero exit, abort, or any transport error. */
  success: boolean;
  exitCode?: number;
  /** Set when the run was cancelled via AbortController. */
  aborted?: boolean;
  /** Set when the request never made it to the SSE stream (network
   *  failure, 401, 404, etc.). */
  transportError?: string;
}

/**
 * POST /run with the project's source files + the active file name and
 * stream the SSE response. Each parsed event is delivered via `onEvent`;
 * the returned promise resolves with the final result once the stream
 * closes (or aborts).
 */
export async function executeRemoteRun(
  files: SourceFile[],
  activeName: string,
  callbacks: { onEvent: (event: RunEvent) => void },
  serviceUrl: string,
  passkey: string,
  abortSignal?: AbortSignal
): Promise<RunResult> {
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${passkey}`,
      },
      body: JSON.stringify({ files, activeName }),
      signal: abortSignal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { success: false, aborted: true };
    }
    return {
      success: false,
      transportError:
        error instanceof Error ? error.message : "Connection failed",
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
    return { success: false, transportError: detail };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { success: false, transportError: "No response body" };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let success = false;
  let exitCode: number | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const line = event.trim();
        if (!line.startsWith("data: ")) continue;
        let msg: RunEvent;
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        callbacks.onEvent(msg);
        if (msg.type === "done") {
          exitCode = msg.exitCode;
          success = msg.exitCode === 0;
        }
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { success: false, aborted: true };
    }
    return {
      success: false,
      transportError:
        error instanceof Error ? error.message : "Stream read failed",
    };
  }

  return { success, exitCode };
}
