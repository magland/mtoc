/* mtoc runtime helper: complex log10.
 *
 * C99 has no `clog10`. Mirrors numbl's `complexLog10`: re = log(|z|)/ln(10),
 * im = atan2(im, re)/ln(10). Equivalent to `clog(z) / log(10)`.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_clog10(double _Complex z) {
  return clog(z) / log(10.0);
}
