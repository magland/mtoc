/* mtoc runtime helper: strcmp(a, b) for two string inputs.
 *
 * Same semantics as `mtoc_strcmp_char_tensor` but reads the
 * `mtoc_string_t` (data, len) pair instead of the char-tensor
 * (data, rows*cols). Returns 1.0 on byte-for-byte equality, 0.0
 * otherwise; empty × empty match returns 1.0.
 */

#include <string.h>

static double mtoc_strcmp_string(mtoc_string_t a, mtoc_string_t b) {
  long an = a.len > 0 ? a.len : 0;
  long bn = b.len > 0 ? b.len : 0;
  if (an != bn) return 0.0;
  if (an == 0) return 1.0;
  return memcmp(a.data, b.data, (size_t)an) == 0 ? 1.0 : 0.0;
}
