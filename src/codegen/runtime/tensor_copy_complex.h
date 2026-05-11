/* mtoc runtime helper: deep-copy a complex tensor.
 *
 * Mirrors `mtoc_tensor_copy` for the complex case — both lanes are
 * mallocked and memcpy'd from the source.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_copy_complex(mtoc_tensor_t src) {
  /* Struct copy preserves ndim and dims; both lanes get fresh
   * heap buffers of the right total size. */
  mtoc_tensor_t out = src;
  long n = 1;
  for (int i = 0; i < src.ndim; i++) n *= src.dims[i];
  out.real = mtoc_alloc((size_t)n * sizeof(double));
  out.imag = mtoc_alloc((size_t)n * sizeof(double));
  memcpy(out.real, src.real, (size_t)n * sizeof(double));
  memcpy(out.imag, src.imag, (size_t)n * sizeof(double));
  return out;
}
