/* mtoc runtime helper: ones(d1, d2, …, dN) — N-D tensor filled
 * with 1.0. Mirrors `mtoc_zeros_nd` but loop-fills with 1s rather
 * than memset-zeroing.
 */

static mtoc_tensor_t mtoc_ones_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  for (long i = 0; i < n; i++) out.real[i] = 1.0;
  return out;
}
