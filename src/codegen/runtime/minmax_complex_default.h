/* mtoc runtime helpers: min(t) / max(t) along numbl's default
 * reduction dim — first non-singleton axis (1-based). Complex variant.
 *
 * Ordering: primary key magnitude `sqrt(re*re + im*im)`, ties broken
 * by angle `atan2(im, re)`. Matches `minMaxScan` in numbl exactly,
 * including the NaN-skip behavior (an element is skipped if either
 * lane is NaN; an all-skipped fiber outputs NaN + 0i).
 *
 * Scaffold via MTOC_REDUCTION_WALK_COMPLEX (reduction_walk.h).
 * Both functions are generated from one macro; only the comparison
 * operator differs (< for min, > for max) applied to both magnitude
 * and angle tiebreak.
 */

#include <complex.h>
#include <math.h>

/* Helper macro: expand a complex min or max fiber-walk function.
 * CMP is the comparison operator (< or >) applied to magnitude and angle. */
#define MTOC_MINMAX_COMPLEX_DEFAULT(FNAME, CMP)                                        \
  MTOC_REDUCTION_WALK_COMPLEX(FNAME,                                                   \
    n > 0 ? t.real[0] : NAN,                                                          \
    n > 0 ? t.imag[0] : 0.0,                                                          \
    double mRe = 0.0; double mIm = 0.0; double mMag = 0.0; double mAng = 0.0;        \
    int found = 0;,                                                                    \
    long idx = slabBase + i + k * inner;                                               \
    double re = t.real[idx];                                                           \
    double im = t.imag[idx];                                                           \
    if (re != re || im != im) continue;                                                \
    double mag = sqrt(re * re + im * im);                                              \
    double ang = atan2(im, re);                                                        \
    int better;                                                                        \
    if (!found) better = 1;                                                            \
    else if (mag != mMag) better = mag CMP mMag;                                      \
    else better = ang CMP mAng;                                                        \
    if (better) { mRe = re; mIm = im; mMag = mag; mAng = ang; found = 1; },          \
    if (!found) { out.real[out_idx] = NAN; out.imag[out_idx] = 0.0; }                \
    else { out.real[out_idx] = mRe; out.imag[out_idx] = mIm; }                       \
    out_idx++;                                                                         \
  )

MTOC_MINMAX_COMPLEX_DEFAULT(mtoc_min_complex_default, <)
MTOC_MINMAX_COMPLEX_DEFAULT(mtoc_max_complex_default, >)
#undef MTOC_MINMAX_COMPLEX_DEFAULT
