/* mtoc runtime helper: complex ceil.
 *
 * C99 has no `cceil`. Numbl applies `ceil` componentwise:
 *   ceil(z) = ceil(creal(z)) + ceil(cimag(z)) * I
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_ceil_complex(double _Complex z) {
  return ceil(creal(z)) + ceil(cimag(z)) * I;
}
