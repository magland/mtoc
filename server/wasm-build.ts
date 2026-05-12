/**
 * WASM build pipeline for the execution server.
 *
 * The `/build-wasm` endpoint translates the project's numbl source to C
 * with `translateProject`, then shells out to `emcc` to compile that C to
 * a `.mjs` glue + sibling `.wasm`, and returns both to the browser as a
 * single JSON response. The browser then runs the wasm itself (see
 * `src/utils/wasmExecution.ts`).
 *
 * Distinct from `/run` in two ways:
 *
 *   1. Execution happens client-side, so this endpoint only does build
 *      work — no SSE, no streaming, no process supervision. A single
 *      `application/json` reply on success or failure.
 *   2. We cache builds on disk keyed by SHA-256 of `(cSource, options)`.
 *      Cold emcc builds take a few seconds; warm cache hits are <50 ms.
 *
 * Threads/OpenMP are not yet supported: the bundled emsdk does not ship
 * `omp.h`. We force `threads=1` at translation time when targeting WASM
 * so no `<omp.h>` include is emitted. See `docs/web.md`.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { IncomingMessage, ServerResponse } from "http";
import { translateProject, type SourceFile } from "../src/translate.js";
import {
  buildEmccArgs,
  type WasmBuildOptions,
  type WasmOptLevel,
} from "../src/build.js";

const execFileAsync = promisify(execFile);

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB
const DEFAULT_BUILD_TIMEOUT_MS = 60_000; // emcc is slow

const CACHE_DIR = join(tmpdir(), "mtoc-wasm-cache");

interface BuildWasmRequest {
  files: SourceFile[];
  activeName: string;
  enableTempInlining?: boolean;
  fastMath?: boolean;
  optLevel?: WasmOptLevel;
  simd?: boolean;
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

function validateRequest(
  parsed: unknown
): { ok: true } | { ok: false; message: string } {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const r = parsed as Partial<BuildWasmRequest>;
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
    return { ok: false, message: "'fastMath' must be a boolean if provided." };
  }
  if (r.simd !== undefined && typeof r.simd !== "boolean") {
    return { ok: false, message: "'simd' must be a boolean if provided." };
  }
  if (r.optLevel !== undefined && !isWasmOptLevel(r.optLevel)) {
    return {
      ok: false,
      message: "'optLevel' must be one of 'O0', 'O2', 'O3' if provided.",
    };
  }
  return { ok: true };
}

function isWasmOptLevel(v: unknown): v is WasmOptLevel {
  return v === "O0" || v === "O2" || v === "O3";
}

function hashBuildKey(cSource: string, opts: WasmBuildOptions): string {
  const h = createHash("sha256");
  h.update(cSource);
  // Canonical key ordering so options-object key order doesn't affect cache hits.
  h.update(
    JSON.stringify({
      fastMath: opts.fastMath ?? false,
      simd: opts.simd ?? false,
      optLevel: opts.optLevel ?? "O2",
    })
  );
  return h.digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the emcc binary path. Priority: explicit `MTOC_EMCC` env override,
 *  then bare `emcc` from PATH. The server doesn't try to source `emsdk_env.sh`
 *  itself — the operator either activates emsdk in their shell or points
 *  `MTOC_EMCC` at the absolute path. */
export function resolveEmcc(): string {
  return process.env.MTOC_EMCC || "emcc";
}

/** Probe emcc by running `<emcc> --version`. Returns the first line of
 *  output on success, or `null` if emcc isn't available. Used by `/health`
 *  so the browser can grey out the WASM toggle when the server can't compile. */
export async function probeEmcc(): Promise<string | null> {
  const emcc = resolveEmcc();
  try {
    const { stdout } = await execFileAsync(emcc, ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const firstLine = stdout.split("\n")[0]?.trim() ?? "";
    return firstLine.length > 0 ? firstLine : "emcc";
  } catch {
    return null;
  }
}

interface BuildArtifact {
  wasm: Buffer;
  glue: string;
}

async function compileWithCache(
  cSource: string,
  opts: WasmBuildOptions,
  timeoutMs: number
): Promise<
  { ok: true; artifact: BuildArtifact } | { ok: false; stderr: string }
> {
  const emcc = resolveEmcc();
  const key = hashBuildKey(cSource, opts);
  const wasmPath = join(CACHE_DIR, `${key}.wasm`);
  const gluePath = join(CACHE_DIR, `${key}.mjs`);

  // Cache hit: both files present.
  if (await fileExists(wasmPath)) {
    if (await fileExists(gluePath)) {
      const [wasm, glue] = await Promise.all([
        readFile(wasmPath),
        readFile(gluePath, "utf-8"),
      ]);
      return { ok: true, artifact: { wasm, glue } };
    }
  }

  // Cache miss: compile in a fresh temp dir, then commit to the cache.
  const tempDir = await mkdtemp(join(tmpdir(), "mtoc-wasm-"));
  try {
    const cFile = join(tempDir, "in.c");
    const outBase = join(tempDir, "out");
    await writeFile(cFile, cSource, "utf-8");

    const args = buildEmccArgs(cFile, outBase, opts);
    try {
      await execFileAsync(emcc, args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
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

    const [wasm, glue] = await Promise.all([
      readFile(`${outBase}.wasm`),
      readFile(`${outBase}.mjs`, "utf-8"),
    ]);

    // Commit to cache. Use writeFile (atomic on most filesystems for small files);
    // concurrent builds for the same key just race to write the same bytes.
    await mkdir(CACHE_DIR, { recursive: true });
    await Promise.all([
      writeFile(wasmPath, wasm),
      writeFile(gluePath, glue, "utf-8"),
    ]);

    return { ok: true, artifact: { wasm, glue } };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface BuildWasmHandlerOptions {
  /** Bumps the active-execution counter alongside `/run`. */
  acquire: () => boolean;
  release: () => void;
}

export async function handleBuildWasm(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BuildWasmHandlerOptions
): Promise<void> {
  const timeoutMs =
    parseInt(process.env.MTOC_BUILD_TIMEOUT_MS || "") ||
    DEFAULT_BUILD_TIMEOUT_MS;

  if (!opts.acquire()) {
    sendJson(res, 503, {
      error: "Server is at maximum capacity. Please try again later.",
    });
    return;
  }

  try {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Failed to read request body" });
      return;
    }

    let parsed: BuildWasmRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    const validation = validateRequest(parsed);
    if (!validation.ok) {
      sendJson(res, 400, { error: validation.message });
      return;
    }

    // Translate. Forced threads=1 because emcc doesn't ship libomp;
    // any `<omp.h>` include in the C source breaks the build.
    const translateResult = translateProject(parsed.files, parsed.activeName, {
      enableTempInlining: parsed.enableTempInlining ?? false,
      threads: 1,
    });
    if (translateResult.error) {
      sendJson(res, 200, {
        ok: false,
        phase: "translate",
        error: {
          kind: translateResult.error.kind,
          message: translateResult.error.message,
          fileName: translateResult.error.fileName,
        },
      });
      return;
    }

    const buildOpts: WasmBuildOptions = {
      fastMath: parsed.fastMath ?? false,
      simd: parsed.simd ?? false,
      optLevel: parsed.optLevel ?? "O2",
    };

    const result = await compileWithCache(
      translateResult.c!,
      buildOpts,
      timeoutMs
    );
    if (!result.ok) {
      sendJson(res, 200, {
        ok: false,
        phase: "compile",
        stderr: result.stderr,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      wasm: result.artifact.wasm.toString("base64"),
      glue: result.artifact.glue,
      meta: {
        simd: buildOpts.simd ?? false,
        fastMath: buildOpts.fastMath ?? false,
        optLevel: buildOpts.optLevel ?? "O2",
      },
    });
  } catch (error) {
    if (!res.headersSent) {
      console.error("Build error:", error);
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  } finally {
    opts.release();
  }
}
