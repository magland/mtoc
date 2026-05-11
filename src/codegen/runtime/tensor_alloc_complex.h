/* mtoc runtime helper: allocate an uninitialized complex tensor of
 * the given shape. Both `real` and `imag` buffers are mallocked; the
 * caller must release via `mtoc_tensor_free` (or hand the struct to
 * `mtoc_tensor_assign`, which takes ownership).
 */

static mtoc_tensor_t mtoc_tensor_alloc_complex(long rows, long cols) {
  mtoc_tensor_t out;
  long n = rows * cols;
  out.real = mtoc_alloc(n * sizeof(double));
  out.imag = mtoc_alloc(n * sizeof(double));
  out.ndim = 2;
  out.dims[0] = rows;
  out.dims[1] = cols;
  return out;
}
