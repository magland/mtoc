/* mtoc runtime helper: MATLAB's `sign(x)`.
 *
 * Returns -1 / 0 / +1 according to the sign of x. Unlike `copysign`
 * (which returns ±|x| for any nonzero x), MATLAB's sign is ±1 for
 * nonzero. NaN propagates.
 */

#include <math.h>

static double mtoc_sign(double x) {
  if (isnan(x)) return x;
  if (x > 0.0) return 1.0;
  if (x < 0.0) return -1.0;
  return 0.0;
}
