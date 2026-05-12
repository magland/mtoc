/**
 * mtoc local execution server.
 *
 * The browser IDE produces C source via `translateProject` but cannot
 * shell out to a compiler — this server fills that gap. The client POSTs
 * the project's numbl source files (not the C); the server runs the same
 * `translateProject` the IDE uses, writes the resulting C to a temp dir,
 * invokes the C compiler (`cc`, override via `CC` env var), executes the
 * binary, and streams stdout/stderr/exit back as Server-Sent Events.
 *
 * Sending source rather than C is deliberate: the only C that ever
 * reaches `cc` is what mtoc itself emits, so the server's effective
 * attack surface is the constrained subset of C that mtoc generates,
 * not arbitrary C the client could craft.
 *
 * Defaults to binding `127.0.0.1` so the endpoint isn't exposed on the
 * network. Pass `--host 0.0.0.0` (CLI) or `MTOC_SERVE_HOST` to widen.
 *
 * Authorization is `Bearer <passkey>` on every endpoint, including
 * `/health` — a missing passkey reveals nothing beyond "401".
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawn, execFile } from "child_process";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import { translateProject, type SourceFile } from "../src/translate.js";
import { buildCcArgs } from "../src/build.js";

const execFileAsync = promisify(execFile);

interface ServerOptions {
  port: number;
  host: string;
  passkey: string;
}

interface RunRequest {
  files: SourceFile[];
  activeName: string;
  /** When true, run the tensor-expression inlining pass during
   *  translation. See `src/codegen/inline/inlinePass.ts`. Optional,
   *  defaults to false. */
  enableTempInlining?: boolean;
  /** When true, add `-ffast-math` to the build. See
   *  `src/build.ts::BuildOptions.fastMath`. Optional, defaults to false. */
  fastMath?: boolean;
  /** Max threads for parallel elementwise loops. Positive integer or
   *  `"auto"` (let OpenMP pick). Defaults to 1 (pure serial — no
   *  `#pragma omp`, no `-fopenmp`). See
   *  [../src/build.ts::BuildOptions.threads](../src/build.ts). */
  threads?: number | "auto";
}

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

let activeExecutions = 0;

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: Record<string, unknown>
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function validateRunRequest(
  parsed: unknown
): { ok: true } | { ok: false; message: string } {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const r = parsed as Partial<RunRequest>;
  if (!Array.isArray(r.files) || r.files.length === 0) {
    return { ok: false, message: "'files' must be a non-empty array." };
  }
  for (const f of r.files) {
    if (
      !f ||
      typeof f.name !== "string" ||
      f.name.length === 0 ||
      typeof f.source !== "string"
    ) {
      return {
        ok: false,
        message: "Each file must be {name: string, source: string}.",
      };
    }
  }
  if (typeof r.activeName !== "string" || r.activeName.length === 0) {
    return { ok: false, message: "'activeName' must be a non-empty string." };
  }
  if (!r.files.some(f => f.name === r.activeName)) {
    return {
      ok: false,
      message: `'activeName' (${r.activeName}) must match one of the files.`,
    };
  }
  if (
    r.enableTempInlining !== undefined &&
    typeof r.enableTempInlining !== "boolean"
  ) {
    return {
      ok: false,
      message: "'enableTempInlining' must be a boolean if provided.",
    };
  }
  if (r.fastMath !== undefined && typeof r.fastMath !== "boolean") {
    return {
      ok: false,
      message: "'fastMath' must be a boolean if provided.",
    };
  }
  if (r.threads !== undefined) {
    const ok =
      r.threads === "auto" ||
      (typeof r.threads === "number" &&
        Number.isInteger(r.threads) &&
        r.threads >= 1);
    if (!ok) {
      return {
        ok: false,
        message:
          "'threads' must be a positive integer or the string 'auto' if provided.",
      };
    }
  }
  return { ok: true };
}

async function compile(
  cFile: string,
  exeFile: string,
  cc: string,
  buildOpts: { fastMath?: boolean; threads?: number | "auto" }
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  // Compile flags come from `src/build.ts::buildCcArgs` so a binary
  // built by this server's `/run` endpoint is bit-identical to one
  // built by `mtoc run` for the same toggles. `checkLeaks` is not
  // exposed over the wire — AddressSanitizer-wrapped binaries are a
  // local-only feature (used by the cross-runner) and would change
  // failure-output shape over SSE.
  const ccArgs = buildCcArgs(cFile, exeFile, {
    fastMath: buildOpts.fastMath,
    threads: buildOpts.threads,
  });
  try {
    await execFileAsync(cc, ccArgs, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr
        : err.stderr instanceof Buffer
          ? err.stderr.toString("utf-8")
          : err.message;
    return { ok: false, stderr };
  }
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const maxConcurrent =
    parseInt(process.env.MTOC_MAX_CONCURRENT || "") || DEFAULT_MAX_CONCURRENT;
  const timeoutMs =
    parseInt(process.env.MTOC_TIMEOUT_MS || "") || DEFAULT_TIMEOUT_MS;
  const cc = process.env.CC || "cc";

  if (activeExecutions >= maxConcurrent) {
    sendJson(res, 503, {
      error: "Server is at maximum capacity. Please try again later.",
    });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }

  let parsed: RunRequest;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const validation = validateRunRequest(parsed);
  if (!validation.ok) {
    sendJson(res, 400, { error: validation.message });
    return;
  }

  activeExecutions++;
  let tempDir: string | null = null;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "mtoc-exec-"));
    const cFile = join(tempDir, "out.c");
    const exeFile = join(tempDir, "a.out");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Translate on the server using the same pipeline the IDE uses.
    const translateResult = translateProject(parsed.files, parsed.activeName, {
      enableTempInlining: parsed.enableTempInlining ?? false,
      threads: parsed.threads ?? 1,
    });
    if (translateResult.error) {
      sendEvent({
        type: "translate_error",
        kind: translateResult.error.kind,
        message: translateResult.error.message,
        fileName: translateResult.error.fileName,
      });
      sendEvent({ type: "done", phase: "translate", exitCode: 1 });
      res.end();
      return;
    }
    await writeFile(cFile, translateResult.c!, "utf-8");

    const compileResult = await compile(cFile, exeFile, cc, {
      fastMath: parsed.fastMath ?? false,
      threads: parsed.threads ?? 1,
    });
    if (!compileResult.ok) {
      sendEvent({ type: "compile_error", text: compileResult.stderr });
      sendEvent({ type: "done", exitCode: 1, phase: "compile" });
      res.end();
      return;
    }

    await new Promise<void>(resolve => {
      let timedOut = false;
      const child = spawn(exeFile, [], { cwd: tempDir! });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1000);
      }, timeoutMs);

      const onClose = () => {
        if (!child.killed) child.kill("SIGTERM");
      };
      req.on("close", onClose);

      child.stdout?.on("data", (data: Buffer) => {
        sendEvent({ type: "stdout", text: data.toString("utf-8") });
      });
      child.stderr?.on("data", (data: Buffer) => {
        sendEvent({ type: "stderr", text: data.toString("utf-8") });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        req.off("close", onClose);
        if (timedOut) {
          sendEvent({
            type: "stderr",
            text: `\n[mtoc-server] timed out after ${timeoutMs}ms\n`,
          });
        }
        sendEvent({
          type: "done",
          phase: "run",
          exitCode: code ?? -1,
          signal: signal ?? undefined,
        });
        res.end();
        resolve();
      });

      child.on("error", error => {
        clearTimeout(timeout);
        req.off("close", onClose);
        sendEvent({
          type: "stderr",
          text: `\n[mtoc-server] failed to start binary: ${error.message}\n`,
        });
        sendEvent({ type: "done", phase: "run", exitCode: -1 });
        res.end();
        resolve();
      });
    });
  } catch (error) {
    if (!res.headersSent) {
      console.error("Execution error:", error);
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  } finally {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Failed to clean up temp directory:", cleanupError);
      }
    }
    activeExecutions--;
  }
}

export function startServer(options: ServerOptions): void {
  const { port, host, passkey } = options;
  const cc = process.env.CC || "cc";

  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${passkey}`) {
      sendJson(res, 401, { error: "Unauthorized: invalid passkey" });
      return;
    }

    const url = new URL(req.url || "/", `http://${host}:${port}`);

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", activeExecutions, cc });
      return;
    }

    if (url.pathname === "/run" && req.method === "POST") {
      await handleRun(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(port, host, () => {
    const display = host === "0.0.0.0" ? "all interfaces" : host;
    console.log(
      `mtoc execution server listening on http://${display}:${port} (CC=${cc})`
    );
  });
}
