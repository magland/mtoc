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
  int ok = (a.ndim == b.ndim);
  for (int i = 0; ok && i < a.ndim; i++) ok = (a.dims[i] == b.dims[i]);
  if (ok) return;
  /* Preserve the 2-D-style message verbatim for the common case so
   * existing test scripts compare equal byte-for-byte; the N-D path
   * uses a list-style format. */
  if (a.ndim == 2 && b.ndim == 2) {
    fprintf(stderr,
      "mtoc: shape mismatch in elementwise op - "
      "got (%ld x %ld) and (%ld x %ld)\n",
      a.dims[0], a.dims[1], b.dims[0], b.dims[1]);
  } else {
    fprintf(stderr, "mtoc: shape mismatch in elementwise op - got (");
    for (int i = 0; i < a.ndim; i++) {
      fprintf(stderr, i == 0 ? "%ld" : "x%ld", a.dims[i]);
    }
    fprintf(stderr, ") and (");
    for (int i = 0; i < b.ndim; i++) {
      fprintf(stderr, i == 0 ? "%ld" : "x%ld", b.dims[i]);
    }
    fprintf(stderr, ")\n");
  }
  abort();
}
