/**
 * Shared helpers for the translate-* test files.
 *
 * `translate(source)` is the workhorse — parse + lower + emit, all
 * three stages composed exactly the way `translateProject` does it
 * in production but without the multi-file scaffolding most tests
 * don't need. Tests assert against the returned C string.
 *
 * The CLI tests need `cliPath` to spawn `tsx src/cli.ts` directly;
 * the path is exported here so each test file resolves it the same way.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";
import { emitC } from "../src/codegen/emit.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");
export const cliPath = join(repoRoot, "src", "cli.ts");
export const example1Path = join(repoRoot, "examples", "example1.m");

export function translate(
  source: string,
  opts: {
    includeRuntime?: boolean;
    enableTempInlining?: boolean;
    threads?: number | "auto";
  } = {}
): string {
  const ast = parseMFile(source, "test.m");
  const ws = new Workspace("test.m");
  ws.addFile({ name: "test.m", source, ast });
  return emitC(lower(ast, ws), opts);
}
