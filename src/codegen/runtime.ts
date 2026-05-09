/**
 * mtoc runtime helpers — small C snippets we inline into the generated
 * source on demand.
 *
 * Each helper lives in its own .h file under `runtime/` so it can be
 * edited with normal C tooling (clangd, syntax highlighting). At module
 * load we read the file, parse out its `#include <...>` and `#include
 * "..."` lines, and split body from headers. emit.ts then merges every
 * helper's headers into one deduplicated set at the top of the output.
 *
 * Each helper is referenced by a stable name (e.g. "mtoc_disp_double")
 * so emit.ts can dedupe and order them. Snippets can declare other
 * snippets they depend on; the activator pulls dependencies in first.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(HERE, "runtime");

export interface RuntimeSnippet {
  /** Standard-library headers parsed out of the source file. */
  headers: ReadonlyArray<string>;
  /** Body of the snippet (definitions only — `#include`s removed). */
  code: string;
  /** Other helpers (by name) this snippet depends on. The activator
   *  pulls these in first so their definitions come before this
   *  snippet's. Cycles are not supported — keep the graph acyclic. */
  deps: ReadonlyArray<string>;
}

function loadSnippet(
  filename: string,
  deps: ReadonlyArray<string> = []
): RuntimeSnippet {
  const raw = readFileSync(join(RUNTIME_DIR, filename), "utf8");
  const headers: string[] = [];
  const bodyLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*include\s+(<[^>]+>|"[^"]+")\s*$/);
    if (m) {
      headers.push(m[1]);
    } else {
      bodyLines.push(line);
    }
  }
  while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "")
    bodyLines.pop();
  return { headers, code: bodyLines.join("\n") + "\n", deps };
}

const MTOC_FORMAT_DOUBLE = loadSnippet("format_double.h");
export const MTOC_DISP_DOUBLE = loadSnippet("disp_double.h", [
  "mtoc_format_double",
]);

const MTOC_FORMAT_COMPLEX = loadSnippet("format_complex.h", [
  "mtoc_format_double",
]);
export const MTOC_DISP_COMPLEX = loadSnippet("disp_complex.h", [
  "mtoc_format_complex",
]);

/**
 * Tensor struct typedef. No function body, but lives in the same
 * snippet machinery so its definition appears above any helper that
 * consumes it. Multi-element tensor codegen activates this directly.
 */
export const MTOC_TENSOR_STRUCT = loadSnippet("tensor.h");

/**
 * Heap allocation helper. Tensor storage is uniformly mallocked from
 * the heap (so the codegen path is exercised by every test, not just
 * large ones); this wrapper aborts with a clear diagnostic on
 * allocation failure. Activated alongside MTOC_TENSOR_STRUCT whenever
 * a tensor is declared.
 */
export const MTOC_ALLOC = loadSnippet("alloc.h");

const MTOC_DISP_TENSOR = loadSnippet("disp_tensor.h", [
  "mtoc_format_double",
  "mtoc_tensor_t",
]);

const MTOC_DISP_TENSOR_COMPLEX = loadSnippet("disp_tensor_complex.h", [
  "mtoc_format_complex",
  "mtoc_tensor_t",
]);

/**
 * Map of helper-name → RuntimeSnippet, keyed by the C identifier the
 * codegen emits (e.g. "mtoc_mod"). When emit.ts encounters a call to
 * a name in this map, it activates the helper. New helpers go here.
 */
export const RUNTIME_HELPERS: ReadonlyMap<string, RuntimeSnippet> = new Map([
  ["mtoc_format_double", MTOC_FORMAT_DOUBLE],
  ["mtoc_disp_double", MTOC_DISP_DOUBLE],
  ["mtoc_format_complex", MTOC_FORMAT_COMPLEX],
  ["mtoc_disp_complex", MTOC_DISP_COMPLEX],
  ["mtoc_tensor_t", MTOC_TENSOR_STRUCT],
  ["mtoc_alloc", MTOC_ALLOC],
  ["mtoc_disp_tensor", MTOC_DISP_TENSOR],
  ["mtoc_disp_tensor_complex", MTOC_DISP_TENSOR_COMPLEX],
  ["mtoc_mod", loadSnippet("mod.h")],
  ["mtoc_sign", loadSnippet("sign.h")],
  ["mtoc_sum", loadSnippet("sum.h", ["mtoc_tensor_t"])],
  ["mtoc_sum_complex", loadSnippet("sum_complex.h", ["mtoc_tensor_t"])],
  ["mtoc_length", loadSnippet("length.h", ["mtoc_tensor_t"])],
  ["mtoc_numel", loadSnippet("numel.h", ["mtoc_tensor_t"])],
  // Complex-scalar runtime helpers — siblings of libm-real / mtoc-real
  // entries. Activated by `BuiltinSig.emit` when the call's argTys
  // include a complex value.
  ["mtoc_clog2", loadSnippet("clog2.h")],
  ["mtoc_clog10", loadSnippet("clog10.h")],
  ["mtoc_clog1p", loadSnippet("clog1p.h")],
  ["mtoc_cexpm1", loadSnippet("cexpm1.h")],
  ["mtoc_sign_complex", loadSnippet("sign_complex.h")],
  ["mtoc_min_complex", loadSnippet("min_complex.h")],
  ["mtoc_max_complex", loadSnippet("max_complex.h")],
  ["mtoc_angle_real", loadSnippet("angle_real.h")],
]);
