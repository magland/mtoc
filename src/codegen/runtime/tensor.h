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
 * complex scalars are `double _Complex`. Anything the type system
 * classifies as multi-element (any axis is `notOne`) gets one
 * `mtoc_tensor_t` value. The data buffers are column-major to match
 * MATLAB / LAPACK.
 *
 * Storage is heap-allocated via `mtoc_alloc` at every assignment
 * site. The struct is predeclared with `real = imag = NULL` and
 * `rows = cols = 0`; the first assignment populates them, and
 * subsequent reassignments at a different runtime shape free the
 * previous buffers and alloc fresh ones. `free` of the predeclared
 * NULLs is a no-op (well-defined by C), so the cleanup path is
 * uniform for first and subsequent assignments alike.
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
