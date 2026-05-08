/* mtoc runtime helper: complex-scalar `min(a, b)`.
 *
 * Mirrors numbl's `complexIsBetter` (numbl/src/numbl-core/helpers/reduction/min-max.ts)
 * for the 2-scalar element-wise case:
 *   absA = sqrt(reA*reA + imA*imA);
 *   absB = sqrt(reB*reB + imB*imB);
 *   if (absA != absB) return absA < absB ? a : b;
 *   return atan2(imA, reA) < atan2(imB, reB) ? a : b;
 *
 * Uses `re*re + im*im` (not `hypot`) to match numbl exactly — overflow
 * behavior diverges from `hypot` but mtoc's contract is byte-for-byte
 * cross-runner equivalence.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_min_complex(double _Complex a, double _Complex b) {
  double aRe = creal(a), aIm = cimag(a);
  double bRe = creal(b), bIm = cimag(b);
  double absA = sqrt(aRe * aRe + aIm * aIm);
  double absB = sqrt(bRe * bRe + bIm * bIm);
  int pickA;
  if (absA != absB) pickA = absA < absB;
  else pickA = atan2(aIm, aRe) < atan2(bIm, bRe);
  return pickA ? a : b;
}
