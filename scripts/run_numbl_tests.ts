#!/usr/bin/env tsx
/**
 * Runs the curated subset of numbl test scripts (`numbl_tests.txt`)
 * through mtoc's CLI and checks each script's stdout ends with a
 * line equal to "SUCCESS".
 *
 * The numbl test corpus lives at `../numbl/numbl_test_scripts/`;
 * each script is a numbl program that asserts its way through some
 * scenario and prints `SUCCESS` once at the end. mtoc currently
 * supports only a small fraction of those tests — the curated list
 * is meant to grow as the translator does.
 *
 *   npx tsx scripts/run_numbl_tests.ts                # all listed
 *   npx tsx scripts/run_numbl_tests.ts foo.m bar.m    # listed subset
 *   MTOC_TEST_CONCURRENCY=4 npx tsx scripts/run_numbl_tests.ts
 *   MTOC_TEST_TIMEOUT_MS=60000 npx tsx scripts/run_numbl_tests.ts
 *
 * Exit code is 0 iff every script in the list produced SUCCESS.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const numblScriptsDir = resolve(repoRoot, "..", "numbl", "numbl_test_scripts");
const listPath = join(repoRoot, "numbl_tests.txt");

const TIMEOUT_MS = (() => {
  const fromEnv = process.env.MTOC_TEST_TIMEOUT_MS;
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
})();

function parseList(): string[] {
  if (!existsSync(listPath)) {
    console.error(`numbl_tests.txt not found at ${listPath}`);
    process.exit(2);
  }
  const out: string[] = [];
  for (const raw of readFileSync(listPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

interface Result {
  rel: string;
  status: "PASS" | "FAIL";
  detail: string | null;
}

async function runOne(rel: string): Promise<Result> {
  const abs = join(numblScriptsDir, rel);
  if (!existsSync(abs)) {
    return { rel, status: "FAIL", detail: `not found: ${abs}` };
  }
  let stdout: string;
  try {
    const out = await execFileAsync("npx", ["tsx", cliPath, "run", abs], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    stdout = out.stdout;
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const head = err.message.split("\n")[0];
    const tail = (err.stderr ?? "").trim();
    return {
      rel,
      status: "FAIL",
      detail: tail ? `mtoc errored: ${head}\n${tail}` : `mtoc errored: ${head}`,
    };
  }
  // The convention is that a passing numbl test prints SUCCESS as
  // the final line; intermediate disp output is fine. Ignore a
  // trailing newline from the CLI.
  const lines = stdout.split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const last = lines[lines.length - 1] ?? "";
  if (last === "SUCCESS") {
    return { rel, status: "PASS", detail: null };
  }
  const tail = lines.slice(-5).join("\n");
  return {
    rel,
    status: "FAIL",
    detail: `did not print SUCCESS as the final line. stdout tail:\n${tail}`,
  };
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onResult: (r: R) => void
): Promise<void> {
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const r = await worker(items[i]);
      onResult(r);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
  );
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
  if (!existsSync(numblScriptsDir)) {
    console.error(
      `numbl test corpus not found at ${numblScriptsDir}.\n` +
        `This runner needs numbl checked out as a sibling directory.`
    );
    process.exit(2);
  }
  const all = parseList();
  const argv = process.argv.slice(2);
  const scripts =
    argv.length > 0
      ? argv.filter(a => {
          if (all.includes(a)) return true;
          console.error(`'${a}' is not in numbl_tests.txt — skipping`);
          return false;
        })
      : all;

  const concurrency = parseConcurrency();
  let pass = 0;
  let fail = 0;
  const failedNames: string[] = [];
  await runPool(scripts, concurrency, runOne, r => {
    if (r.status === "PASS") {
      pass++;
      console.log(`PASS ${r.rel}`);
    } else {
      fail++;
      failedNames.push(r.rel);
      console.log(`FAIL ${r.rel}`);
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
