#!/usr/bin/env node
/**
 * mtoc CLI — translate (.m → .c) and run (.m → compile → exec).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { translateProject, type TranslateError } from "./translate.js";
import { offsetToLine } from "./parser/sourceLoc.js";
import { startServer } from "../server/execution-service.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  mtoc translate <input.m> [output.c] [--no-runtime]",
      "  mtoc run <input.m>",
      "  mtoc serve --passkey <key> [--port N] [--host HOST]",
      "",
      "Options:",
      "  --no-runtime    Skip the runtime-helper bodies (mtoc_format_double,",
      "                  mtoc_disp_double, mtoc_tensor_t typedef, …) and the",
      "                  headers they pull in. Useful when embedding mtoc",
      "                  output into a project that supplies its own runtime.",
      "",
      "When <output.c> is omitted, the translated C is written to stdout.",
      "",
      "`serve` starts a local HTTP server that compiles and runs C source",
      "submitted by the web IDE. Requires a passkey (the IDE's settings",
      "dialog generates one and shows you the command to paste). Default",
      "port is 3002 and the server binds to 127.0.0.1 by default.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

interface ParsedArgs {
  positional: string[];
  noRuntime: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let noRuntime = false;
  for (const a of args) {
    if (a === "--no-runtime") {
      noRuntime = true;
    } else if (a.startsWith("--")) {
      process.stderr.write(`mtoc: unknown option '${a}'\n`);
      usage();
    } else {
      positional.push(a);
    }
  }
  return { positional, noRuntime };
}

function reportError(
  err: TranslateError,
  inputPath: string,
  source: string
): never {
  if (err.kind === "SyntaxError") {
    process.stderr.write(`${inputPath}: SyntaxError: ${err.message}\n`);
    process.exit(1);
  }
  const where =
    err.startOffset !== undefined
      ? `:${offsetToLine(source, err.startOffset)}`
      : "";
  process.stderr.write(`${inputPath}${where}: ${err.kind}: ${err.message}\n`);
  process.exit(1);
}

function compile(
  source: string,
  inputName: string,
  includeRuntime: boolean,
  inputPath: string
): string {
  const result = translateProject([{ name: inputName, source }], inputName, {
    includeRuntime,
  });
  if (result.error) reportError(result.error, inputPath, source);
  return result.c!;
}

function cmdTranslate(args: string[]): void {
  const { positional, noRuntime } = parseArgs(args);
  if (positional.length < 1 || positional.length > 2) usage();
  const [inputPath, outputPath] = positional;
  const source = readFileSync(inputPath, "utf8");
  const cSource = compile(source, basename(inputPath), !noRuntime, inputPath);
  if (outputPath === undefined) {
    process.stdout.write(cSource);
    return;
  }
  const outDir = dirname(resolve(outputPath));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, cSource);
}

function cmdRun(args: string[]): void {
  const { positional, noRuntime } = parseArgs(args);
  if (positional.length !== 1) usage();
  if (noRuntime) {
    process.stderr.write(
      "mtoc: --no-runtime is incompatible with `run` (the runtime helpers are required to compile and execute).\n"
    );
    process.exit(2);
  }
  const [inputPath] = positional;
  const source = readFileSync(inputPath, "utf8");
  const cSource = compile(source, basename(inputPath), true, inputPath);

  const dir = mkdtempSync(join(tmpdir(), "mtoc-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "a.out");
  writeFileSync(cFile, cSource);

  const cc = process.env.CC || "cc";
  try {
    execFileSync(cc, [cFile, "-o", exeFile, "-lm"], { stdio: "inherit" });
  } catch {
    process.stderr.write(
      `mtoc: ${cc} failed (see output above). Source at ${cFile}\n`
    );
    process.exit(1);
  }

  try {
    execFileSync(exeFile, [], { stdio: "inherit" });
  } catch (e) {
    const status = (e as { status?: number }).status;
    process.exit(typeof status === "number" ? status : 1);
  }
}

function cmdServe(args: string[]): void {
  let passkey: string | undefined;
  let port = parseInt(process.env.MTOC_SERVE_PORT || "") || 3002;
  let host = process.env.MTOC_SERVE_HOST || "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--passkey") {
      passkey = args[++i];
    } else if (a === "--port") {
      port = parseInt(args[++i], 10);
      if (!Number.isFinite(port)) {
        process.stderr.write("mtoc: --port must be a number\n");
        process.exit(2);
      }
    } else if (a === "--host") {
      host = args[++i];
    } else {
      process.stderr.write(`mtoc: unknown serve option '${a}'\n`);
      usage();
    }
  }
  if (!passkey) {
    process.stderr.write(
      "mtoc: --passkey is required. The web IDE's execution-settings dialog generates one and shows you the full command to copy.\n"
    );
    process.exit(2);
  }
  startServer({ port, host, passkey });
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
    case "serve":
      return cmdServe(rest);
    case "-h":
    case "--help":
      return usage();
    default:
      process.stderr.write(`mtoc: unknown command '${cmd}'\n`);
      usage();
  }
}

main();
