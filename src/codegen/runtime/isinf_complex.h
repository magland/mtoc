/* mtoc runtime helper: `isinf(z)` for complex z.
 *
 * numbl semantics: true (1.0) iff EITHER the real or the imag lane
 * is infinite. The helper binds the argument to a local so a caller-
 * side Call expression is evaluated exactly once.
 */

#include <complex.h>
#include <math.h>

static double mtoc_isinf_complex(double _Complex z) {
  return (isinf(creal(z)) || isinf(cimag(z))) ? 1.0 : 0.0;
}
