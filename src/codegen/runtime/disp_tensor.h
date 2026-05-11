/* mtoc runtime helper: disp(t) for a multi-element real tensor.
 *
 * Mirrors numbl's `format2DSlice` for the 2-D path and numbl's
 * page-by-page N-D rendering for `ndim > 2` (each 2-D slice prefixed
 * by a `(:,:,k2,k3,...) =` header and separated by a blank line):
 *   - elements are formatted via mtoc_format_double
 *   - each column is padded to its widest element via padStart
 *   - rows are separated by '\n', columns by 3 spaces, 3-space indent
 *
 * Allocation: per-slice malloc for the formatted-string buffer and
 * column-width array. Both freed before the next slice. The disp
 * path is not on the hot path of typical numerical code, so the
 * simplicity is worth the alloc.
 *
 * Real-only — complex-tensor disp lives in `disp_tensor_complex.h`;
 * the lowerer dispatches on `isComplex`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Render a single 2-D slice (rows × cols) starting at `data` (the
 * caller already advanced past prior pages). Each row ends with
 * '\n'; no leading or trailing framing — the caller adds page
 * headers / separators. */
static void mtoc__disp_real_slice(const double *data, long rows, long cols) {
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
      mtoc_format_double(cell, CELL_CAP, data[idx]);
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

static void mtoc_disp_tensor(mtoc_tensor_t t) {
  long rows = t.ndim >= 1 ? t.dims[0] : 1;
  long cols = t.ndim >= 2 ? t.dims[1] : 1;
  if (rows <= 0 || cols <= 0) {
    /* Empty tensor — match numbl's "[]" rendering. */
    printf("[]\n");
    return;
  }
  long page_size = rows * cols;
  long num_pages = 1;
  for (int i = 2; i < t.ndim; i++) num_pages *= t.dims[i];

  for (long p = 0; p < num_pages; p++) {
    if (t.ndim > 2) {
      /* Blank line between pages (after the previous slice's trailing
       * '\n'). For the very first page there is no leading separator. */
      if (p > 0) putchar('\n');
      /* Outer indices via column-major ind2sub (k2 changes fastest). */
      long rem = p;
      fputs("(:,:", stdout);
      for (int i = 2; i < t.ndim; i++) {
        long d = t.dims[i];
        long s = rem % d;
        rem /= d;
        printf(",%ld", s + 1);
      }
      fputs(") =\n\n", stdout);
    }
    mtoc__disp_real_slice(t.real + p * page_size, rows, cols);
  }
}
