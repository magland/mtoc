/* mtoc runtime helper: nan(d1, d2, …, dN) — N-D tensor filled with
 * NaN. Used for numbl's `nan(...)` / `NaN(...)` constructor builtins.
 */

#include <math.h>

static mtoc_tensor_t mtoc_nan_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  for (long i = 0; i < n; i++) out.real[i] = NAN;
  return out;
}
