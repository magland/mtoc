/* mtoc runtime helper: `isfinite(z)` for complex z.
 *
 * numbl semantics: true (1.0) iff BOTH the real and imag lanes are
 * finite. The helper binds the argument to a local so a caller-side
 * Call expression is evaluated exactly once.
 */

#include <complex.h>
#include <math.h>

static double mtoc_isfinite_complex(double _Complex z) {
  return (isfinite(creal(z)) && isfinite(cimag(z))) ? 1.0 : 0.0;
}
