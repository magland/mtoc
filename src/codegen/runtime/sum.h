/* mtoc runtime helper: sum(t) — reduce a real tensor to a scalar.
 *
 * Walks every element via a single linear loop over the flat buffer.
 * Numbl semantics for a "reduce to scalar" call (`firstReduceDim == 0`,
 * i.e. the tensor has at most one non-singleton axis: scalar, row vec,
 * column vec, or any N-D shape whose non-singleton axes collapse to a
 * vector). Generalized over `ndim` so the same body covers vectors and
 * any N-D "vector-like" shape.
 *
 * Real-only — the complex sibling lives in `sum_complex.h`. The
 * "tensor-returning, reduce-along-default-dim" sibling lives in
 * `sum_default.h` and is used for statically-matrix inputs.
 */

static double mtoc_sum(mtoc_tensor_t t) {
  long n = 1;
  for (int i = 0; i < t.ndim; i++) n *= t.dims[i];
  double s = 0.0;
  for (long i = 0; i < n; i++) s += t.real[i];
  return s;
}
