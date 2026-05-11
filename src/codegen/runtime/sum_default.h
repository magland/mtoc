/* mtoc runtime helper: sum(t) along numbl's default reduction dim —
 * the first non-singleton axis of `t` (1-based; matches
 * `firstReduceDim` in numbl/src/numbl-core/helpers/reduction-helpers.ts).
 *
 * Used for statically-matrix inputs: the lowerer routes
 * single-non-singleton-axis ("vector-like") shapes through the scalar-
 * returning `mtoc_sum` instead. Here we know at least two axes have a
 * statically-non-singleton size, so the result is a tensor (one axis
 * collapsed to 1, trailing singletons stripped to keep ndim >= 2).
 *
 * Column-major fiber walk: for each `outer` slab of `slab = inner *
 * reduceN` source elements, we sweep `reduceN` values along the reduce
 * axis (stride = inner) and write one accumulated value per inner
 * offset.
 */

static mtoc_tensor_t mtoc_sum_default(mtoc_tensor_t t) {
  /* Find the first non-singleton dim (1-based; 0 means "all singletons",
   * which the lowerer's static dispatch should have routed to mtoc_sum
   * — keep a defensive branch so we don't divide by zero if it reaches
   * us anyway). */
  int dim = 0;
  for (int i = 0; i < t.ndim; i++) {
    if (t.dims[i] > 1) {
      dim = i + 1;
      break;
    }
  }
  if (dim == 0) {
    /* Fully-singleton — every slot is the same element. Return a copy
     * sized 1×1 carrying the single value (or 0 if empty). */
    mtoc_tensor_t out = mtoc_tensor_alloc(1, 1);
    long n = 1;
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
    out.real[0] = n > 0 ? t.real[0] : 0.0;
    return out;
  }

  long out_dims[MTOC_MAX_NDIM];
  int out_ndim = t.ndim;
  for (int i = 0; i < t.ndim; i++) out_dims[i] = t.dims[i];
  out_dims[dim - 1] = 1;
  while (out_ndim > 2 && out_dims[out_ndim - 1] == 1) out_ndim--;
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(out_ndim, out_dims);

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
      double s = 0.0;
      for (long k = 0; k < reduceN; k++) s += t.real[slabBase + i + k * inner];
      out.real[out_idx++] = s;
    }
  }
  return out;
}
