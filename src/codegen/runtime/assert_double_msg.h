/* mtoc runtime helper: assert(cond, msg) — like mtoc_assert_double
 * but prints the user-supplied string on failure instead of the
 * generic "Assertion failed". Mirrors numbl's `assert(cond, msg)`
 * (the throw's message is the user-supplied one). The helper takes
 * `mtoc_string_t` by value; the caller still owns the buffer
 * (literal or owned), and on the success path nothing changes —
 * the helper neither writes nor frees.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void mtoc_assert_double_msg(double cond, mtoc_string_t msg) {
  if (cond == 0.0 || isnan(cond)) {
    if (msg.data && msg.len > 0) {
      fwrite(msg.data, 1, (size_t)msg.len, stderr);
    }
    fputc('\n', stderr);
    exit(1);
  }
}
