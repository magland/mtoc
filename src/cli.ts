#!/usr/bin/env node
/**
 * mtoc CLI — translate (.m → .c) and run (.m → compile → exec).
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  translateProject,
  type SourceFile,
  type TranslateError,
} from "./translate.js";
import { parseMFile } from "./parser/index.js";
import { Workspace } from "./workspace/workspace.js";
import { lower } from "./lowering/lower.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { SyntaxError as ParseSyntaxError } from "./parser/errors.js";
import { offsetToLine } from "./parser/sourceLoc.js";
import { scanMFiles } from "./numbl-cli/cli-scan.js";
import { startServer } from "../server/execution-service.js";
import { buildCcArgs } from "./build.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  mtoc translate <input.m> [output.c] [--no-runtime] [--dump-ir] [--inline-temps] [--threads N|auto]",
      "  mtoc run <input.m> [--check-leaks] [--fast-math] [--inline-temps] [--threads N|auto]",
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
      "  --fast-math     (run only) Add -ffast-math to the build. Lets the",
      "                  C compiler reassociate floating-point ops so hot",
      "                  loops vectorize more aggressively. NOT IEEE-754",
      "                  strict; results may drift in the last few ulps.",
      "                  Off by default to keep the CLI's default `run`",
      "                  output bit-stable with the cross-runner oracle.",
      "                  -O3 -march=native is always on regardless.",
      "  --inline-temps  Enable tensor-expression inlining. Every",
      "                  single-use multi-element tensor Assign has its",
      "                  RHS substituted into its unique consumer and is",
      "                  then deleted, eliminating large intermediates",
      "                  that thrash cache between separate loops. Same",
      "                  numerical results as the un-inlined build (cross-",
      "                  runner is byte-for-byte parity-tested with the",
      "                  flag on AND off).",
      "  --threads N|auto",
      "                  Max threads for parallelizable elementwise loops.",
      "                  N = a positive integer; `auto` = let OpenMP pick",
      "                  (uses OMP_NUM_THREADS or # cores). Default 1",
      "                  (pure serial — no #pragma omp lines emitted, no",
      "                  -fopenmp on the link, binary bit-identical to",
      "                  today's serial output).",
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
  fastMath: boolean;
  inlineTemps: boolean;
  threads: number | "auto";
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let noRuntime = false;
  let dumpIr = false;
  let checkLeaks = false;
  let fastMath = false;
  let inlineTemps = false;
  let threads: number | "auto" = 1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-runtime") {
      noRuntime = true;
    } else if (a === "--dump-ir") {
      dumpIr = true;
    } else if (a === "--check-leaks") {
      checkLeaks = true;
    } else if (a === "--fast-math") {
      fastMath = true;
    } else if (a === "--inline-temps") {
      inlineTemps = true;
    } else if (a === "--threads") {
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write(
          `mtoc: --threads requires a value (N or 'auto')\n`
        );
        usage();
      }
      if (v === "auto") {
        threads = "auto";
      } else {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 1 || String(n) !== v) {
          process.stderr.write(
            `mtoc: --threads value must be a positive integer or 'auto' (got '${v}')\n`
          );
          usage();
        }
        threads = n;
      }
    } else if (a.startsWith("--")) {
      process.stderr.write(`mtoc: unknown option '${a}'\n`);
      usage();
    } else {
      positional.push(a);
    }
  }
  return {
    positional,
    noRuntime,
    dumpIr,
    checkLeaks,
    fastMath,
    inlineTemps,
    threads,
  };
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

/** Build the project the CLI hands to `translateProject`: the entry
 *  file plus every sibling `.m` (and `.numbl.js` / `.wasm`) under
 *  `dirname(absInputPath)`, scanned with numbl's vendored
 *  `scanMFiles`. All names are absolute paths so the vendored
 *  resolver can derive workspace-function names by stripping the
 *  search-path prefix. */
function buildProjectFiles(
  absInputPath: string,
  entrySource: string
): { files: SourceFile[]; searchPaths: string[] } {
  const workspaceRoot = dirname(absInputPath);
  const siblings = scanMFiles(workspaceRoot, absInputPath).filter(f =>
    f.name.endsWith(".m")
  );
  const files: SourceFile[] = [
    { name: absInputPath, source: entrySource },
    ...siblings.map(f => ({ name: f.name, source: f.source })),
  ];
  return { files, searchPaths: [workspaceRoot] };
}

function compile(
  source: string,
  absInputPath: string,
  includeRuntime: boolean,
  inputPath: string,
  enableTempInlining: boolean,
  threads: number | "auto"
): string {
  const { files, searchPaths } = buildProjectFiles(absInputPath, source);
  const result = translateProject(files, absInputPath, {
    includeRuntime,
    searchPaths,
    enableTempInlining,
    threads,
  });
  if (result.error) reportError(result.error, inputPath, source);
  return result.c!;
}

function cmdTranslate(args: string[]): void {
  const { positional, noRuntime, dumpIr, inlineTemps, threads } =
    parseArgs(args);
  if (positional.length < 1 || positional.length > 2) usage();
  const [inputPath, outputPath] = positional;
  const source = readFileSync(inputPath, "utf8");
  const absInputPath = resolve(inputPath);
  if (dumpIr) {
    if (noRuntime) {
      process.stderr.write(
        "mtoc: --no-runtime has no effect with --dump-ir (no C is emitted).\n"
      );
    }
    const out = dumpIrAsJson(source, absInputPath, inputPath);
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
  const cSource = compile(
    source,
    absInputPath,
    !noRuntime,
    inputPath,
    inlineTemps,
    threads
  );
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
 *  readable. Throws via `reportError` on any user-facing error.
 *
 *  Note: `--dump-ir` lowers ONLY the entry file (no sibling-file
 *  resolution). It's a debugging hook; multi-file dump support can
 *  follow once we have a need for it. */
function dumpIrAsJson(
  source: string,
  absInputPath: string,
  inputPath: string
): string {
  const ws = new Workspace(absInputPath);
  let ast;
  try {
    ast = parseMFile(source, absInputPath);
    ws.addFile({ name: absInputPath, source, ast });
  } catch (e) {
    if (e instanceof ParseSyntaxError) {
      reportError(
        {
          kind: "SyntaxError",
          message: e.message,
          fileName: e.file ?? absInputPath,
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
          fileName: e.span?.file ?? absInputPath,
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
  const { positional, noRuntime, checkLeaks, fastMath, inlineTemps, threads } =
    parseArgs(args);
  if (positional.length !== 1) usage();
  if (noRuntime) {
    process.stderr.write(
      "mtoc: --no-runtime is incompatible with `run` (the runtime helpers are required to compile and execute).\n"
    );
    process.exit(2);
  }
  const [inputPath] = positional;
  const source = readFileSync(inputPath, "utf8");
  const absInputPath = resolve(inputPath);
  const cSource = compile(
    source,
    absInputPath,
    true,
    inputPath,
    inlineTemps,
    threads
  );

  const dir = mkdtempSync(join(tmpdir(), "mtoc-"));
  const cFile = join(dir, "out.c");
  const exeFile = join(dir, "a.out");
  writeFileSync(cFile, cSource);

  const cc = process.env.CC || "cc";
  // Compile flags are shared with the execution server via
  // `src/build.ts::buildCcArgs` so a binary built by `mtoc run` is
  // bit-identical to one built by the remote `/run` endpoint for
  // the same toggles. See `BuildOptions` for what each flag does.
  const ccArgs = buildCcArgs(cFile, exeFile, { checkLeaks, fastMath, threads });
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
