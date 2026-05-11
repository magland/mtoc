/* mtoc runtime helpers: min(t) / max(t) along numbl's default
 * reduction dim — first non-singleton axis (1-based). Real variant.
 *
 * Used for statically-matrix inputs (≥2 non-singleton axes). NaN
 * elements within a fiber are skipped; if every element in a fiber is
 * NaN, that output slot is NaN — matches `minMaxScan` in numbl/src/
 * numbl-core/helpers/reduction/min-max.ts.
 *
 * See `sum_default.h` for the column-major fiber-walk rationale.
 * Scaffold via MTOC_REDUCTION_WALK_REAL (reduction_walk.h).
 * Both functions are generated from one macro; only the comparison
 * operator differs (< for min, > for max).
 */

#include <math.h>

/* Helper macro: expand a real min or max fiber-walk function.
 * CMP is the comparison operator (< or >) that selects the winner. */
#define MTOC_MINMAX_REAL_DEFAULT(FNAME, CMP)                                    \
  MTOC_REDUCTION_WALK_REAL(FNAME,                                               \
    n > 0 ? t.real[0] : NAN,                                                   \
    double m = 0.0; int found = 0;,                                             \
    double v = t.real[slabBase + i + k * inner];                                \
    if (v != v) continue;                                                       \
    if (!found || v CMP m) { m = v; found = 1; },                              \
    out.real[out_idx++] = found ? m : NAN;                                      \
  )

MTOC_MINMAX_REAL_DEFAULT(mtoc_min_real_default, <)
MTOC_MINMAX_REAL_DEFAULT(mtoc_max_real_default, >)
#undef MTOC_MINMAX_REAL_DEFAULT
