/* mtoc runtime helper: randn(d1, d2, …, dN) — N-D tensor filled with
 * N(0, 1) samples via the Marsaglia polar method. Mirrors numbl's
 * seeded `randn` byte-for-byte (modulo any host-libm `sqrt` / `log`
 * implementation drift, which is normally bit-identical on
 * IEEE-754 platforms).
 */

static mtoc_tensor_t mtoc_randn_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  for (long i = 0; i < n; i++) out.real[i] = mtoc_rng_randn();
  return out;
}
