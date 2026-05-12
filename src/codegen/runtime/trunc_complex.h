/* mtoc runtime helper: complex `fix` (truncate toward zero).
 *
 * C99 has no `ctrunc`. Numbl's `fix(z)` applies `trunc` componentwise:
 *   fix(z) = trunc(creal(z)) + trunc(cimag(z)) * I
 * Real-side `fix` maps to libm `trunc`; this is its complex sibling.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_trunc_complex(double _Complex z) {
  return trunc(creal(z)) + trunc(cimag(z)) * I;
}
