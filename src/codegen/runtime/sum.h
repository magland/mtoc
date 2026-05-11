/* mtoc runtime helper: sum(t) for a real vector tensor (row or column).
 *
 * Adds every element via a single linear loop; column- vs row-vector
 * doesn't matter because the buffer is one contiguous block. Restricted
 * to vectors at the lowering layer — matrix sum returns a row vector of
 * column sums in numbl, which needs a tensor-returning codegen path
 * that we don't have yet.
 *
 * Real-only today. A complex-typed sibling will land alongside complex
 * tensor support; the lowerer routes calls based on `isComplex`.
 */

static double mtoc_sum(mtoc_tensor_t t) {
  double s = 0.0;
  long n = t.dims[0] * t.dims[1];
  for (long i = 0; i < n; i++) s += t.real[i];
  return s;
}
