/* mtoc runtime helpers: min(t) / max(t) along numbl's default
 * reduction dim — first non-singleton axis (1-based). Complex variant.
 *
 * Ordering: primary key magnitude `sqrt(re*re + im*im)`, ties broken
 * by angle `atan2(im, re)`. Matches `minMaxScan` in numbl exactly,
 * including the NaN-skip behavior (an element is skipped if either
 * lane is NaN; an all-skipped fiber outputs NaN + 0i).
 */

#include <complex.h>
#include <math.h>

static mtoc_tensor_t mtoc_min_complex_default(mtoc_tensor_t t) {
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
    out.real[0] = n > 0 ? t.real[0] : NAN;
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
      double mRe = 0.0, mIm = 0.0, mMag = 0.0, mAng = 0.0;
      int found = 0;
      for (long k = 0; k < reduceN; k++) {
        long idx = slabBase + i + k * inner;
        double re = t.real[idx], im = t.imag[idx];
        if (re != re || im != im) continue;
        double mag = sqrt(re * re + im * im);
        double ang = atan2(im, re);
        int better;
        if (!found) better = 1;
        else if (mag != mMag) better = mag < mMag;
        else better = ang < mAng;
        if (better) {
          mRe = re;
          mIm = im;
          mMag = mag;
          mAng = ang;
          found = 1;
        }
      }
      if (!found) {
        out.real[out_idx] = NAN;
        out.imag[out_idx] = 0.0;
      } else {
        out.real[out_idx] = mRe;
        out.imag[out_idx] = mIm;
      }
      out_idx++;
    }
  }
  return out;
}

static mtoc_tensor_t mtoc_max_complex_default(mtoc_tensor_t t) {
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
    out.real[0] = n > 0 ? t.real[0] : NAN;
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
      double mRe = 0.0, mIm = 0.0, mMag = 0.0, mAng = 0.0;
      int found = 0;
      for (long k = 0; k < reduceN; k++) {
        long idx = slabBase + i + k * inner;
        double re = t.real[idx], im = t.imag[idx];
        if (re != re || im != im) continue;
        double mag = sqrt(re * re + im * im);
        double ang = atan2(im, re);
        int better;
        if (!found) better = 1;
        else if (mag != mMag) better = mag > mMag;
        else better = ang > mAng;
        if (better) {
          mRe = re;
          mIm = im;
          mMag = mag;
          mAng = ang;
          found = 1;
        }
      }
      if (!found) {
        out.real[out_idx] = NAN;
        out.imag[out_idx] = 0.0;
      } else {
        out.real[out_idx] = mRe;
        out.imag[out_idx] = mIm;
      }
      out_idx++;
    }
  }
  return out;
}
