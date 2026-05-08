/* mtoc runtime helper: sum(t) for a complex vector tensor.
 *
 * Sums real and imag lanes independently and returns the result as
 * a `double _Complex`. Restricted to vectors at the lowering layer;
 * matrix sum needs a tensor-returning codegen path we don't have
 * yet. Real-vector sum lives in `sum.h`.
 */

#include <complex.h>

static double _Complex mtoc_sum_complex(mtoc_tensor_t t) {
  double sr = 0.0;
  double si = 0.0;
  long n = t.rows * t.cols;
  for (long i = 0; i < n; i++) {
    sr += t.real[i];
    si += t.imag[i];
  }
  return sr + si * I;
}
