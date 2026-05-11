/* mtoc runtime helper: reshape a complex tensor. Mirrors
 * `mtoc_tensor_reshape` over both `real` and `imag` lanes.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static mtoc_tensor_t mtoc_tensor_reshape_complex(
  mtoc_tensor_t src, int ndim, const long *new_dims
) {
  long src_n = 1;
  for (int i = 0; i < src.ndim; i++) src_n *= src.dims[i];
  long dst_n = 1;
  for (int i = 0; i < ndim; i++) dst_n *= new_dims[i];
  if (src_n != dst_n) {
    fprintf(stderr,
      "mtoc: reshape size mismatch - source has %ld elements, target has %ld\n",
      src_n, dst_n);
    abort();
  }
  mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(ndim, new_dims);
  if (src_n > 0) {
    memcpy(out.real, src.real, (size_t)src_n * sizeof(double));
    memcpy(out.imag, src.imag, (size_t)src_n * sizeof(double));
  }
  return out;
}
