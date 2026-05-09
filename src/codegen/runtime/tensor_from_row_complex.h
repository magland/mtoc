/* mtoc runtime helper: build a 1×n complex tensor from two flat data
 * pointers (real lane and imaginary lane). Mirrors
 * `mtoc_tensor_from_row` for the complex case; codegen splits each
 * cell into its (re, im) components when materializing a complex
 * tensor literal.
 */

#include <string.h>

static mtoc_tensor_t mtoc_tensor_from_row_complex(
  const double *re, const double *im, long n
) {
  mtoc_tensor_t out = mtoc_tensor_alloc_complex(1, n);
  memcpy(out.real, re, (size_t)n * sizeof(double));
  memcpy(out.imag, im, (size_t)n * sizeof(double));
  return out;
}
