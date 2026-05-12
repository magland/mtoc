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

/**
 * Parse a raw snippet source string into its `headers` and `code` parts.
 *
 * The strict `#include` pattern accepted is:
 *   optional-whitespace `#` optional-whitespace `include`
 *   whitespace `<header>` or `"header"` optional-trailing-whitespace
 *
 * Any line whose trimmed form starts with `#include` but does NOT match
 * that pattern (e.g. a trailing `// comment`, a `#include<nospace>`) is
 * rejected with a clear error rather than silently dropped into the body.
 *
 * Exported for use in tests.
 */
export function parseSnippetSource(raw: string): {
  headers: string[];
  code: string;
} {
  const headers: string[] = [];
  const bodyLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*#\s*include\s+(<[^>]+>|"[^"]+")\s*$/);
    if (m) {
      headers.push(m[1]);
    } else if (/^\s*#\s*include\b/.test(line)) {
      throw new Error(
        `runtime snippet: unexpected #include form: ${JSON.stringify(line)}; ` +
          `expected '#include <header>' or '#include "header"' with no trailing content`
      );
    } else {
      bodyLines.push(line);
    }
  }
  while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "")
    bodyLines.pop();
  return { headers, code: bodyLines.join("\n") + "\n" };
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
  const { headers, code } = parseSnippetSource(raw);
  return { headers, code, deps };
}

// Each `loadSnippet(name, deps)` parses the inlined `.h` file's
// `#include` lines and resolves a dependency list of other snippets
// that must be activated first. Snippets are referenced by their
// registry key (`mtoc_*` C identifier); call sites use
// `useRuntimeByName(state, key)` and the activator pulls the dep
// closure in transitively.

/** Fiber-walk scaffold macros shared by the four axis-reduction helpers
 *  (sum_default, sum_complex_default, minmax_default, minmax_complex_default).
 *  Emitted before any of those four snippets so macros are in scope. */
const MTOC_REDUCTION_WALK = loadSnippet("reduction_walk.h");
const MTOC_FORMAT_DOUBLE = loadSnippet("format_double.h");
const MTOC_DISP_DOUBLE = loadSnippet("disp_double.h", ["mtoc_format_double"]);
const MTOC_FORMAT_COMPLEX = loadSnippet("format_complex.h", [
  "mtoc_format_double",
]);
const MTOC_DISP_COMPLEX = loadSnippet("disp_complex.h", [
  "mtoc_format_complex",
]);
/** Tensor struct typedef. Activated whenever a multi-element tensor
 *  is declared, allocated, or freed. */
const MTOC_TENSOR_STRUCT = loadSnippet("tensor.h");
/** String struct typedef. Seed for every string helper. */
const MTOC_STRING_STRUCT = loadSnippet("string.h");
/** Heap-allocation helper. Aborts on malloc failure so call sites can
 *  drop the result straight into a struct literal. */
const MTOC_ALLOC = loadSnippet("alloc.h");
/** Char-tensor struct typedef. Activated whenever a char-array value
 *  is declared, allocated, or freed. */
const MTOC_CHAR_TENSOR_STRUCT = loadSnippet("char_tensor.h");
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
  ["mtoc_reduction_walk", MTOC_REDUCTION_WALK],
  ["mtoc_format_double", MTOC_FORMAT_DOUBLE],
  ["mtoc_disp_double", MTOC_DISP_DOUBLE],
  ["mtoc_format_complex", MTOC_FORMAT_COMPLEX],
  ["mtoc_disp_complex", MTOC_DISP_COMPLEX],
  ["mtoc_tensor_t", MTOC_TENSOR_STRUCT],
  ["mtoc_alloc", MTOC_ALLOC],
  ["mtoc_loop_count", loadSnippet("loop_count.h")],
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
    "mtoc_tensor_alloc_nd",
    loadSnippet("tensor_alloc_nd.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  [
    "mtoc_tensor_alloc_nd_complex",
    loadSnippet("tensor_alloc_nd_complex.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  [
    "mtoc_tensor_reshape",
    loadSnippet("tensor_reshape.h", ["mtoc_tensor_t", "mtoc_tensor_alloc_nd"]),
  ],
  [
    "mtoc_tensor_reshape_complex",
    loadSnippet("tensor_reshape_complex.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd_complex",
    ]),
  ],
  [
    "mtoc_tensor_transpose",
    loadSnippet("tensor_transpose.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd",
    ]),
  ],
  [
    "mtoc_tensor_transpose_complex",
    loadSnippet("tensor_transpose_complex.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd_complex",
    ]),
  ],
  [
    "mtoc_zeros_nd",
    loadSnippet("tensor_zeros.h", ["mtoc_tensor_t", "mtoc_tensor_alloc_nd"]),
  ],
  [
    "mtoc_ones_nd",
    loadSnippet("tensor_ones.h", ["mtoc_tensor_t", "mtoc_tensor_alloc_nd"]),
  ],
  [
    "mtoc_nan_nd",
    loadSnippet("tensor_nan.h", ["mtoc_tensor_t", "mtoc_tensor_alloc_nd"]),
  ],
  [
    "mtoc_inf_nd",
    loadSnippet("tensor_inf.h", ["mtoc_tensor_t", "mtoc_tensor_alloc_nd"]),
  ],
  [
    "mtoc_eye_2d",
    loadSnippet("tensor_eye.h", ["mtoc_tensor_t", "mtoc_tensor_alloc"]),
  ],
  // rng.h defines several related symbols (mtoc_rng_seed,
  // mtoc_rng_random, mtoc_rng_randn) plus the shared static state.
  // We register the whole block under one canonical key so an
  // emitter that wants any of them activates the same snippet
  // exactly once. Call sites use `state.useRuntime("mtoc_rng")`
  // even when they emit `mtoc_rng_random()` / `mtoc_rng_seed(...)`
  // / `mtoc_rng_randn()` in the rendered C.
  ["mtoc_rng", loadSnippet("rng.h")],
  // `tic` / `toc` share a single snippet (one static for the last-tic
  // timestamp, plus the value / handle / print variants). Call sites
  // activate via `state.useRuntime("mtoc_tic")` regardless of which
  // entry they emit (mtoc_tic / mtoc_toc / mtoc_toc_h /
  // mtoc_toc_print / mtoc_toc_print_h) — the snippet defines them all.
  ["mtoc_tic", loadSnippet("tic.h")],
  [
    "mtoc_rand_nd",
    loadSnippet("tensor_rand.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd",
      "mtoc_rng",
    ]),
  ],
  [
    "mtoc_randn_nd",
    loadSnippet("tensor_randn.h", [
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd",
      "mtoc_rng",
    ]),
  ],
  [
    "mtoc_size_vec",
    loadSnippet("size_vec.h", ["mtoc_tensor_t", "mtoc_tensor_alloc"]),
  ],
  ["mtoc_size_dim", loadSnippet("size_dim.h", ["mtoc_tensor_t"])],
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
    loadSnippet("tensor_copy.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  [
    "mtoc_tensor_copy_complex",
    loadSnippet("tensor_copy_complex.h", ["mtoc_tensor_t", "mtoc_alloc"]),
  ],
  ["mtoc_tensor_free", loadSnippet("tensor_free.h", ["mtoc_tensor_t"])],
  ["mtoc_tensor_assign", loadSnippet("tensor_assign.h", ["mtoc_tensor_t"])],
  ["mtoc_disp_tensor", MTOC_DISP_TENSOR],
  ["mtoc_disp_tensor_complex", MTOC_DISP_TENSOR_COMPLEX],
  ["mtoc_check_shape", loadSnippet("check_shape.h", ["mtoc_tensor_t"])],
  ["mtoc_broadcast_dim", loadSnippet("broadcast_dim.h")],
  ["mtoc_mod", loadSnippet("mod.h")],
  ["mtoc_sign", loadSnippet("sign.h")],
  ["mtoc_sum", loadSnippet("sum.h", ["mtoc_tensor_t"])],
  ["mtoc_sum_complex", loadSnippet("sum_complex.h", ["mtoc_tensor_t"])],
  [
    "mtoc_sum_default",
    loadSnippet("sum_default.h", [
      "mtoc_reduction_walk",
      "mtoc_tensor_t",
      "mtoc_tensor_alloc",
      "mtoc_tensor_alloc_nd",
    ]),
  ],
  [
    "mtoc_sum_complex_default",
    loadSnippet("sum_complex_default.h", [
      "mtoc_reduction_walk",
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd_complex",
    ]),
  ],
  // Tensor `min` / `max` — 1-arg reduction siblings of the 2-arg
  // elementwise `min` / `max` registered above. Each `.h` defines BOTH
  // the min and max variants together; we register one umbrella key per
  // .h file and the lowerer activates that umbrella regardless of which
  // symbol it emits in the C source (same idiom as `mtoc_rng` / `mtoc_tic`):
  //   - mtoc_minmax_real_all      → mtoc_min_real_all / mtoc_max_real_all
  //   - mtoc_minmax_complex_all   → mtoc_min_complex_all / mtoc_max_complex_all
  //   - mtoc_minmax_real_default  → mtoc_min_real_default / mtoc_max_real_default
  //   - mtoc_minmax_complex_default → mtoc_min_complex_default / mtoc_max_complex_default
  ["mtoc_minmax_real_all", loadSnippet("minmax_all.h", ["mtoc_tensor_t"])],
  [
    "mtoc_minmax_complex_all",
    loadSnippet("minmax_complex_all.h", ["mtoc_tensor_t"]),
  ],
  [
    "mtoc_minmax_real_default",
    loadSnippet("minmax_default.h", [
      "mtoc_reduction_walk",
      "mtoc_tensor_t",
      "mtoc_tensor_alloc",
      "mtoc_tensor_alloc_nd",
    ]),
  ],
  [
    "mtoc_minmax_complex_default",
    loadSnippet("minmax_complex_default.h", [
      "mtoc_reduction_walk",
      "mtoc_tensor_t",
      "mtoc_tensor_alloc_nd_complex",
    ]),
  ],
  ["mtoc_length", loadSnippet("length.h", ["mtoc_tensor_t"])],
  ["mtoc_numel", loadSnippet("numel.h", ["mtoc_tensor_t"])],
  // Complex-scalar runtime helpers — siblings of libm-real / mtoc-real
  // entries. Activated by `BuiltinSig.emit` when the call's argTys
  // include a complex value.
  ["mtoc_clog2", loadSnippet("clog2.h")],
  ["mtoc_clog10", loadSnippet("clog10.h")],
  ["mtoc_clog1p", loadSnippet("clog1p.h")],
  ["mtoc_cexpm1", loadSnippet("cexpm1.h")],
  ["mtoc_cdiv", loadSnippet("cdiv.h")],
  ["mtoc_sign_complex", loadSnippet("sign_complex.h")],
  ["mtoc_min_complex", loadSnippet("min_complex.h")],
  ["mtoc_max_complex", loadSnippet("max_complex.h")],
  ["mtoc_angle_real", loadSnippet("angle_real.h")],
  // String runtime helpers. The struct typedef seeds the dependency
  // graph; literal / copy / concat / free / assign all pull it in.
  // `mtoc_string_alloc_bytes` is the char-buffer allocator (sibling
  // to `mtoc_alloc` for tensor data); copy and concat depend on it.
  // `disp` / `error` / `strcmp` / `string_concat` consume a
  // `mtoc_text_view_t`; the caller wraps either source struct via
  // `mtoc_text_from_string` / `mtoc_text_from_char_tensor` so a
  // single helper accepts both `string` and `char` arrays.
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
      "mtoc_text_view_t",
      "mtoc_string_alloc_bytes",
    ]),
  ],
  ["mtoc_string_free", loadSnippet("string_free.h", ["mtoc_string_t"])],
  [
    "mtoc_string_assign",
    loadSnippet("string_assign.h", ["mtoc_string_t", "mtoc_string_free"]),
  ],
  // Char-tensor runtime helpers. The struct typedef seeds the graph;
  // from_literal / empty / alloc / copy / free / assign / disp_char
  // all pull it in. Copy depends on alloc (for the heap buffer).
  // Free and assign are shape-agnostic (free(NULL) is well-defined).
  // disp_char is for scalar chars (bare C `char`); multi-element
  // char arrays route through `mtoc_disp_text` like strings.
  ["mtoc_char_tensor_t", MTOC_CHAR_TENSOR_STRUCT],
  [
    "mtoc_char_tensor_empty",
    loadSnippet("char_tensor_empty.h", ["mtoc_char_tensor_t"]),
  ],
  [
    "mtoc_char_tensor_from_literal",
    loadSnippet("char_tensor_from_literal.h", ["mtoc_char_tensor_t"]),
  ],
  [
    "mtoc_char_tensor_alloc",
    loadSnippet("char_tensor_alloc.h", ["mtoc_char_tensor_t"]),
  ],
  [
    "mtoc_char_tensor_copy",
    loadSnippet("char_tensor_copy.h", [
      "mtoc_char_tensor_t",
      "mtoc_char_tensor_alloc",
    ]),
  ],
  [
    "mtoc_char_tensor_free",
    loadSnippet("char_tensor_free.h", ["mtoc_char_tensor_t"]),
  ],
  [
    "mtoc_char_tensor_assign",
    loadSnippet("char_tensor_assign.h", [
      "mtoc_char_tensor_t",
      "mtoc_char_tensor_free",
    ]),
  ],
  ["mtoc_disp_char", loadSnippet("disp_char.h")],
  // Text-view runtime helpers. `mtoc_text_view_t` is the
  // {data, len} pair every "accepts text" helper consumes; the
  // adapters `mtoc_text_from_string` / `mtoc_text_from_char_tensor`
  // are inlined into the same snippet because they're tiny and
  // always travel together. `disp_text` / `error_text` /
  // `strcmp_text` / `assert_double_msg_text` are the unified
  // implementations.
  [
    "mtoc_text_view_t",
    loadSnippet("text_view.h", ["mtoc_string_t", "mtoc_char_tensor_t"]),
  ],
  ["mtoc_disp_text", loadSnippet("disp_text.h", ["mtoc_text_view_t"])],
  ["mtoc_error_text", loadSnippet("error_text.h", ["mtoc_text_view_t"])],
  ["mtoc_strcmp_text", loadSnippet("strcmp_text.h", ["mtoc_text_view_t"])],
  // `assert(cond)` runtime helper. Reads a real-scalar `cond` and
  // exits non-zero on failure, no-op on success. Has no struct
  // dependencies — the only headers it pulls are <math.h> for
  // `isnan`, plus stdio/stdlib for the abort path.
  ["mtoc_assert_double", loadSnippet("assert_double.h")],
  [
    "mtoc_assert_double_msg_text",
    loadSnippet("assert_double_msg_text.h", ["mtoc_text_view_t"]),
  ],
  // Format engine — shared walker that drives `fprintf` and `sprintf`,
  // mirroring numbl's `sprintfFormat` byte-for-byte. `fprintf.h`
  // writes to a FILE* sink; `sprintf.h` writes to a growable buffer
  // and returns an owned string / char-array depending on the format
  // arg's static type.
  [
    "mtoc_format_engine",
    loadSnippet("format_engine.h", [
      "mtoc_text_view_t",
      "mtoc_tensor_t",
      "mtoc_format_complex",
    ]),
  ],
  ["mtoc_fprintf", loadSnippet("fprintf.h", ["mtoc_format_engine"])],
  // `sprintf.h` defines BOTH `mtoc_sprintf_str` and `mtoc_sprintf_char`
  // (same idiom as `mtoc_rng` / `mtoc_tic`). Codegen activates the
  // umbrella key `mtoc_sprintf` regardless of which entry it emits in
  // the rendered C, so the snippet body is included exactly once.
  [
    "mtoc_sprintf",
    loadSnippet("sprintf.h", [
      "mtoc_format_engine",
      "mtoc_string_t",
      "mtoc_char_tensor_t",
    ]),
  ],
]);
