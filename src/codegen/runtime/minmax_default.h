/* mtoc runtime helpers: min(t) / max(t) along numbl's default
 * reduction dim — first non-singleton axis (1-based). Real variant.
 *
 * Used for statically-matrix inputs (≥2 non-singleton axes). NaN
 * elements within a fiber are skipped; if every element in a fiber is
 * NaN, that output slot is NaN — matches `minMaxScan` in numbl/src/
 * numbl-core/helpers/reduction/min-max.ts.
 *
 * See `sum_default.h` for the column-major fiber-walk rationale.
 */

#include <math.h>

static mtoc_tensor_t mtoc_min_real_default(mtoc_tensor_t t) {
  int dim = 0;
  for (int i = 0; i < t.ndim; i++) {
    if (t.dims[i] > 1) {
      dim = i + 1;
      break;
    }
  }
  if (dim == 0) {
    mtoc_tensor_t out = mtoc_tensor_alloc(1, 1);
    long n = 1;
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
    out.real[0] = n > 0 ? t.real[0] : NAN;
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
      double m = 0.0;
      int found = 0;
      for (long k = 0; k < reduceN; k++) {
        double v = t.real[slabBase + i + k * inner];
        if (v != v) continue;
        if (!found || v < m) {
          m = v;
          found = 1;
        }
      }
      out.real[out_idx++] = found ? m : NAN;
    }
  }
  return out;
}

static mtoc_tensor_t mtoc_max_real_default(mtoc_tensor_t t) {
  int dim = 0;
  for (int i = 0; i < t.ndim; i++) {
    if (t.dims[i] > 1) {
      dim = i + 1;
      break;
    }
  }
  if (dim == 0) {
    mtoc_tensor_t out = mtoc_tensor_alloc(1, 1);
    long n = 1;
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
    out.real[0] = n > 0 ? t.real[0] : NAN;
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
      double m = 0.0;
      int found = 0;
      for (long k = 0; k < reduceN; k++) {
        double v = t.real[slabBase + i + k * inner];
        if (v != v) continue;
        if (!found || v > m) {
          m = v;
          found = 1;
        }
      }
      out.real[out_idx++] = found ? m : NAN;
    }
  }
  return out;
}
