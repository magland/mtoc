/* mtoc runtime helper: numel(t) — total number of elements.
 *
 * Product across `dims[0..ndim-1]`. The struct invariant is
 * `ndim >= 2` for any tensor mtoc actually constructs (matching
 * numbl's min-2 padding), so the loop always executes at least
 * twice.
 */

static double mtoc_numel(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  return (double)n;
}
