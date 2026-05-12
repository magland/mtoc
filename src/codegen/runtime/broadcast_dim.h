/* mtoc runtime helper: per-axis broadcast validator.
 *
 * Returns the broadcast result of two axis sizes under MATLAB's
 * implicit-expansion rule:
 *   - a == b              → a   (same size; no expansion)
 *   - a == 1              → b   (a broadcasts to b)
 *   - b == 1              → a   (b broadcasts to a)
 *   - else                → abort (sizes are not broadcast-compatible)
 *
 * Codegen calls this once per output axis, chaining across N operands:
 *   long _mtoc_d0 = mtoc_broadcast_dim(
 *                     mtoc_broadcast_dim(A.dims[0], B.dims[0]),
 *                     C.dims[0]);
 */

#include <stdio.h>
#include <stdlib.h>

static long mtoc_broadcast_dim(long a, long b) {
  if (a == b) return a;
  if (a == 1) return b;
  if (b == 1) return a;
  fprintf(stderr,
    "mtoc: shape mismatch in elementwise broadcast - "
    "axis sizes %ld and %ld are not broadcast-compatible\n",
    a, b);
  abort();
}
