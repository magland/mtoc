/* mtoc runtime helper: disp(c) for a scalar char (C `char`).
 *
 * Mirrors numbl's displayValue for a 1×1 char — prints the single
 * character as text (not as a number), followed by a newline.
 */

#include <stdio.h>

static void mtoc_disp_char(char c) {
  putchar((unsigned char)c);
  putchar('\n');
}
