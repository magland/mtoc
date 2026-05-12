/* mtoc runtime helper: build a row-vector tensor from a numbl-style
 * range `start : step : end`. Mirrors numbl's `makeRangeTensor` in
 * `runtime/tensor-construction.ts`:
 *
 *   - element count `n = mtoc_loop_count(start, end, step)`
 *     (matches numbl's `floor((end - start)/step) + 1`, clamped to 0
 *     on empty / non-finite / step=0 cases),
 *   - allocate a 1×n tensor (n may be 0; the alloc handles that),
 *   - fill `values[i] = start + i * step` to avoid the accumulated
 *     error of an additive walk,
 *   - if there are ≥ 2 elements and the last computed slot is within
 *     `|step| * 1e-10` of `end`, snap it to exactly `end` so e.g.
 *     `0:0.1:1` ends at `1.0` rather than `0.9999999999999999`.
 *
 * Always returns a freshly-owned tensor; caller releases via
 * `mtoc_tensor_assign` or `mtoc_tensor_free`.
 */

static mtoc_tensor_t mtoc_make_range(double start, double step, double end) {
  long n = mtoc_loop_count(start, end, step);
  mtoc_tensor_t out = mtoc_tensor_alloc(1, n);
  for (long i = 0; i < n; i++) {
    out.real[i] = start + (double)i * step;
  }
  if (n > 1) {
    double last_computed = start + (double)(n - 1) * step;
    double abs_step = step < 0 ? -step : step;
    double diff = last_computed - end;
    if (diff < 0) diff = -diff;
    if (diff < abs_step * 1e-10) {
      out.real[n - 1] = end;
    }
  }
  return out;
}
