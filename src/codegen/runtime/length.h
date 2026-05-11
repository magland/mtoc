/* mtoc runtime helper: length(t) — numbl's `length`.
 *
 * Returns the largest dim size for a non-empty tensor, or 0 if any
 * dim is 0 (empty tensor). Returned as a double to match every other
 * mtoc value. Generalized over `ndim` so the same body covers 2-D
 * and N-D tensors.
 */

static double mtoc_length(mtoc_tensor_t t) {
  long m = 0;
  for (int i = 0; i < t.ndim; i++) {
    if (t.dims[i] == 0) return 0.0;
    if (t.dims[i] > m) m = t.dims[i];
  }
  return (double)m;
}
