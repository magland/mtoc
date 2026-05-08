/* mtoc runtime helper: complex expm1.
 *
 * Mirrors numbl's `complexExpm1`: expm1(z) = exp(z) - 1. C99 has no
 * `cexpm1`, so we use cexp(z) - 1 directly. (For small |z| this loses
 * precision compared to a tailored series, but numbl uses the same
 * formula — matching numbl is the byte-for-byte requirement.)
 */

#include <complex.h>

static double _Complex mtoc_cexpm1(double _Complex z) {
  return cexp(z) - 1.0;
}
