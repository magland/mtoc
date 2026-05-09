/* mtoc runtime helper: malloc wrapper that aborts on allocation
 * failure with a clear diagnostic. Used for every tensor backing
 * buffer (mtoc allocates tensor storage uniformly on the heap so the
 * codegen path is exercised by every test, not just large ones).
 *
 * `n_bytes` is the size in bytes; the call site computes
 * `numel * sizeof(double)`. Returns a non-NULL pointer or aborts.
 */

#include <stdio.h>
#include <stdlib.h>

static double *mtoc_alloc(size_t n_bytes) {
  double *p = (double *)malloc(n_bytes);
  if (!p) {
    fprintf(stderr, "mtoc: out of memory (mtoc_alloc requested %zu bytes)\n",
            n_bytes);
    abort();
  }
  return p;
}
