/* mtoc runtime helpers: 1-arg `min(t)` / `max(t)` over a real tensor.
 *
 * Numbl's `minMaxScanDirect` semantics (numbl/src/numbl-core/helpers/
 * reduction/min-max.ts): NaN elements are skipped. The result is the
 * first non-NaN value beaten by every other non-NaN value; if every
 * element is NaN, the result is NaN.
 *
 * Mtoc's lowerer routes these through static-shape dispatch:
 *   - scalar input → identity (call site never reached).
 *   - vector-like input (≤1 non-singleton axis) → this helper.
 *   - matrix input (≥2 non-singleton axes) → `mtoc_min_real_default`
 *     / `mtoc_max_real_default`.
 *
 * Real-only — complex sibling lives in `minmax_complex_all.h`.
 */

#include <math.h>

static double mtoc_min_real_all(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double m = 0.0;
  int found = 0;
  for (long i = 0; i < n; i++) {
    double v = t.real[i];
    if (v != v) continue;
    if (!found || v < m) {
      m = v;
      found = 1;
    }
  }
  return found ? m : NAN;
}

static double mtoc_max_real_all(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double m = 0.0;
  int found = 0;
  for (long i = 0; i < n; i++) {
    double v = t.real[i];
    if (v != v) continue;
    if (!found || v > m) {
      m = v;
      found = 1;
    }
  }
  return found ? m : NAN;
}
