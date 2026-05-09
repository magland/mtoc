/* mtoc runtime helper: deep-copy a complex tensor.
 *
 * Mirrors `mtoc_tensor_copy` for the complex case — both lanes are
 * mallocked and memcpy'd from the source.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_copy_complex(mtoc_tensor_t src) {
  mtoc_tensor_t out = mtoc_tensor_alloc_complex(src.rows, src.cols);
  long n = src.rows * src.cols;
  memcpy(out.real, src.real, (size_t)n * sizeof(double));
  memcpy(out.imag, src.imag, (size_t)n * sizeof(double));
  return out;
}
