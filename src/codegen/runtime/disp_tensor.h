/* mtoc runtime helper: disp(t) for a multi-element real tensor.
 *
 * Mirrors numbl's `format2DSlice` for 2D tensors:
 *   - elements are formatted via mtoc_format_double
 *   - each column is padded to its widest element via padStart
 *   - rows are separated by '\n', columns by 3 spaces, 3-space indent
 *
 * Allocation: per-call malloc for the formatted-string buffer and the
 * column-width array. Both freed on return. The disp path is not on
 * the hot path of typical numerical code, so the simplicity is worth
 * the alloc.
 *
 * Real-only today. A complex-tensor disp variant will land with
 * complex tensor support; the lowerer dispatches on `isComplex`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void mtoc_disp_tensor(mtoc_tensor_t t) {
  long rows = t.rows;
  long cols = t.cols;
  if (rows <= 0 || cols <= 0) {
    /* Empty tensor — match numbl's "[]" rendering for now. */
    printf("[]\n");
    return;
  }

  enum { CELL_CAP = 32 };
  long ncells = rows * cols;
  char *cells = (char *)malloc((size_t)ncells * CELL_CAP);
  long *col_widths = (long *)calloc((size_t)cols, sizeof(long));
  if (!cells || !col_widths) {
    free(cells);
    free(col_widths);
    fprintf(stderr, "mtoc: out of memory in mtoc_disp_tensor\n");
    return;
  }

  for (long c = 0; c < cols; c++) {
    for (long r = 0; r < rows; r++) {
      long idx = r + c * rows;
      char *cell = cells + idx * CELL_CAP;
      mtoc_format_double(cell, CELL_CAP, t.real[idx]);
      long len = (long)strlen(cell);
      if (len > col_widths[c]) col_widths[c] = len;
    }
  }

  for (long r = 0; r < rows; r++) {
    fputs("   ", stdout);
    for (long c = 0; c < cols; c++) {
      long idx = r + c * rows;
      char *cell = cells + idx * CELL_CAP;
      long len = (long)strlen(cell);
      for (long i = 0; i < col_widths[c] - len; i++) putchar(' ');
      fputs(cell, stdout);
      if (c < cols - 1) fputs("   ", stdout);
    }
    putchar('\n');
  }

  free(cells);
  free(col_widths);
}
