/* mtoc runtime helper: allocate an uninitialized char tensor buffer.
 *
 * Returns a (rows × cols) char tensor that owns its `data` buffer.
 * The caller must eventually release it via `mtoc_char_tensor_free`
 * or `mtoc_char_tensor_assign`. Aborts with a clear diagnostic on OOM.
 */

#include <stdio.h>
#include <stdlib.h>

static mtoc_char_tensor_t mtoc_char_tensor_alloc(long rows, long cols) {
  mtoc_char_tensor_t t;
  long n = rows * cols;
  t.data = (char *)malloc((size_t)(n > 0 ? n : 1));
  if (!t.data) {
    fprintf(stderr, "mtoc: out of memory in mtoc_char_tensor_alloc\n");
    abort();
  }
  t.rows = rows;
  t.cols = cols;
  t.owned = 1;
  return t;
}
