/* mtoc runtime helpers: 1-arg `min(t)` / `max(t)` over a complex tensor.
 *
 * Numbl's complex ordering (numbl/src/numbl-core/helpers/reduction/
 * min-max.ts): primary key is magnitude; ties broken by angle
 * `atan2(im, re)`. An element is skipped if either lane is NaN; if
 * every element is skipped, the result is NaN + 0i.
 *
 * Magnitude is `sqrt(re*re + im*im)` (NOT `hypot`) to match numbl's
 * computation byte-for-byte — `hypot`'s overflow handling diverges
 * on extreme inputs.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_min_complex_all(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double mRe = 0.0, mIm = 0.0;
  double mMag = 0.0, mAng = 0.0;
  int found = 0;
  for (long i = 0; i < n; i++) {
    double re = t.real[i], im = t.imag[i];
    if (re != re || im != im) continue;
    double mag = sqrt(re * re + im * im);
    double ang = atan2(im, re);
    int better;
    if (!found) {
      better = 1;
    } else if (mag != mMag) {
      better = mag < mMag;
    } else {
      better = ang < mAng;
    }
    if (better) {
      mRe = re;
      mIm = im;
      mMag = mag;
      mAng = ang;
      found = 1;
    }
  }
  if (!found) return NAN + 0.0 * I;
  return mRe + mIm * I;
}

static double _Complex mtoc_max_complex_all(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double mRe = 0.0, mIm = 0.0;
  double mMag = 0.0, mAng = 0.0;
  int found = 0;
  for (long i = 0; i < n; i++) {
    double re = t.real[i], im = t.imag[i];
    if (re != re || im != im) continue;
    double mag = sqrt(re * re + im * im);
    double ang = atan2(im, re);
    int better;
    if (!found) {
      better = 1;
    } else if (mag != mMag) {
      better = mag > mMag;
    } else {
      better = ang > mAng;
    }
    if (better) {
      mRe = re;
      mIm = im;
      mMag = mag;
      mAng = ang;
      found = 1;
    }
  }
  if (!found) return NAN + 0.0 * I;
  return mRe + mIm * I;
}
