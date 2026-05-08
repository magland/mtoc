/* mtoc runtime helper: complex log1p.
 *
 * Mirrors numbl's `complexLog1p`: log1p(z) = log(1 + z). Numbl
 * delegates straight to `complexLog(1 + re, im)`, so we do the same.
 */

#include <complex.h>

static double _Complex mtoc_clog1p(double _Complex z) {
  return clog(1.0 + z);
}
