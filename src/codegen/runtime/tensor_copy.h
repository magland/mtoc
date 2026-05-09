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
  mtoc_tensor_t out = mtoc_tensor_alloc(src.rows, src.cols);
  long n = src.rows * src.cols;
  memcpy(out.real, src.real, (size_t)n * sizeof(double));
  return out;
}
