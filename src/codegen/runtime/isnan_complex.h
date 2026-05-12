/* mtoc runtime helper: `isnan(z)` for complex z.
 *
 * numbl semantics: true (1.0) iff EITHER the real or the imag lane
 * is NaN. The helper binds the argument to a local so a caller-side
 * Call expression (e.g. `isnan(csqrt(z))`) is evaluated exactly once.
 */

#include <complex.h>
#include <math.h>

static double mtoc_isnan_complex(double _Complex z) {
  return (isnan(creal(z)) || isnan(cimag(z))) ? 1.0 : 0.0;
}
