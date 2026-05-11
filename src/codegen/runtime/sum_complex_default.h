/* mtoc runtime helper: sum(t) along numbl's default reduction dim,
 * complex variant. See `sum_default.h` for the fiber-walk rationale.
 *
 * Real and imag lanes are summed independently — addition distributes
 * over the lane split (unlike multiplication, which needs the mixed
 * accumulator in `complexProd`).
 */

static mtoc_tensor_t mtoc_sum_complex_default(mtoc_tensor_t t) {
  int dim = 0;
  for (int i = 0; i < t.ndim; i++) {
    if (t.dims[i] > 1) {
      dim = i + 1;
      break;
    }
  }
  if (dim == 0) {
    mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(2, (long[]){1, 1});
    long n = 1;
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
    out.real[0] = n > 0 ? t.real[0] : 0.0;
    out.imag[0] = n > 0 ? t.imag[0] : 0.0;
    return out;
  }

  long out_dims[MTOC_MAX_NDIM];
  int out_ndim = t.ndim;
  for (int i = 0; i < t.ndim; i++) out_dims[i] = t.dims[i];
  out_dims[dim - 1] = 1;
  while (out_ndim > 2 && out_dims[out_ndim - 1] == 1) out_ndim--;
  mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(out_ndim, out_dims);

  long reduceN = t.dims[dim - 1];
  long inner = 1;
  for (int d = 0; d < dim - 1; d++) inner *= t.dims[d];
  long slab = inner * reduceN;
  long total = 1;
  for (int d = 0; d < t.ndim; d++) total *= t.dims[d];
  long outer_count = slab > 0 ? total / slab : 0;
  long out_idx = 0;
  for (long o = 0; o < outer_count; o++) {
    long slabBase = o * slab;
    for (long i = 0; i < inner; i++) {
      double sr = 0.0;
      double si = 0.0;
      for (long k = 0; k < reduceN; k++) {
        long idx = slabBase + i + k * inner;
        sr += t.real[idx];
        si += t.imag[idx];
      }
      out.real[out_idx] = sr;
      out.imag[out_idx] = si;
      out_idx++;
    }
  }
  return out;
}
