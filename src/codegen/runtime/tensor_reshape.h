/* mtoc runtime helper: reshape a real tensor to a new N-D shape.
 *
 * Numbl semantics:
 *   - `numel(src)` must equal the product of `new_dims[0..ndim-1]`;
 *     mismatch aborts with a clear diagnostic.
 *   - Column-major data layout is preserved verbatim; the underlying
 *     buffer is byte-identical to `src.real`.
 *
 * Mtoc's ownership model: every tensor expression produces a
 * freshly-owned tensor, so this helper allocates a new buffer and
 * memcpy's the source data. The caller's `src` is independently
 * freed at its scope exit.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static mtoc_tensor_t mtoc_tensor_reshape(
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
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, new_dims);
  if (src_n > 0) memcpy(out.real, src.real, (size_t)src_n * sizeof(double));
  return out;
}
