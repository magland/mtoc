/* mtoc tensor runtime: the single C representation for every
 * multi-element tensor mtoc emits.
 *
 * Scalars never use this struct — they stay as bare `double`. Anything
 * with rows*cols > 1 (or with a non-exact dim) gets one `mtoc_tensor_t`
 * value. The data buffer is column-major to match MATLAB / LAPACK.
 *
 * For statically-sized tensors today, `data` points at a stack-allocated
 * `double[rows*cols]` array declared next to the struct, so no heap
 * allocation is required and there is no cleanup. When dynamic-size
 * support arrives, we'll switch to an arena-backed allocation per
 * function call; the struct shape stays the same.
 */

typedef struct {
  double *data;
  long rows;
  long cols;
} mtoc_tensor_t;
