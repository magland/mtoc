/* mtoc runtime helper: sum(t) — reduce a complex tensor to a scalar.
 *
 * Sums real and imag lanes independently (addition commutes/distributes
 * over the lane split, so the two lanes are independent for `sum`). Same
 * vector-like-shape contract as `mtoc_sum`; the tensor-returning sibling
 * `mtoc_sum_complex_default` handles statically-matrix inputs.
 */

#include <complex.h>

static double _Complex mtoc_sum_complex(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double sr = 0.0;
  double si = 0.0;
  for (long i = 0; i < n; i++) {
    sr += t.real[i];
    si += t.imag[i];
  }
  return sr + si * I;
}
