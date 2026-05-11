/* mtoc runtime helper: rand(d1, d2, …, dN) — N-D tensor filled with
 * U(0, 1) samples from the xoshiro128** PRNG. Matches numbl's
 * seeded `rand` byte-for-byte (see `rng.h`). The 0-arg scalar form
 * `rand()` emits `mtoc_rng_random()` directly; this helper is for
 * the variadic form.
 */

static mtoc_tensor_t mtoc_rand_nd(int ndim, const long *dims) {
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(ndim, dims);
  long n = 1;
  for (int i = 0; i < ndim; i++) n *= dims[i];
  for (long i = 0; i < n; i++) out.real[i] = mtoc_rng_random();
  return out;
}
