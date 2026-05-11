#!/usr/bin/env tsx
/**
 * Standalone runner that mirrors tests/scripts.test.ts but prints a
 * compact pass/fail report and a diff on mismatch. Useful for quick
 * iteration without spinning up vitest.
 *
 * Each script is run twice — once through dev numbl and once through
 * mtoc's own CLI — and their stdouts are compared. The runs across
 * scripts execute in parallel up to a worker-pool limit to keep the
 * full sweep fast even as the corpus grows.
 *
 *   npx tsx scripts/run_test_scripts.ts                   # all scripts
 *   npx tsx scripts/run_test_scripts.ts foo.m bar.m       # specific files
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_test_scripts.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_test_scripts.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cpus } from "node:os";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const numblCliPath = resolve(repoRoot, "..", "numbl", "src", "cli.ts");
const scriptsDir = join(repoRoot, "test_scripts");

function discoverScripts(): string[] {
  const multifileRoot = join(scriptsDir, "multifile");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && entry.endsWith(".m")) {
        // Multi-file test layout: `test_scripts/multifile/<case>/main.m`
        // is the entry, sibling `.m` files in the same case dir are
        // helpers that the entry calls into. The helpers must not be
        // executed as entries themselves — both numbl and mtoc
        // auto-scan the entry's parent dir to pick them up.
        if (p.startsWith(multifileRoot + "/") && entry !== "main.m") continue;
        found.push(p);
      }
    }
  };
  walk(scriptsDir);
  return found.sort();
}

const TIMEOUT_MS = (() => {
  const fromEnv = process.env.MTOC_TEST_TIMEOUT_MS;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
})();

const MAX_DIFF_LINES = 30;

async function captureStdout(cmd: string, args: string[]): Promise<string> {
  // We pipe stderr to /dev/null inside execFile by default; capture
  // stdout. `maxBuffer` is bumped so chatty test scripts don't trip it.
  // `timeout` aborts a single-script hang so one bad script can't stall
  // the whole sweep.
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
}

/** Like captureStdout, but returns stderr too — used for the mtoc run
 *  so we can surface AddressSanitizer / LeakSanitizer reports in the
 *  failure detail when --check-leaks fires. */
async function captureBoth(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return { stdout, stderr };
}

function diff(expected: string, actual: string): string {
  const al = expected.split("\n");
  const bl = actual.split("\n");
  const max = Math.max(al.length, bl.length);
  const lines: string[] = [];
  let totalMismatch = 0;
  for (let i = 0; i < max; i++) {
    const av = al[i] ?? "";
    const bv = bl[i] ?? "";
    if (av === bv) continue;
    totalMismatch++;
    if (lines.length < MAX_DIFF_LINES) {
      lines.push(
        `  line ${i + 1}: numbl=${JSON.stringify(av)} mtoc=${JSON.stringify(bv)}`
      );
    }
  }
  if (totalMismatch > MAX_DIFF_LINES) {
    lines.push(
      `  … (${totalMismatch - MAX_DIFF_LINES} more differing line${totalMismatch - MAX_DIFF_LINES === 1 ? "" : "s"} suppressed; ${totalMismatch} total)`
    );
  }
  return lines.join("\n");
}

interface Result {
  name: string;
  status: "PASS" | "FAIL";
  detail: string | null;
}

async function runOne(scriptPath: string): Promise<Result> {
  const name = scriptPath.startsWith(repoRoot)
    ? scriptPath.slice(repoRoot.length + 1)
    : scriptPath;

  let expected: string;
  try {
    expected = await captureStdout("npx", [
      "tsx",
      numblCliPath,
      "run",
      scriptPath,
    ]);
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    return { name, status: "FAIL", detail: `numbl errored: ${msg}` };
  }

  let actual: string;
  let mtocStderr: string;
  try {
    const out = await captureBoth("npx", [
      "tsx",
      cliPath,
      "run",
      "--check-leaks",
      scriptPath,
    ]);
    actual = out.stdout;
    mtocStderr = out.stderr;
  } catch (e) {
    // execFile throws on non-zero exit, including ASan/LSan leak
    // reports. Surface stderr so the leak trace is visible in the
    // failure detail rather than silently dropped.
    const err = e as Error & { stderr?: string; stdout?: string };
    const tail = (err.stderr ?? "").trim();
    const head = err.message.split("\n")[0];
    const detail = tail
      ? `mtoc errored: ${head}\n${tail}`
      : `mtoc errored: ${head}`;
    return { name, status: "FAIL", detail };
  }

  if (actual === expected) {
    if (mtocStderr.includes("LeakSanitizer:")) {
      return {
        name,
        status: "FAIL",
        detail: `LeakSanitizer reported leaks:\n${mtocStderr.trim()}`,
      };
    }
    return { name, status: "PASS", detail: null };
  }
  return { name, status: "FAIL", detail: diff(expected, actual) };
}

/** Run `worker` over `items` with at most `limit` concurrent tasks. */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onResult: (item: T, result: R, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const r = await worker(items[i]);
      results[i] = r;
      onResult(items[i], r, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    runWorker()
  );
  await Promise.all(workers);
  return results;
}

function parseConcurrency(): number {
  const fromEnv = process.env.MTOC_TEST_CONCURRENCY;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(1, cpus().length);
}

async function main(): Promise<void> {
  if (!existsSync(numblCliPath)) {
    console.error(
      `Cross-runner needs numbl checked out as a sibling directory:\n` +
        `  expected: ${numblCliPath}\n` +
        `Either clone numbl beside this repo, or run\n` +
        `  npx tsx scripts/sync_from_numbl.ts --apply\n` +
        `to refresh vendored sources from a known location.`
    );
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const scripts =
    argv.length > 0 ? argv.map(a => resolve(a)) : discoverScripts();

  const concurrency = parseConcurrency();

  let pass = 0;
  let fail = 0;
  const failedNames: string[] = [];

  await runPool(scripts, concurrency, runOne, (_, r) => {
    if (r.status === "PASS") {
      pass++;
      console.log(`PASS ${r.name}`);
    } else {
      fail++;
      failedNames.push(r.name);
      console.log(`FAIL ${r.name}`);
      if (r.detail) console.log(r.detail);
    }
  });

  console.log(
    `\n${pass} passed, ${fail} failed (${scripts.length} total, concurrency=${concurrency})`
  );
  if (failedNames.length > 0) {
    console.log(`failed: ${failedNames.join(" ")}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
