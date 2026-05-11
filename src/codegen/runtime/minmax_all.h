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
 * Both functions are generated from one macro; only the comparison
 * operator differs (< for min, > for max).
 */

#include <math.h>

/* Helper macro: expand a real min or max linear-scan reduction.
 * CMP is the comparison operator (< or >) that selects the winner. */
#define MTOC_MINMAX_REAL_ALL(FNAME, CMP)              \
static double FNAME(mtoc_tensor_t t) {                \
  long n = 1;                                         \
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];  \
  double m = 0.0;                                     \
  int found = 0;                                      \
  for (long i = 0; i < n; i++) {                     \
    double v = t.real[i];                             \
    if (v != v) continue;                             \
    if (!found || v CMP m) { m = v; found = 1; }     \
  }                                                   \
  return found ? m : NAN;                             \
}

MTOC_MINMAX_REAL_ALL(mtoc_min_real_all, <)
MTOC_MINMAX_REAL_ALL(mtoc_max_real_all, >)
#undef MTOC_MINMAX_REAL_ALL
