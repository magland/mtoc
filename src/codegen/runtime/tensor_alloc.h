/* mtoc runtime helper: allocate an uninitialized real tensor of the
 * given shape. Sets `imag = NULL` (the static-real marker). The
 * returned tensor owns its `real` buffer; caller must release via
 * `mtoc_tensor_free` (or hand it to `mtoc_tensor_assign`, which takes
 * ownership).
 *
 * `mtoc_alloc` aborts on OOM, so the returned struct's `real` is
 * always non-NULL. Used by codegen as the workhorse for elementwise-
 * result construction at every multi-element Assign RHS that isn't a
 * plain tensor literal.
 */

static mtoc_tensor_t mtoc_tensor_alloc(long rows, long cols) {
  mtoc_tensor_t out;
  long n = rows * cols;
  out.real = mtoc_alloc(n * sizeof(double));
  out.imag = NULL;
  out.ndim = 2;
  out.dims[0] = rows;
  out.dims[1] = cols;
  return out;
}
