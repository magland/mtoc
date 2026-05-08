/* mtoc runtime helper: complex log2.
 *
 * C99 has no `clog2`. Numbl computes `log2(z)` as `log(z) / ln(2)`
 * using polar form: `re = log(|z|)/ln(2)`, `im = atan2(im,re)/ln(2)`.
 * That's exactly `clog(z) / log(2)`, so we delegate.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_clog2(double _Complex z) {
  return clog(z) / log(2.0);
}
