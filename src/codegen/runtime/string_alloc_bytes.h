/* mtoc runtime helper: malloc wrapper for string buffers.
 *
 * Strings allocate `char` buffers (not `double`), so they have their
 * own thin wrapper rather than reusing `mtoc_alloc` (whose return
 * type is `double *`). Aborts with a clear diagnostic on allocation
 * failure so the call site can use the result directly.
 */

#include <stdio.h>
#include <stdlib.h>

static char *mtoc_string_alloc_bytes(long n_bytes) {
  char *p = (char *)malloc((size_t)n_bytes);
  if (!p) {
    fprintf(stderr,
            "mtoc: out of memory (mtoc_string_alloc_bytes requested %ld bytes)\n",
            n_bytes);
    abort();
  }
  return p;
}
