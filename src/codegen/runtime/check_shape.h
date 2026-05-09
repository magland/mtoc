/* mtoc runtime helper: shape-mismatch trap for elementwise binary
 * ops. After the dim-lattice coarsening (one | notOne | unknown), the
 * type system no longer rejects same-category mismatches like
 * `[1 2 3] + [4 5]` at lowering — they surface here. Codegen emits one
 * `mtoc_check_shape(<source>, <other>)` per distinct non-source multi-
 * element Var on the RHS, just before the staging-buffer alloc; if any
 * pair disagrees on `rows` or `cols`, the program aborts with a clear
 * diagnostic on stderr.
 *
 * The check is once-per-assign: the loop bound below comes from
 * `<source>`, so once the source is shape-compatible with every other
 * operand, every per-element read is in bounds.
 */

#include <stdio.h>
#include <stdlib.h>

static void mtoc_check_shape(mtoc_tensor_t a, mtoc_tensor_t b) {
  if (a.rows != b.rows || a.cols != b.cols) {
    fprintf(stderr,
      "mtoc: shape mismatch in elementwise op - "
      "got (%ld x %ld) and (%ld x %ld)\n",
      a.rows, a.cols, b.rows, b.cols);
    abort();
  }
}
