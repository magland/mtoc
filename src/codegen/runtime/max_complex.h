/* mtoc runtime helper: complex-scalar `max(a, b)`.
 *
 * Mirrors numbl's `complexIsBetter` for the 2-scalar element-wise case:
 *   absA = sqrt(reA*reA + imA*imA);
 *   absB = sqrt(reB*reB + imB*imB);
 *   if (absA != absB) return absA > absB ? a : b;
 *   return atan2(imA, reA) > atan2(imB, reB) ? a : b;
 *
 * See `min_complex.h` for the byte-for-byte rationale.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_max_complex(double _Complex a, double _Complex b) {
  double aRe = creal(a), aIm = cimag(a);
  double bRe = creal(b), bIm = cimag(b);
  double absA = sqrt(aRe * aRe + aIm * aIm);
  double absB = sqrt(bRe * bRe + bIm * bIm);
  int pickA;
  if (absA != absB) pickA = absA > absB;
  else pickA = atan2(aIm, aRe) > atan2(bIm, bRe);
  return pickA ? a : b;
}
