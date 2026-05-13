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
 *
 * Probe mode (`--probe`) ignores `numbl_tests.txt`, walks the full
 * corpus, and groups outcomes by category — separating tests mtoc
 * intentionally rejects (`UnsupportedConstruct`) from tests that
 * translated to C but then broke at compile / run time (the
 * actionable bucket).
 *
 *   npx tsx scripts/run_numbl_tests.ts --probe              # all
 *   npx tsx scripts/run_numbl_tests.ts --probe arrays/      # subtree
 *
 * Probe mode always exits 0 — the breakdown is the result.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

type Category =
  | "PASS"
  | "UNSUPPORTED"
  | "TYPE_ERROR"
  | "SYNTAX_ERROR"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "NO_SUCCESS"
  | "TIMEOUT"
  | "NOT_FOUND"
  | "OTHER";

interface Result {
  rel: string;
  category: Category;
  detail: string | null;
}

/** Categories where mtoc produced C that compiled and ran, but the
 *  program's behavior diverged from numbl — i.e., the actionable
 *  bucket worth investigating. */
const INTERESTING: ReadonlySet<Category> = new Set([
  "COMPILE_ERROR",
  "RUNTIME_ERROR",
  "NO_SUCCESS",
  "TYPE_ERROR",
  "SYNTAX_ERROR",
  "OTHER",
]);

function classifyError(stderr: string, signal: string | null): Category {
  if (signal === "SIGKILL" || signal === "SIGTERM") return "TIMEOUT";
  if (stderr.includes("UnsupportedConstruct:")) return "UNSUPPORTED";
  if (stderr.includes("TypeError:")) return "TYPE_ERROR";
  if (stderr.includes("SyntaxError:")) return "SYNTAX_ERROR";
  if (stderr.includes("mtoc: ") && stderr.includes("failed (see output above)"))
    return "COMPILE_ERROR";
  // execFile exits with the child's status when the binary itself
  // exits non-zero (no mtoc:-prefixed line). That's a generated-C
  // runtime failure: assertion abort, segfault, etc.
  return "RUNTIME_ERROR";
}

async function runOne(rel: string): Promise<Result> {
  const abs = join(numblScriptsDir, rel);
  if (!existsSync(abs)) {
    return { rel, category: "NOT_FOUND", detail: `not found: ${abs}` };
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
    const err = e as Error & {
      stderr?: string;
      signal?: string | null;
      killed?: boolean;
    };
    const head = err.message.split("\n")[0];
    const stderr = err.stderr ?? "";
    const tail = stderr.trim();
    const signal = err.killed ? "SIGKILL" : (err.signal ?? null);
    const category = classifyError(stderr, signal);
    return {
      rel,
      category,
      detail: tail ? `${head}\n${tail}` : head,
    };
  }
  // The convention is that a passing numbl test prints SUCCESS as
  // the final line; intermediate disp output is fine. Split on
  // either line ending and trim any trailing CR / blank lines so a
  // CRLF-emitting environment doesn't mask a passing test.
  const lines = stdout.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const last = (lines[lines.length - 1] ?? "").replace(/\r$/, "");
  if (last === "SUCCESS") {
    return { rel, category: "PASS", detail: null };
  }
  const tail = lines.slice(-5).join("\n");
  return {
    rel,
    category: "NO_SUCCESS",
    detail: `did not print SUCCESS as the final line. stdout tail:\n${tail}`,
  };
}

/** Recursively enumerate `.m` files under `dir` that look like
 *  runnable tests, returned as paths relative to `numblScriptsDir`.
 *  Only files containing the literal string `SUCCESS` are returned —
 *  the rest are helper function definitions or scripts a test sources
 *  via `addpath`, and would all be misclassified as `NO_SUCCESS`
 *  otherwise. Class folders (`@Name/`) are walked like any other
 *  directory; if one of their methods happens to print SUCCESS it
 *  gets a (likely UNSUPPORTED) try. */
function discoverAllScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".m")) {
        // Cheap content check: a numbl test prints `disp('SUCCESS')`
        // (or `fprintf('SUCCESS\n')`) at the end. If the source has
        // no occurrence of the bare token, it's not one of the tests
        // we're trying to grade.
        const src = readFileSync(abs, "utf8");
        if (src.includes("SUCCESS")) {
          out.push(relative(numblScriptsDir, abs));
        }
      }
    }
  };
  if (
    !existsSync(numblScriptsDir) ||
    !statSync(numblScriptsDir).isDirectory()
  ) {
    return out;
  }
  walk(numblScriptsDir);
  out.sort();
  return out;
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

async function runCuratedList(scripts: string[]): Promise<number> {
  const concurrency = parseConcurrency();
  let pass = 0;
  let fail = 0;
  const failedNames: string[] = [];
  await runPool(scripts, concurrency, runOne, r => {
    if (r.category === "PASS") {
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
  return fail;
}

/** Format a corpus-relative path as a path relative to the mtoc repo
 *  root so terminals / IDEs render it as a clickable link. */
function clickable(rel: string): string {
  return `../numbl/numbl_test_scripts/${rel}`;
}

async function runProbe(filters: string[]): Promise<void> {
  let scripts = discoverAllScripts();
  if (filters.length > 0) {
    scripts = scripts.filter(rel => filters.some(f => rel.startsWith(f)));
    if (scripts.length === 0) {
      console.error(
        `probe: no .m files match the given filter(s): ${filters.join(", ")}`
      );
      process.exit(2);
    }
  }
  const concurrency = parseConcurrency();
  console.log(
    `probing ${scripts.length} numbl tests (concurrency=${concurrency}, timeout=${TIMEOUT_MS}ms)`
  );

  const byCategory = new Map<Category, Result[]>();
  let done = 0;
  await runPool(scripts, concurrency, runOne, r => {
    const bucket = byCategory.get(r.category) ?? [];
    bucket.push(r);
    byCategory.set(r.category, bucket);
    done++;
    if (INTERESTING.has(r.category)) {
      console.log(
        `[${done}/${scripts.length}] ${r.category} ${clickable(r.rel)}`
      );
      if (r.detail) {
        for (const line of r.detail.split("\n")) console.log(`    ${line}`);
      }
    } else if (done % 25 === 0 || done === scripts.length) {
      console.log(`[${done}/${scripts.length}] …`);
    }
  });

  const order: Category[] = [
    "PASS",
    "UNSUPPORTED",
    "TYPE_ERROR",
    "SYNTAX_ERROR",
    "COMPILE_ERROR",
    "RUNTIME_ERROR",
    "NO_SUCCESS",
    "TIMEOUT",
    "NOT_FOUND",
    "OTHER",
  ];
  console.log("\n=== summary ===");
  for (const cat of order) {
    const n = byCategory.get(cat)?.length ?? 0;
    if (n > 0) console.log(`  ${cat.padEnd(14)} ${n}`);
  }

  const passing = byCategory.get("PASS") ?? [];
  if (passing.length > 0) {
    console.log(`\n=== passing (${passing.length}) ===`);
    for (const r of passing) console.log(clickable(r.rel));
  }

  const interesting: Result[] = [];
  for (const cat of [
    "COMPILE_ERROR",
    "RUNTIME_ERROR",
    "NO_SUCCESS",
    "TYPE_ERROR",
    "SYNTAX_ERROR",
    "OTHER",
  ] as Category[]) {
    for (const r of byCategory.get(cat) ?? []) interesting.push(r);
  }
  if (interesting.length > 0) {
    console.log(
      `\n=== translated-but-broken (${interesting.length}) — tests that failed for reasons OTHER than UnsupportedConstruct ===`
    );
    for (const r of interesting)
      console.log(`${r.category} ${clickable(r.rel)}`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(numblScriptsDir)) {
    console.error(
      `numbl test corpus not found at ${numblScriptsDir}.\n` +
        `This runner needs numbl checked out as a sibling directory.`
    );
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const probeIdx = argv.indexOf("--probe");
  if (probeIdx >= 0) {
    const filters = argv.slice(0, probeIdx).concat(argv.slice(probeIdx + 1));
    await runProbe(filters);
    // Probe mode is informational — exit 0 regardless of failures.
    process.exit(0);
  }

  const all = parseList();
  const scripts =
    argv.length > 0
      ? argv.filter(a => {
          if (all.includes(a)) return true;
          console.error(`'${a}' is not in numbl_tests.txt — skipping`);
          return false;
        })
      : all;
  const fail = await runCuratedList(scripts);
  process.exit(fail === 0 ? 0 : 1);
}

main();
