#!/usr/bin/env tsx
/**
 * Sync mtoc's vendored lexer + parser from numbl.
 *
 * mtoc copies numbl's lexer / parser sources verbatim, with two minor
 * patches: the parser imports `offsetToLine` from a local `sourceLoc.ts`
 * stub instead of `../runtime/index.js`, and that stub is the only file
 * mtoc maintains itself. Everything else under `src/lexer/` and
 * `src/parser/` must match the upstream numbl tree byte-for-byte.
 *
 * Modes:
 *   --check      Report drift and exit non-zero if anything differs.
 *                Use in CI.
 *   --apply      Rewrite the mtoc files from numbl and update
 *                NUMBL_VERSION to numbl's HEAD SHA.
 *   (default)    Report drift only (exit 0 even if drifted).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const NUMBL_ROOT = resolve(REPO_ROOT, "..", "numbl");
const NUMBL_CORE = resolve(NUMBL_ROOT, "src", "numbl-core");
const VERSION_FILE = resolve(REPO_ROOT, "NUMBL_VERSION");

/** Files mtoc owns and the sync script will not touch. */
const MTOC_OWNED: ReadonlySet<string> = new Set([
  "src/parser/sourceLoc.ts",
]);

/** Subtrees that must match upstream byte-for-byte (post-patch). */
const SYNCED_SUBTREES: ReadonlyArray<{ numbl: string; mtoc: string }> = [
  { numbl: "lexer",  mtoc: "src/lexer"  },
  { numbl: "parser", mtoc: "src/parser" },
];

/**
 * Patches applied to upstream content before writing into mtoc.
 * Each entry: `(relPath, content) => content`.
 *
 * Keep this list minimal — every patch is a maintenance liability.
 */
const PATCHES: ReadonlyArray<(relPath: string, src: string) => string> = [
  // Re-route offsetToLine import from numbl's runtime to the inlined stub.
  (rel, src) => {
    if (rel !== "src/parser/index.ts" && rel !== "src/parser/ParserBase.ts") return src;
    return src.replace(
      'from "../runtime/index.js"',
      'from "./sourceLoc.js"',
    );
  },
];

function applyPatches(relPath: string, src: string): string {
  let out = src;
  for (const p of PATCHES) out = p(relPath, out);
  return out;
}

function listFilesRec(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

interface FileDiff {
  relPath: string;
  status: "missing-in-mtoc" | "extra-in-mtoc" | "differs" | "ok";
  expected?: string;
  actual?: string;
}

function diffSubtree(numblSub: string, mtocSub: string): FileDiff[] {
  const numblDir = join(NUMBL_CORE, numblSub);
  const mtocDir = join(REPO_ROOT, mtocSub);

  const numblFiles = listFilesRec(numblDir).map((p) => relative(numblDir, p));
  const mtocFiles = listFilesRec(mtocDir).map((p) => relative(mtocDir, p));

  const seen = new Set<string>();
  const diffs: FileDiff[] = [];

  for (const rel of numblFiles) {
    seen.add(rel);
    const relPath = join(mtocSub, rel);
    const numblFull = join(numblDir, rel);
    const mtocFull = join(mtocDir, rel);
    const expected = applyPatches(relPath, readFileSync(numblFull, "utf8"));

    if (!existsSync(mtocFull)) {
      diffs.push({ relPath, status: "missing-in-mtoc", expected });
      continue;
    }
    const actual = readFileSync(mtocFull, "utf8");
    if (actual !== expected) {
      diffs.push({ relPath, status: "differs", expected, actual });
    } else {
      diffs.push({ relPath, status: "ok" });
    }
  }

  for (const rel of mtocFiles) {
    if (seen.has(rel)) continue;
    const relPath = join(mtocSub, rel);
    if (MTOC_OWNED.has(relPath)) continue;
    diffs.push({ relPath, status: "extra-in-mtoc" });
  }

  return diffs;
}

function getNumblHeadSha(): string {
  return execFileSync("git", ["-C", NUMBL_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function getPinnedSha(): string | null {
  if (!existsSync(VERSION_FILE)) return null;
  return readFileSync(VERSION_FILE, "utf8").trim() || null;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const check = args.includes("--check");

  if (!existsSync(NUMBL_ROOT)) {
    console.error(`error: numbl not found at ${NUMBL_ROOT}`);
    console.error("       (sync expects numbl as a sibling directory of mtoc)");
    process.exit(2);
  }

  const numblHead = getNumblHeadSha();
  const pinned = getPinnedSha();

  console.log(`numbl HEAD:    ${numblHead}`);
  console.log(`mtoc pinned:   ${pinned ?? "(none)"}`);
  if (pinned && pinned !== numblHead) {
    console.log(`               (pin is behind upstream)`);
  }
  console.log("");

  const allDiffs: FileDiff[] = [];
  for (const sub of SYNCED_SUBTREES) {
    allDiffs.push(...diffSubtree(sub.numbl, sub.mtoc));
  }

  const drift = allDiffs.filter((d) => d.status !== "ok");
  if (drift.length === 0) {
    console.log("In sync: lexer + parser match numbl byte-for-byte (post-patch).");
    if (check && pinned !== numblHead) {
      console.error("\nerror: --check failed: NUMBL_VERSION pin is stale.");
      process.exit(1);
    }
    return;
  }

  console.log(`Drift detected (${drift.length} file${drift.length === 1 ? "" : "s"}):`);
  for (const d of drift) {
    console.log(`  ${d.status.padEnd(18)} ${d.relPath}`);
  }

  if (apply) {
    console.log("\nApplying...");
    for (const d of drift) {
      const full = join(REPO_ROOT, d.relPath);
      if (d.status === "missing-in-mtoc" || d.status === "differs") {
        writeFileSync(full, d.expected!);
        console.log(`  wrote   ${d.relPath}`);
      } else if (d.status === "extra-in-mtoc") {
        unlinkSync(full);
        console.log(`  removed ${d.relPath}`);
      }
    }
    writeFileSync(VERSION_FILE, numblHead + "\n");
    console.log(`  pinned  ${numblHead}`);
    console.log("\nDone. Run typecheck + tests before committing.");
  } else if (check) {
    console.error("\nerror: --check failed (run `tsx scripts/sync_from_numbl.ts --apply` to update).");
    process.exit(1);
  } else {
    console.log("\n(re-run with --apply to update mtoc, or --check to fail in CI.)");
  }
}

main();
