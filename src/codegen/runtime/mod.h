/* mtoc runtime helper: MATLAB's `mod(a, b)`.
 *
 * MATLAB semantics: result has the same sign as `b` (or zero). C's
 * `fmod` truncates toward zero, so its result has the same sign as
 * `a`. We adjust by adding `b` whenever the signs differ. By
 * convention `mod(a, 0) == a`.
 */

#include <math.h>

static double mtoc_mod(double a, double b) {
  if (b == 0.0) return a;
  double r = fmod(a, b);
  if ((r > 0.0 && b < 0.0) || (r < 0.0 && b > 0.0)) {
    r += b;
  }
  return r;
}
