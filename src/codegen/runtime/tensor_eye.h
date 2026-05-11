/* mtoc runtime helper: eye(rows, cols) — 2-D rectangular identity
 * (1s on the main diagonal, 0s elsewhere). Numbl's column-major
 * convention places the (i, i) cell at `real[i + i * rows]`. The
 * 0-arg form `eye()` folds to the scalar literal `1.0` at lowering;
 * the 1-arg form `eye(n)` lowers as `eye(n, n)`. eye is 2-D-only —
 * extending to N-D identities doesn't have an obvious meaning.
 */

#include <string.h>

static mtoc_tensor_t mtoc_eye_2d(long rows, long cols) {
  mtoc_tensor_t out = mtoc_tensor_alloc(rows, cols);
  long n = rows * cols;
  if (n > 0) memset(out.real, 0, (size_t)n * sizeof(double));
  long min_rc = rows < cols ? rows : cols;
  for (long i = 0; i < min_rc; i++) {
    out.real[i + i * rows] = 1.0;
  }
  return out;
}
