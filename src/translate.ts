/**
 * Single entry point for translating numbl source into C. Used by both
 * the CLI ([cli.ts](./cli.ts)) and the web IDE ([components/IDEWorkspace.tsx](../src/components/IDEWorkspace.tsx)).
 *
 * Multi-file projects: the named active file is the entry, and every
 * other file in `files` is a sibling workspace file. A call like
 * `helper(x)` from the entry resolves to the primary function of
 * `helper.m` per numbl's resolution rules (vendored from
 * `src/numbl-core/functionResolve.ts`).
 *
 * Errors are normalized into a single shape and returned (never thrown);
 * callers can render them inline without a try/catch dance.
 */

import { parseMFile } from "./parser/index.js";
import { Workspace } from "./workspace/workspace.js";
import { lower } from "./lowering/lower.js";
import { emitC } from "./codegen/emit.js";
import { UnsupportedConstruct, TypeError } from "./lowering/errors.js";
import { SyntaxError as ParseSyntaxError } from "./parser/errors.js";

export interface SourceFile {
  /** File name used in error attribution. For the web IDE this is a
   *  flat name like `"main.m"`; for the CLI it is the absolute path
   *  of the file on disk (so the vendored numbl resolver can strip
   *  the workspace root and derive workspace-function names from the
   *  basename). */
  name: string;
  source: string;
}

export interface TranslateError {
  /** Short class name: "SyntaxError", "UnsupportedConstruct", "TypeError". */
  kind: "SyntaxError" | "UnsupportedConstruct" | "TypeError";
  message: string;
  /** File the error attributes to. May be undefined when the error
   *  predates file attribution (e.g. SyntaxError from parseMFile). */
  fileName?: string;
  /** Character offsets into the file's source. Both undefined when the
   *  error has no location info. */
  startOffset?: number;
  endOffset?: number;
}

export interface TranslateResult {
  /** Generated C source. Present iff `error` is undefined. */
  c?: string;
  error?: TranslateError;
}

export interface TranslateOptions {
  /** Inline runtime helper bodies into the C output (default true). */
  includeRuntime?: boolean;
  /** Search paths for cross-file resolution. The CLI passes
   *  `[dirname(absoluteEntry)]` so workspace-function names are
   *  derived from the basename. The web IDE leaves this undefined —
   *  flat file names are treated as already-relative. */
  searchPaths?: ReadonlyArray<string>;
}

/**
 * Translate the named active file in the project to C. Returns a result
 * object — never throws on user-program errors.
 */
export function translateProject(
  files: SourceFile[],
  activeName: string,
  opts: TranslateOptions = {}
): TranslateResult {
  const includeRuntime = opts.includeRuntime ?? true;
  const active = files.find(f => f.name === activeName);
  if (!active) {
    return {
      error: {
        kind: "UnsupportedConstruct",
        message: `active file '${activeName}' is not in the project`,
      },
    };
  }

  const workspace = new Workspace(activeName, opts.searchPaths ?? []);
  let activeAst;
  try {
    for (const f of files) {
      const ast = parseMFile(f.source, f.name);
      workspace.addFile({ name: f.name, source: f.source, ast });
      if (f.name === activeName) activeAst = ast;
    }
  } catch (e) {
    if (e instanceof ParseSyntaxError) {
      return { error: normalizeSyntaxError(e, files) };
    }
    throw e;
  }

  if (!activeAst) {
    // Defensive: should be unreachable given the membership check above.
    return {
      error: {
        kind: "UnsupportedConstruct",
        message: `active file '${activeName}' produced no AST`,
      },
    };
  }

  try {
    const ir = lower(activeAst, workspace);
    return { c: emitC(ir, { includeRuntime }) };
  } catch (e) {
    if (e instanceof UnsupportedConstruct || e instanceof TypeError) {
      return {
        error: {
          kind: e.name as "UnsupportedConstruct" | "TypeError",
          message: e.message,
          fileName: e.span?.file ?? activeName,
          startOffset: e.span?.start,
          endOffset: e.span?.end,
        },
      };
    }
    throw e;
  }
}

function normalizeSyntaxError(
  e: ParseSyntaxError,
  files: SourceFile[]
): TranslateError {
  // The parser's SyntaxError doesn't always carry .file; if it does,
  // pin offsets to that file's source length so the marker stays in range.
  const fileName = e.file ?? undefined;
  const file = fileName ? files.find(f => f.name === fileName) : undefined;
  const len = file?.source.length;
  let start = e.position;
  let end = e.position + 1;
  if (typeof len === "number") {
    if (start > len) start = len;
    if (end > len) end = len;
  }
  return {
    kind: "SyntaxError",
    message: e.message,
    fileName,
    startOffset: start,
    endOffset: end,
  };
}
