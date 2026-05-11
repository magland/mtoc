/* mtoc runtime: fiber-walk scaffold macros for axis reductions.
 *
 * These macros generate the full body of a static function that reduces a
 * tensor along numbl's "default" dimension (first non-singleton axis,
 * 1-based). They are shared by sum_default.h, sum_complex_default.h,
 * minmax_default.h, and minmax_complex_default.h to avoid repeating the
 * identical outer/inner loop scaffolding in each file.
 *
 * Usage:
 *   MTOC_REDUCTION_WALK_REAL(FNAME, SINGLETON_VAL, INIT_ACC, INNER_BODY, WRITE_OUT)
 *   MTOC_REDUCTION_WALK_COMPLEX(FNAME, SINGLETON_RE, SINGLETON_IM, INIT_ACC, INNER_BODY, WRITE_OUT)
 *
 * Parameters (all must be comma-free unless commas are inside parentheses):
 *   FNAME         - C function name
 *   SINGLETON_VAL - expression for out.real[0] when every dim is 1 (real)
 *   SINGLETON_RE  - expression for out.real[0] in the all-singletons case (complex)
 *   SINGLETON_IM  - expression for out.imag[0] in the all-singletons case (complex)
 *   INIT_ACC      - declarations + initialization of accumulator variables;
 *                   must not contain unprotected commas
 *   INNER_BODY    - body of the innermost k-loop; has slabBase, i, k, inner
 *                   in scope; may use `continue` to skip the current k
 *   WRITE_OUT     - write accumulator to out and advance out_idx
 *
 * The macros are left defined after use (prefixed MTOC_ to avoid collisions);
 * call sites may #undef their own helper macros built on top of these.
 */

/* --- Real output tensor -------------------------------------------------- */

#define MTOC_REDUCTION_WALK_REAL(FNAME, SINGLETON_VAL, INIT_ACC, INNER_BODY, WRITE_OUT) \
static mtoc_tensor_t FNAME(mtoc_tensor_t t) { \
  int dim = 0; \
  for (int i = 0; i < t.ndim; i++) { \
    if (t.dims[i] > 1) { dim = i + 1; break; } \
  } \
  if (dim == 0) { \
    mtoc_tensor_t out = mtoc_tensor_alloc(1, 1); \
    long n = 1; \
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i]; \
    out.real[0] = SINGLETON_VAL; \
    return out; \
  } \
  long out_dims[MTOC_MAX_NDIM]; \
  int out_ndim = t.ndim; \
  for (int i = 0; i < t.ndim; i++) out_dims[i] = t.dims[i]; \
  out_dims[dim - 1] = 1; \
  while (out_ndim > 2 && out_dims[out_ndim - 1] == 1) out_ndim--; \
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(out_ndim, out_dims); \
  long reduceN = t.dims[dim - 1]; \
  long inner = 1; \
  for (int d = 0; d < dim - 1; d++) inner *= t.dims[d]; \
  long slab = inner * reduceN; \
  long total = 1; \
  for (int d = 0; d < t.ndim; d++) total *= t.dims[d]; \
  long outer_count = slab > 0 ? total / slab : 0; \
  long out_idx = 0; \
  for (long o = 0; o < outer_count; o++) { \
    long slabBase = o * slab; \
    for (long i = 0; i < inner; i++) { \
      INIT_ACC \
      for (long k = 0; k < reduceN; k++) { INNER_BODY } \
      WRITE_OUT \
    } \
  } \
  return out; \
}

/* --- Split-lane complex output tensor ------------------------------------ */

#define MTOC_REDUCTION_WALK_COMPLEX(FNAME, SINGLETON_RE, SINGLETON_IM, INIT_ACC, INNER_BODY, WRITE_OUT) \
static mtoc_tensor_t FNAME(mtoc_tensor_t t) { \
  int dim = 0; \
  for (int i = 0; i < t.ndim; i++) { \
    if (t.dims[i] > 1) { dim = i + 1; break; } \
  } \
  if (dim == 0) { \
    long _sdims[2] = {1, 1}; \
    mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(2, _sdims); \
    long n = 1; \
    for (int i = 0; i < t.ndim; i++) n *= t.dims[i]; \
    out.real[0] = SINGLETON_RE; \
    out.imag[0] = SINGLETON_IM; \
    return out; \
  } \
  long out_dims[MTOC_MAX_NDIM]; \
  int out_ndim = t.ndim; \
  for (int i = 0; i < t.ndim; i++) out_dims[i] = t.dims[i]; \
  out_dims[dim - 1] = 1; \
  while (out_ndim > 2 && out_dims[out_ndim - 1] == 1) out_ndim--; \
  mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(out_ndim, out_dims); \
  long reduceN = t.dims[dim - 1]; \
  long inner = 1; \
  for (int d = 0; d < dim - 1; d++) inner *= t.dims[d]; \
  long slab = inner * reduceN; \
  long total = 1; \
  for (int d = 0; d < t.ndim; d++) total *= t.dims[d]; \
  long outer_count = slab > 0 ? total / slab : 0; \
  long out_idx = 0; \
  for (long o = 0; o < outer_count; o++) { \
    long slabBase = o * slab; \
    for (long i = 0; i < inner; i++) { \
      INIT_ACC \
      for (long k = 0; k < reduceN; k++) { INNER_BODY } \
      WRITE_OUT \
    } \
  } \
  return out; \
}
