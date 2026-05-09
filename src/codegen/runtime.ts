/**
 * mtoc runtime helpers — small C snippets we inline into the generated
 * source on demand.
 *
 * Each helper lives in its own .h file under `runtime/` so it can be
 * edited with normal C tooling (clangd, syntax highlighting). The .h
 * sources are inlined into `runtime/snippets.gen.ts` by
 * `scripts/build_runtime_snippets.ts`; this module reads them from there
 * (rather than the filesystem at load time) so the translator can be
 * bundled into a browser build.
 *
 * Each helper is referenced by a stable name (e.g. "mtoc_disp_double")
 * so emit.ts can dedupe and order them. Snippets can declare other
 * snippets they depend on; the activator pulls dependencies in first.
 */

import { SNIPPETS } from "./runtime/snippets.gen.js";

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
  const raw = SNIPPETS[filename];
  if (raw === undefined) {
    throw new Error(
      `runtime snippet '${filename}' not found in snippets.gen.ts; ` +
        `re-run 'npm run build:snippets' after adding the .h file`
    );
  }
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
 * String struct typedef. Like the tensor struct, no function body —
 * it's the seed every string runtime helper depends on. Activated
 * automatically wherever a string lives in the emitted program (at
 * predeclarations, at literals, at assigns, at disp / error).
 */
export const MTOC_STRING_STRUCT = loadSnippet("string.h");

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
  // Tensor lifecycle helpers. Every multi-element Assign + scope-exit
  // path goes through these, so generated C reads close to the numbl
  // source — `mtoc_tensor_assign(&x, mtoc_tensor_from_row(..., 3));`
  // collapses what used to be a six-line allocate-fill-free-swap.
  // Real and complex variants are split for `alloc` / `from_row` /
  // `from_matrix` / `copy` (codegen knows `isComplex` statically and
  // dispatches at the call site, preserving the "no runtime branch on
  // imag" invariant); `empty` / `free` / `assign` are shape-agnostic
  // (free(NULL) is well-defined) so they share a single helper.
  ["mtoc_tensor_empty", loadSnippet("tensor_empty.h", ["mtoc_tensor_t"])],
  [
    "mtoc_tensor_alloc",
    loadSnippet("tensor_alloc.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  [
    "mtoc_tensor_alloc_complex",
    loadSnippet("tensor_alloc_complex.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  [
    "mtoc_tensor_from_row",
    loadSnippet("tensor_from_row.h", ["mtoc_tensor_t", "mtoc_tensor_alloc"]),
  ],
  [
    "mtoc_tensor_from_matrix",
    loadSnippet("tensor_from_matrix.h", ["mtoc_tensor_t", "mtoc_tensor_alloc"]),
  ],
  [
    "mtoc_tensor_from_row_complex",
    loadSnippet("tensor_from_row_complex.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_complex",
    ]),
  ],
  [
    "mtoc_tensor_from_matrix_complex",
    loadSnippet("tensor_from_matrix_complex.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_complex",
    ]),
  ],
  [
    "mtoc_tensor_copy",
    loadSnippet("tensor_copy.h", ["mtoc_tensor_t", "mtoc_tensor_alloc"]),
  ],
  [
    "mtoc_tensor_copy_complex",
    loadSnippet("tensor_copy_complex.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_complex",
    ]),
  ],
  ["mtoc_tensor_free", loadSnippet("tensor_free.h", ["mtoc_tensor_t"])],
  ["mtoc_tensor_assign", loadSnippet("tensor_assign.h", ["mtoc_tensor_t"])],
  ["mtoc_disp_tensor", MTOC_DISP_TENSOR],
  ["mtoc_disp_tensor_complex", MTOC_DISP_TENSOR_COMPLEX],
  ["mtoc_check_shape", loadSnippet("check_shape.h", ["mtoc_tensor_t"])],
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
  // String runtime helpers. The struct typedef seeds the dependency
  // graph; literal / copy / concat / free / assign / disp / error all
  // pull it in. `mtoc_string_alloc_bytes` is the char-buffer
  // allocator (siblng to `mtoc_alloc` for tensor data); copy and
  // concat depend on it. `error` calls `exit(1)` after writing the
  // message to stderr.
  ["mtoc_string_t", MTOC_STRING_STRUCT],
  ["mtoc_string_empty", loadSnippet("string_empty.h", ["mtoc_string_t"])],
  [
    "mtoc_string_from_literal",
    loadSnippet("string_from_literal.h", ["mtoc_string_t"]),
  ],
  ["mtoc_string_alloc_bytes", loadSnippet("string_alloc_bytes.h")],
  [
    "mtoc_string_copy",
    loadSnippet("string_copy.h", ["mtoc_string_t", "mtoc_string_alloc_bytes"]),
  ],
  [
    "mtoc_string_concat",
    loadSnippet("string_concat.h", [
      "mtoc_string_t",
      "mtoc_string_alloc_bytes",
    ]),
  ],
  ["mtoc_string_free", loadSnippet("string_free.h", ["mtoc_string_t"])],
  [
    "mtoc_string_assign",
    loadSnippet("string_assign.h", ["mtoc_string_t", "mtoc_string_free"]),
  ],
  ["mtoc_disp_string", loadSnippet("disp_string.h", ["mtoc_string_t"])],
  ["mtoc_error_string", loadSnippet("error_string.h", ["mtoc_string_t"])],
]);
