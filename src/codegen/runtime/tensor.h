/* mtoc tensor runtime: the single C representation for every
 * multi-element tensor mtoc emits.
 *
 * Storage mirrors numbl's split layout — `real` and `imag` are
 * separate Float64 buffers (not interleaved real/imag pairs). For a
 * statically-real tensor, `imag` is NULL: the type system tracks
 * `isComplex` at compile time, so codegen knows up front whether to
 * touch the imag side. There is no runtime branch on `imag != NULL`.
 *
 * Scalars never use this struct — real scalars are bare `double`,
 * complex scalars are `double _Complex`. Anything with rows*cols > 1
 * (or with a non-exact dim) gets one `mtoc_tensor_t` value. The data
 * buffers are column-major to match MATLAB / LAPACK.
 *
 * For statically-sized tensors today, `real` (and `imag`, when
 * complex) point at stack-allocated arrays declared next to the
 * struct — no heap allocation, no cleanup. When dynamic-size support
 * arrives we will fall back to an arena per call frame; the struct
 * shape stays the same.
 *
 * The `MTOC_RESTRICT` qualifier on the buffer pointers tells the
 * compiler that distinct `mtoc_tensor_t` values' buffers do not
 * alias each other. It expands to `__restrict__` under GCC/Clang
 * and to nothing on compilers that don't recognize it.
 */

#ifndef MTOC_RESTRICT
# if defined(__GNUC__) || defined(__clang__)
#  define MTOC_RESTRICT __restrict__
# else
#  define MTOC_RESTRICT
# endif
#endif

typedef struct {
  double *MTOC_RESTRICT real;   /* always non-NULL */
  double *MTOC_RESTRICT imag;   /* NULL iff the tensor is statically real */
  long rows;
  long cols;
} mtoc_tensor_t;
