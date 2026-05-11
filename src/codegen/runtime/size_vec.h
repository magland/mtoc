/* mtoc runtime helper: size(t) — returns a 1×max(2,ndim) row vector
 * of dim sizes.
 *
 * Numbl pads ndim to a minimum of 2 in `size`'s output, so a row
 * vector reports `[1 N]` and a column reports `[N 1]` rather than
 * `[N]`. This helper applies the same padding by writing 1 for any
 * axis past `t.ndim`.
 *
 * Returned tensor is owned (`mtoc_tensor_alloc` allocates a fresh
 * `real` buffer); the caller releases it via `mtoc_tensor_assign`
 * / `mtoc_tensor_free` at scope exit.
 */

static mtoc_tensor_t mtoc_size_vec(mtoc_tensor_t t) {
  int n = t.ndim > 2 ? t.ndim : 2;
  mtoc_tensor_t out = mtoc_tensor_alloc(1, (long)n);
  for (int i = 0; i < n; i++) {
    out.real[i] = (double)(i < t.ndim ? t.dims[i] : 1);
  }
  return out;
}
