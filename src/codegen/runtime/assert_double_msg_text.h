/* mtoc runtime helper: assert(cond, msg) — like mtoc_assert_double
 * but prints the user-supplied text on failure. Accepts either a
 * string or a char array via the text view; matches numbl's
 * `assert(cond, msg)` where the throw's message is the user-supplied
 * one. On the success path nothing changes — the helper neither
 * writes nor frees.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void mtoc_assert_double_msg_text(double cond, mtoc_text_view_t msg) {
  if (cond == 0.0 || isnan(cond)) {
    if (msg.data && msg.len > 0) {
      fwrite(msg.data, 1, (size_t)msg.len, stderr);
    }
    fputc('\n', stderr);
    exit(1);
  }
}
