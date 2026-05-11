/* mtoc runtime helper: disp(t) for a multi-element complex tensor.
 *
 * Mirrors numbl's `format2DSlice` for the isComplex==true branch
 * (numbl/src/numbl-core/runtime/display.ts):
 *   - elements are formatted via `mtoc_format_complex` over the
 *     `(real[idx], imag[idx])` pair (constructed as `re + im*I`)
 *   - each column is padded to its widest element via padStart
 *   - rows are separated by '\n', columns by 3 spaces, 3-space indent
 *
 * For `ndim > 2`, dispatches page-by-page exactly like
 * `mtoc_disp_tensor`: a `(:,:,k2,k3,...) =` header per slice and
 * blank-line separation between slices. Real-tensor disp lives in
 * `disp_tensor.h`; the codegen dispatcher picks one based on the
 * tensor's static `isComplex`.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <complex.h>

/* Render a single 2-D complex slice (rows × cols) starting at the
 * given real / imag pointers (caller advances past prior pages). */
static void mtoc__disp_complex_slice(
  const double *re, const double *im, long rows, long cols
) {
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
      double _Complex z = re[idx] + im[idx] * I;
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

static void mtoc_disp_tensor_complex(mtoc_tensor_t t) {
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
      if (p > 0) putchar('\n');
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
    mtoc__disp_complex_slice(
      t.real + p * page_size, t.imag + p * page_size, rows, cols
    );
  }
}
