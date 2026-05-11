/* mtoc runtime helper: fprintf — write formatted text to stdout.
 *
 * Matches numbl's `fprintf` semantics
 * (numbl/src/numbl-core/runtime/specialBuiltins.ts):
 *   - `fprintf(fmt, args...)`         → write to stdout
 *   - `fprintf(1, fmt, args...)`      → write to stdout
 *   - `fprintf(2, fmt, args...)`      → numbl ALSO routes fid=2 to its
 *     single `output` stream; mtoc matches by sending fid=2 to stdout
 *     too (cross-runner parity requires byte-for-byte stdout match).
 *
 * The fid is resolved at lowering (literal 1 or 2 only); the codegen
 * always emits `mtoc_fprintf(stdout, …)`. Other fids are deferred at
 * lowering with an UnsupportedConstruct span.
 *
 * Format engine is shared with sprintf — see `format_engine.h` for the
 * spec set, escape handling, and arg-cycling rules.
 */

#include <stdio.h>

static void mtoc__fprintf_writer(void *ctx, const char *bytes, long len) {
  if (len > 0) fwrite(bytes, 1, (size_t)len, (FILE *)ctx);
}

static void mtoc_fprintf(FILE *f, mtoc_text_view_t fmt,
                         int nargs, const mtoc_fprintf_arg_t *args) {
  mtoc__format_walk(mtoc__fprintf_writer, (void *)f, fmt, nargs, args);
}
