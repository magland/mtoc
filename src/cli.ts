#!/usr/bin/env node
/**
 * mtoc CLI — translate (.m → .c) and run (.m → compile → exec).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { parseMFile } from "./parser/index.js";
import { Workspace } from "./workspace/workspace.js";
import { lower } from "./lowering/lower.js";
import { emitC } from "./codegen/emit.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { SyntaxError as ParseSyntaxError } from "./parser/errors.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  mtoc translate <input.m> <output.c>",
      "  mtoc run <input.m>",
      "",
    ].join("\n")
  );
  process.exit(2);
}

interface CompiledArtifacts {
  cSource: string;
  inputName: string;
}

function compileMtoCSource(inputPath: string): CompiledArtifacts {
  const source = readFileSync(inputPath, "utf8");
  const inputName = basename(inputPath);
  const ast = parseMFile(source, inputName);
  const workspace = new Workspace(inputName);
  workspace.addFile({ name: inputName, source, ast });
  const ir = lower(ast, workspace);
  return { cSource: emitC(ir), inputName };
}

function reportError(e: unknown, inputPath: string): never {
  if (e instanceof UnsupportedConstruct || e instanceof TypeError) {
    const where = e.span
      ? ` at offset ${e.span.start}`
      : "";
    process.stderr.write(`${inputPath}: ${e.name}${where}: ${e.message}\n`);
    process.exit(1);
  }
  if (e instanceof ParseSyntaxError) {
    process.stderr.write(`${inputPath}: SyntaxError: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

function cmdTranslate(args: string[]): void {
  if (args.length !== 2) usage();
  const [inputPath, outputPath] = args;
  let result: CompiledArtifacts;
  try {
    result = compileMtoCSource(inputPath);
  } catch (e) {
    reportError(e, inputPath);
  }
  const outDir = dirname(resolve(outputPath));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, result.cSource);
}

function cmdRun(args: string[]): void {
  if (args.length !== 1) usage();
  const [inputPath] = args;
  let result: CompiledArtifacts;
  try {
    result = compileMtoCSource(inputPath);
  } catch (e) {
    reportError(e, inputPath);
  }

  const dir = mkdtempSync(join(tmpdir(), "mtoc-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "a.out");
  writeFileSync(cFile, result.cSource);

  const cc = process.env.CC || "cc";
  try {
    execFileSync(cc, [cFile, "-o", exeFile, "-lm"], { stdio: "inherit" });
  } catch {
    process.stderr.write(`mtoc: ${cc} failed (see output above). Source at ${cFile}\n`);
    process.exit(1);
  }

  try {
    execFileSync(exeFile, [], { stdio: "inherit" });
  } catch (e) {
    const status = (e as { status?: number }).status;
    process.exit(typeof status === "number" ? status : 1);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "translate":
      return cmdTranslate(rest);
    case "run":
      return cmdRun(rest);
    case "-h":
    case "--help":
      usage();
    default:
      process.stderr.write(`mtoc: unknown command '${cmd}'\n`);
      usage();
  }
}

main();
