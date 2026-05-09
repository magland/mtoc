#!/usr/bin/env node
/**
 * mtoc CLI — translate (.m → .c) and run (.m → compile → exec).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { translateProject, type TranslateError } from "./translate.js";
import { parseMFile } from "./parser/index.js";
import { Workspace } from "./workspace/workspace.js";
import { lower } from "./lowering/lower.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { SyntaxError as ParseSyntaxError } from "./parser/errors.js";
import { offsetToLine } from "./parser/sourceLoc.js";
import { startServer } from "../server/execution-service.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  mtoc translate <input.m> [output.c] [--no-runtime] [--dump-ir]",
      "  mtoc run <input.m> [--check-leaks]",
      "  mtoc serve --passkey <key> [--port N] [--host HOST]",
      "",
      "Options:",
      "  --no-runtime    Skip the runtime-helper bodies (mtoc_format_double,",
      "                  mtoc_disp_double, mtoc_tensor_t typedef, …) and the",
      "                  headers they pull in. Useful when embedding mtoc",
      "                  output into a project that supplies its own runtime.",
      "  --dump-ir       Dump the lowered IR as JSON instead of generating C.",
      "                  BuiltinSig closures are stubbed as the builtin name.",
      "                  Useful for debugging the lowering pass.",
      "  --check-leaks   (run only) Build with -fsanitize=address so",
      "                  AddressSanitizer + LeakSanitizer flag any unfreed",
      "                  buffer at exit. ~2x slowdown; off by default.",
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
  dumpIr: boolean;
  checkLeaks: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let noRuntime = false;
  let dumpIr = false;
  let checkLeaks = false;
  for (const a of args) {
    if (a === "--no-runtime") {
      noRuntime = true;
    } else if (a === "--dump-ir") {
      dumpIr = true;
    } else if (a === "--check-leaks") {
      checkLeaks = true;
    } else if (a.startsWith("--")) {
      process.stderr.write(`mtoc: unknown option '${a}'\n`);
      usage();
    } else {
      positional.push(a);
    }
  }
  return { positional, noRuntime, dumpIr, checkLeaks };
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
  const { positional, noRuntime, dumpIr } = parseArgs(args);
  if (positional.length < 1 || positional.length > 2) usage();
  const [inputPath, outputPath] = positional;
  const source = readFileSync(inputPath, "utf8");
  if (dumpIr) {
    if (noRuntime) {
      process.stderr.write(
        "mtoc: --no-runtime has no effect with --dump-ir (no C is emitted).\n"
      );
    }
    const out = dumpIrAsJson(source, basename(inputPath), inputPath);
    if (outputPath === undefined) {
      process.stdout.write(out);
      process.stdout.write("\n");
      return;
    }
    const outDir = dirname(resolve(outputPath));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outputPath, out + "\n");
    return;
  }
  const cSource = compile(source, basename(inputPath), !noRuntime, inputPath);
  if (outputPath === undefined) {
    process.stdout.write(cSource);
    return;
  }
  const outDir = dirname(resolve(outputPath));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, cSource);
}

/** Lower the source and serialize the IR as JSON. Stubs `BuiltinSig`
 *  closures (functions can't go through `JSON.stringify`) by replacing
 *  the `sig` field with `"<builtin: name>"` so call sites stay
 *  readable. Throws via `reportError` on any user-facing error. */
function dumpIrAsJson(
  source: string,
  inputName: string,
  inputPath: string
): string {
  const ws = new Workspace(inputName);
  let ast;
  try {
    ast = parseMFile(source, inputName);
    ws.addFile({ name: inputName, source, ast });
  } catch (e) {
    if (e instanceof ParseSyntaxError) {
      reportError(
        {
          kind: "SyntaxError",
          message: e.message,
          fileName: e.file ?? inputName,
          startOffset: e.position,
          endOffset: e.position + 1,
        },
        inputPath,
        source
      );
    }
    throw e;
  }
  let ir;
  try {
    ir = lower(ast, ws);
  } catch (e) {
    if (e instanceof UnsupportedConstruct || e instanceof TypeError) {
      reportError(
        {
          kind: e.name as "UnsupportedConstruct" | "TypeError",
          message: e.message,
          fileName: e.span?.file ?? inputName,
          startOffset: e.span?.start,
          endOffset: e.span?.end,
        },
        inputPath,
        source
      );
    }
    throw e;
  }
  return JSON.stringify(
    ir,
    (key, value) => {
      // Map / Set are common in the IR (assignedVars is a Map) and
      // serialize as `{}` / `{}` by default. Re-render as plain
      // objects / arrays so the dump is informative.
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      if (value instanceof Set) {
        return [...value];
      }
      // BuiltinSig holds an emit closure that can't serialize.
      // Render `callee: { kind: "builtin", sig: BuiltinSig }` as a
      // string so the IR shape stays inspectable.
      if (key === "sig" && typeof value === "object" && value !== null) {
        const name = (value as { name?: string }).name;
        return typeof name === "string" ? `<builtin: ${name}>` : "<builtin>";
      }
      return value;
    },
    2
  );
}

function cmdRun(args: string[]): void {
  const { positional, noRuntime, checkLeaks } = parseArgs(args);
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
  // --check-leaks builds with AddressSanitizer (which includes
  // LeakSanitizer at exit). On a leak the report goes to stderr with
  // a stack trace and the process exits non-zero. Off by default
  // because ASan adds noticeable runtime + memory overhead — the
  // cross-runner enables it for every test_scripts/ run.
  const ccArgs = [cFile, "-o", exeFile, "-lm"];
  if (checkLeaks) ccArgs.push("-fsanitize=address", "-g");
  try {
    execFileSync(cc, ccArgs, { stdio: "inherit" });
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
