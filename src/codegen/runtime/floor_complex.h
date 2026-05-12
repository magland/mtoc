/* mtoc runtime helper: complex floor.
 *
 * C99 has no `cfloor`. Numbl applies `floor` componentwise:
 *   floor(z) = floor(creal(z)) + floor(cimag(z)) * I
 * Helper binds the argument to a local so the operand is evaluated
 * exactly once even when the call site is a non-Var expression.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_floor_complex(double _Complex z) {
  return floor(creal(z)) + floor(cimag(z)) * I;
}
