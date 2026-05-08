/**
 * Cross-runner harness: each .m file in test_scripts/ should produce
 * the same stdout when run through `npx numbl run` and through mtoc's
 * own `run` command. Discovers scripts at module-load time so each
 * file shows up as its own test in vitest's reporter.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const numblCliPath = resolve(repoRoot, "..", "numbl", "src", "cli.ts");
const scriptsDir = join(repoRoot, "test_scripts");

function discoverScripts(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && e.endsWith(".m")) files.push(p);
    }
  };
  walk(scriptsDir);
  return files.sort();
}

function runMtoc(scriptPath: string): string {
  return execFileSync("npx", ["tsx", cliPath, "run", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function runNumbl(scriptPath: string): string {
  return execFileSync("npx", ["tsx", numblCliPath, "run", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

const scripts = discoverScripts();

describe("test_scripts: mtoc output matches numbl", () => {
  if (scripts.length === 0) {
    it.skip("no scripts found", () => {});
    return;
  }

  for (const scriptPath of scripts) {
    const name = scriptPath.slice(repoRoot.length + 1);
    it(name, () => {
      const expected = runNumbl(scriptPath);
      const actual = runMtoc(scriptPath);
      expect(actual).toBe(expected);
    }, 60_000);
  }
});
