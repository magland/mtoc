/* mtoc runtime helper: complex round.
 *
 * C99 has no `cround`. Numbl applies `round` (away-from-zero, like
 * MATLAB) componentwise:
 *   round(z) = round(creal(z)) + round(cimag(z)) * I
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_round_complex(double _Complex z) {
  return round(creal(z)) + round(cimag(z)) * I;
}
