/* mtoc runtime helper: allocate an uninitialized complex tensor
 * with an arbitrary N-D shape. Mirrors `mtoc_tensor_alloc_nd`; both
 * `real` and `imag` lanes get fresh heap buffers.
 */

#include <stdio.h>
#include <stdlib.h>

static mtoc_tensor_t mtoc_tensor_alloc_nd_complex(int ndim, const long *dims) {
  if (ndim > MTOC_MAX_NDIM) {
    fprintf(stderr,
      "mtoc: tensor ndim %d exceeds MTOC_MAX_NDIM=%d\n", ndim, MTOC_MAX_NDIM);
    abort();
  }
  mtoc_tensor_t out;
  long n = 1;
  for (int i = 0; i < ndim; i++) {
    out.dims[i] = dims[i];
    n *= dims[i];
  }
  out.ndim = ndim;
  out.real = mtoc_alloc((size_t)n * sizeof(double));
  out.imag = mtoc_alloc((size_t)n * sizeof(double));
  return out;
}
