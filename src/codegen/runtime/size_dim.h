/* mtoc runtime helper: size(t, dim) — scalar form returning the
 * length of axis `dim` (1-indexed). For `dim > t.ndim` returns 1
 * (matching numbl's "implicit trailing singletons" semantics). For
 * `dim < 1` returns 0 (numbl raises; mtoc opts for the lenient
 * MATLAB-like result rather than aborting).
 */

static double mtoc_size_dim(mtoc_tensor_t t, double dim) {
  long d = (long)dim;
  if (d < 1) return 0.0;
  if (d <= t.ndim) return (double)t.dims[d - 1];
  return 1.0;
}
