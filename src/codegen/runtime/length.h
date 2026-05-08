/* mtoc runtime helper: length(t) — MATLAB's `length`.
 *
 * Returns max(rows, cols) for a non-empty tensor, or 0 for an empty
 * one. Returned as a double to match every other mtoc value.
 */

static double mtoc_length(mtoc_tensor_t t) {
  if (t.rows == 0 || t.cols == 0) return 0.0;
  return (double)(t.rows > t.cols ? t.rows : t.cols);
}
