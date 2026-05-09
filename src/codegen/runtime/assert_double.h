/* mtoc runtime helper: assert(cond) for a real-scalar condition.
 *
 * numbl's `assert(cond)` throws "Assertion failed" when cond is
 * boolean-false, zero, or NaN; the CLI surfaces the throw as a
 * non-zero exit. mtoc-emitted programs match by writing
 * "Assertion failed" to stderr and calling `exit(1)`. Success is a
 * silent no-op, so the rest of the program runs normally.
 *
 * The NaN check is explicit because C's truthiness (`if (x)`)
 * accepts NaN as truthy — numbl rejects NaN, and we want assert to
 * behave like numbl.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void mtoc_assert_double(double cond) {
  if (cond == 0.0 || isnan(cond)) {
    fprintf(stderr, "Assertion failed\n");
    exit(1);
  }
}
