/* mtoc runtime helper: zeros(d1, d2, …, dN) — N-D tensor filled
 * with 0.0. Used by both the 2-D (`zeros(rows, cols)`) and N-D
 * forms; the 1-arg form `zeros(N)` is lowered as a 2-arg call
 * `zeros(N, N)` in codegen, so this helper only needs the dims
 * array. Always returns a freshly-owned tensor.
 */

#include <string.h>

static mtoc_tensor_t mtoc_zeros_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  if (n > 0) memset(out.real, 0, (size_t)n * sizeof(double));
  return out;
}
