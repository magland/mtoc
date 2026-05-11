/* mtoc runtime helper: error(msg) — raise a runtime error and abort.
 *
 * numbl's `error(s)` throws a RuntimeError; the host harness prints
 * the message and exits non-zero. mtoc-emitted programs match by
 * writing the message to stderr (no special framing) and calling
 * `exit(1)`. Accepts either a string or a char array via the text
 * view; numbl's `error(id, fmt, ...)` shapes are deferred at lowering.
 */

#include <stdio.h>
#include <stdlib.h>

static void mtoc_error_text(mtoc_text_view_t t) {
  if (t.data && t.len > 0) {
    fwrite(t.data, 1, (size_t)t.len, stderr);
  }
  fputc('\n', stderr);
  exit(1);
}
