/* mtoc runtime helper: disp(c) for a multi-element char tensor.
 *
 * Mirrors numbl's displayValue for char arrays — prints the bytes as
 * raw text (NOT as numbers), followed by a newline. Empty arrays print
 * just the newline. Bytes are written as unsigned char to avoid sign-
 * extension artefacts on platforms where plain `char` is signed.
 */

#include <stdio.h>

static void mtoc_disp_char_tensor(mtoc_char_tensor_t t) {
  long n = t.rows * t.cols;
  if (t.data && n > 0) {
    long i;
    for (i = 0; i < n; i++) {
      putchar((unsigned char)t.data[i]);
    }
  }
  putchar('\n');
}
