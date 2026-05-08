/* mtoc runtime helper: MATLAB's `sign(z)` for complex z.
 *
 * Mirrors numbl's complex sign (numbl/src/numbl-core/interpreter/builtins/math.ts):
 *   mag = hypot(re, im)
 *   if (mag == 0) return 0+0i
 *   return (re/mag) + (im/mag)*i
 *
 * Using `hypot` (rather than `cabs(z)`, which is implementation-defined)
 * keeps the magnitude finite when re*re or im*im would overflow. The
 * 0+0i carve-out matches numbl exactly so a `sign(0+0i)` literal prints
 * "0" not "NaN" cross-runner.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_sign_complex(double _Complex z) {
  double re = creal(z);
  double im = cimag(z);
  double mag = hypot(re, im);
  if (mag == 0.0) return 0.0 + 0.0 * I;
  return (re / mag) + (im / mag) * I;
}
