/* mtoc runtime helper: strcmp(a, b) for two char-tensor inputs.
 *
 * Mirrors numbl's `strcmp` semantics for two char arrays: byte-for-
 * byte equality returns 1.0, else 0.0. Empty × empty match (both
 * zero-length) returns 1.0. The result is a real scalar — numbl
 * exposes a logical, but mtoc represents logicals as `double` so
 * the call site can feed the result straight into arithmetic /
 * `assert` / `disp`.
 */

#include <string.h>

static double mtoc_strcmp_char_tensor(mtoc_char_tensor_t a, mtoc_char_tensor_t b) {
  long an = a.rows * a.cols;
  long bn = b.rows * b.cols;
  if (an != bn) return 0.0;
  if (an == 0) return 1.0;
  return memcmp(a.data, b.data, (size_t)an) == 0 ? 1.0 : 0.0;
}
