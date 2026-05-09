/* mtoc runtime helper: deep-copy a char tensor into a fresh heap buffer.
 *
 * Returns an owned copy of `src`. Used for `c = d;` where `d` is a
 * char-tensor variable — the copy lets `d` remain usable while giving
 * the new binding its own buffer to free independently.
 */

#include <string.h>

static mtoc_char_tensor_t mtoc_char_tensor_copy(mtoc_char_tensor_t src) {
  long n = src.rows * src.cols;
  mtoc_char_tensor_t out = mtoc_char_tensor_alloc(src.rows, src.cols);
  if (n > 0 && src.data) {
    memcpy(out.data, src.data, (size_t)n);
  }
  return out;
}
