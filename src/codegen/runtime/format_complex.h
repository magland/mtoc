/* mtoc runtime helper: format a `double _Complex` value the same way
 * numbl's `formatComplex` does (numbl/src/numbl-core/runtime/display.ts),
 * into a caller-provided buffer.
 *
 * Branches mirror numbl exactly:
 *   - im == 0          → `<formatNumber(re)>`           (real-format path)
 *   - re == 0          → `<formatNumber(im)>i`          (pure imaginary)
 *   - im < 0           → `<formatNumber(re)> - <formatNumber(-im)>i`
 *   - else             → `<formatNumber(re)> + <formatNumber(im)>i`
 *
 * The spaces around the sign separator are part of the format and are
 * load-bearing for byte-for-byte cross-runner output.
 *
 * Returns the number of characters written (excluding trailing NUL),
 * matching `mtoc_format_double`'s contract.
 */

#include <stdio.h>
#include <complex.h>

static int mtoc_format_complex(char *out, size_t cap, double _Complex z) {
  double re = creal(z);
  double im = cimag(z);
  if (im == 0.0) {
    return mtoc_format_double(out, cap, re);
  }
  char re_buf[64];
  char im_buf[64];
  if (re == 0.0) {
    mtoc_format_double(im_buf, sizeof(im_buf), im);
    return snprintf(out, cap, "%si", im_buf);
  }
  mtoc_format_double(re_buf, sizeof(re_buf), re);
  if (im < 0.0) {
    mtoc_format_double(im_buf, sizeof(im_buf), -im);
    return snprintf(out, cap, "%s - %si", re_buf, im_buf);
  }
  mtoc_format_double(im_buf, sizeof(im_buf), im);
  return snprintf(out, cap, "%s + %si", re_buf, im_buf);
}
