/* mtoc runtime helper: build a rows×cols complex tensor from two
 * flat column-major data pointers. Mirrors `mtoc_tensor_from_matrix`
 * for the complex case.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_from_matrix_complex(
  const double *re, const double *im, long rows, long cols
) {
  mtoc_tensor_t out = mtoc_tensor_alloc_complex(rows, cols);
  memcpy(out.real, re, (size_t)(rows * cols) * sizeof(double));
  memcpy(out.imag, im, (size_t)(rows * cols) * sizeof(double));
  return out;
}
