/* mtoc runtime helper: error(s) — raise a runtime error and abort.
 *
 * numbl's `error(s)` throws a RuntimeError; the host harness prints
 * the message and exits non-zero. mtoc-emitted programs match by
 * writing the message to stderr (no special framing) and calling
 * `exit(1)`. The single-string form is supported; numbl's
 * `error(id, fmt, …)` shapes are deferred at lowering.
 */

#include <stdio.h>
#include <stdlib.h>

static void mtoc_error_string(mtoc_string_t s) {
  if (s.data && s.len > 0) {
    fwrite(s.data, 1, (size_t)s.len, stderr);
  }
  fputc('\n', stderr);
  exit(1);
}
