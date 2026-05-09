/* mtoc runtime helper: build a rows×cols real tensor from a flat
 * column-major data pointer. Codegen reorders the literal's
 * row-major source cells to column-major when it builds the
 * compound-literal array, so layout matches the rest of the runtime.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_from_matrix(
  const double *data, long rows, long cols
) {
  mtoc_tensor_t out = mtoc_tensor_alloc(rows, cols);
  memcpy(out.real, data, (size_t)(rows * cols) * sizeof(double));
  return out;
}
