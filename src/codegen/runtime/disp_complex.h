/* mtoc runtime helper: disp(z) for a complex-scalar `double _Complex`.
 *
 * Mirrors numbl's `displayValue` for the complex_number case
 * (numbl/src/numbl-core/runtime/display.ts) so cross-runner test output
 * matches. The actual formatting lives in `format_complex.h`; this
 * snippet only wraps it with a print + newline.
 */

#include <stdio.h>
#include <complex.h>

static void mtoc_disp_complex(double _Complex z) {
  char buf[128];
  mtoc_format_complex(buf, sizeof(buf), z);
  printf("%s\n", buf);
}
