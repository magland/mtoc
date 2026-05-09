/* mtoc runtime helper: disp(s) for a string.
 *
 * Mirrors numbl's `displayValue` for strings — the raw text, no
 * leading "ans = " framing. Followed by a newline. Empty strings
 * print just the newline. Bytes are written verbatim through stdout
 * so UTF-8 sequences pass through cleanly.
 */

#include <stdio.h>

static void mtoc_disp_string(mtoc_string_t s) {
  if (s.data && s.len > 0) {
    fwrite(s.data, 1, (size_t)s.len, stdout);
  }
  putchar('\n');
}
