/* mtoc runtime helper: assert(cond, msg) where msg is a char array
 * (numbl single-quoted: `assert(x > 0, 'x must be positive')`).
 * Same semantics as mtoc_assert_double_msg but reads the bytes from
 * a char-tensor handle instead of an mtoc_string_t. The caller still
 * owns the buffer.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static void mtoc_assert_double_msg_char(double cond, mtoc_char_tensor_t msg) {
  if (cond == 0.0 || isnan(cond)) {
    long n = msg.rows * msg.cols;
    if (msg.data && n > 0) {
      fwrite(msg.data, 1, (size_t)n, stderr);
    }
    fputc('\n', stderr);
    exit(1);
  }
}
