/* mtoc runtime helper: sum(t) for a vector tensor (row or column).
 *
 * Adds every element via a single linear loop; column- vs row-vector
 * doesn't matter because the data buffer is one contiguous block.
 * Restricted to vectors at the lowering layer — matrix sum returns a
 * row vector of column sums in MATLAB, which needs a tensor-returning
 * codegen path that we don't have yet.
 */

static double mtoc_sum(mtoc_tensor_t t) {
  double s = 0.0;
  long n = t.rows * t.cols;
  for (long i = 0; i < n; i++) s += t.data[i];
  return s;
}
