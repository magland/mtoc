/* mtoc runtime helper: deep-copy a real tensor.
 *
 * The returned tensor owns a fresh `real` buffer (memcpy'd from the
 * source); `imag` is NULL since the caller statically knows the
 * source is real. Used by codegen to honor "copy on every
 * manipulation" — every tensor-by-name read and every user-function
 * tensor argument is wrapped in this helper, so the receiver always
 * gets an owned tensor.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_copy(mtoc_tensor_t src) {
  /* Struct copy preserves ndim and dims; the heap buffer is
   * replaced with a fresh allocation of the right total size. */
  mtoc_tensor_t out = src;
  long n = 1;
  for (int i = 0; i < src.ndim; i++) n *= src.dims[i];
  out.real = mtoc_alloc((size_t)n * sizeof(double));
  out.imag = NULL;
  memcpy(out.real, src.real, (size_t)n * sizeof(double));
  return out;
}
