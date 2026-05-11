/* mtoc runtime helper: allocate an uninitialized real tensor with
 * an arbitrary N-D shape.
 *
 * Used by codegen for builtins that produce a >2-D result (the
 * canonical case is `reshape(A, d1, d2, ..., dN)`). The 2-D fast
 * path lives in `mtoc_tensor_alloc`; this helper is the variadic
 * N-D sibling that copies `ndim` dim sizes from the caller-supplied
 * `dims` array into the struct.
 *
 * `dims` is consumed read-only — the caller may pass a stack
 * `(long[]){…}` compound literal. The returned tensor owns its
 * `real` buffer; `imag` is NULL (the static-real marker). Aborts
 * on `ndim` exceeding the inline `MTOC_MAX_NDIM` cap.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static mtoc_tensor_t mtoc_tensor_alloc_nd(int ndim, const long *dims) {
  if (ndim > MTOC_MAX_NDIM) {
    fprintf(stderr,
      "mtoc: tensor ndim %d exceeds MTOC_MAX_NDIM=%d\n", ndim, MTOC_MAX_NDIM);
    abort();
  }
  mtoc_tensor_t out;
  size_t n = 1;
  for (int i = 0; i < ndim; i++) {
    out.dims[i] = dims[i];
    size_t new_n;
#if defined(__has_builtin) && __has_builtin(__builtin_mul_overflow)
    if (__builtin_mul_overflow(n, (size_t)dims[i], &new_n)) {
      fprintf(stderr,
        "mtoc: tensor allocation overflow at dim %d (size %ld)\n", i, dims[i]);
      abort();
    }
#else
    if ((size_t)dims[i] != 0 && n > (SIZE_MAX / sizeof(double)) / (size_t)dims[i]) {
      fprintf(stderr,
        "mtoc: tensor allocation overflow at dim %d (size %ld)\n", i, dims[i]);
      abort();
    }
    new_n = n * (size_t)dims[i];
#endif
    n = new_n;
  }
  out.ndim = ndim;
  out.real = mtoc_alloc(n * sizeof(double));
  out.imag = NULL;
  return out;
}
