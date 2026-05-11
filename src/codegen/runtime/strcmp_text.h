/* mtoc runtime helper: strcmp on two text views.
 *
 * Mirrors numbl's `strcmp` semantics for two text values: byte-for-
 * byte equality returns 1.0, else 0.0. Empty × empty match (both
 * zero-length) returns 1.0. The result is a real scalar — numbl
 * exposes a logical, but mtoc represents logicals as `double` so
 * the call site can feed the result straight into arithmetic /
 * `assert` / `disp`. Inputs may be strings or char arrays in any
 * combination; the caller wraps each through
 * `mtoc_text_from_string` / `mtoc_text_from_char_tensor`.
 */

#include <string.h>

static double mtoc_strcmp_text(mtoc_text_view_t a, mtoc_text_view_t b) {
  if (a.len != b.len) return 0.0;
  if (a.len == 0) return 1.0;
  return memcmp(a.data, b.data, (size_t)a.len) == 0 ? 1.0 : 0.0;
}
