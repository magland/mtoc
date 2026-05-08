/* mtoc runtime helper: disp(t) for a multi-element complex tensor.
 *
 * Mirrors numbl's `format2DSlice` for the isComplex==true branch
 * (numbl/src/numbl-core/runtime/display.ts):
 *   - elements are formatted via `mtoc_format_complex` over the
 *     `(real[idx], imag[idx])` pair (constructed as `re + im*I`)
 *   - each column is padded to its widest element via padStart
 *   - rows are separated by '\n', columns by 3 spaces, 3-space indent
 *
 * Real-tensor disp lives in `disp_tensor.h`; the codegen dispatcher
 * picks one based on the tensor's static `isComplex`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <complex.h>

static void mtoc_disp_tensor_complex(mtoc_tensor_t t) {
  long rows = t.rows;
  long cols = t.cols;
  if (rows <= 0 || cols <= 0) {
    /* Empty tensor — match numbl's "[]" rendering. */
    printf("[]\n");
    return;
  }

  /* CELL_CAP is sized for "<re> + <im>i" at 4-digit precision, plus
   * scientific-notation slack and the trailing 'i'. 64 is comfortable. */
  enum { CELL_CAP = 64 };
  long ncells = rows * cols;
  char *cells = (char *)malloc((size_t)ncells * CELL_CAP);
  long *col_widths = (long *)calloc((size_t)cols, sizeof(long));
  if (!cells || !col_widths) {
    free(cells);
    free(col_widths);
    fprintf(stderr, "mtoc: out of memory in mtoc_disp_tensor_complex\n");
    return;
  }

  for (long c = 0; c < cols; c++) {
    for (long r = 0; r < rows; r++) {
      long idx = r + c * rows;
      char *cell = cells + idx * CELL_CAP;
      double _Complex z = t.real[idx] + t.imag[idx] * I;
      mtoc_format_complex(cell, CELL_CAP, z);
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
