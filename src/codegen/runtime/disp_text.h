/* mtoc runtime helper: disp on a text view.
 *
 * Mirrors numbl's `displayValue` for string / char-array — the raw
 * bytes followed by a newline. Empty input prints just the newline.
 * Bytes are written verbatim through stdout so UTF-8 sequences pass
 * through cleanly. Used for both `disp("hi")` (string) and
 * `disp('hi')` (char array) — the caller wraps either source in
 * `mtoc_text_from_string` / `mtoc_text_from_char_tensor`.
 */

#include <stdio.h>

static void mtoc_disp_text(mtoc_text_view_t t) {
  if (t.data && t.len > 0) {
    fwrite(t.data, 1, (size_t)t.len, stdout);
  }
  putchar('\n');
}
