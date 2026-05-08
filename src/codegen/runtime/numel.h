/* mtoc runtime helper: numel(t) — total number of elements. */

static double mtoc_numel(mtoc_tensor_t t) {
  return (double)(t.rows * t.cols);
}
