/* mtoc runtime helper: allocate an uninitialized complex tensor of
 * the given shape. Both `real` and `imag` buffers are mallocked; the
 * caller must release via `mtoc_tensor_free` (or hand the struct to
 * `mtoc_tensor_assign`, which takes ownership).
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static mtoc_tensor_t mtoc_tensor_alloc_complex(long rows, long cols) {
  mtoc_tensor_t out;
  size_t n;
#if defined(__has_builtin) && __has_builtin(__builtin_mul_overflow)
  if (__builtin_mul_overflow((size_t)rows, (size_t)cols, &n)) {
    fprintf(stderr,
      "mtoc: tensor allocation overflow (%ldx%ld elements)\n", rows, cols);
    abort();
  }
#else
  if ((size_t)cols != 0 && (size_t)rows > (SIZE_MAX / sizeof(double)) / (size_t)cols) {
    fprintf(stderr,
      "mtoc: tensor allocation overflow (%ldx%ld elements)\n", rows, cols);
    abort();
  }
  n = (size_t)rows * (size_t)cols;
#endif
  out.real = mtoc_alloc(n * sizeof(double));
  out.imag = mtoc_alloc(n * sizeof(double));
  out.ndim = 2;
  out.dims[0] = rows;
  out.dims[1] = cols;
  return out;
}
