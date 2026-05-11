/* mtoc runtime helper: inf(d1, d2, …, dN) — N-D tensor filled with
 * +Infinity. Used for numbl's `inf(...)` / `Inf(...)` constructor
 * builtins.
 */

#include <math.h>

static mtoc_tensor_t mtoc_inf_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  for (long i = 0; i < n; i++) out.real[i] = (double)INFINITY;
  return out;
}
