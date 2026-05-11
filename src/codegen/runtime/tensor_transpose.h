/* mtoc runtime helper: 2-D non-conjugate transpose of a real tensor.
 *
 * Numbl semantics for `A.'` on a numeric matrix: produces a column-
 * major buffer of shape `[cols, rows]`, swapping element positions.
 *
 * Mtoc's static type system rejects N-D transpose at lowering, so
 * this helper assumes a 2-D input (`src.ndim == 2`): `dims[0]` rows ×
 * `dims[1]` cols. Column-major layout means source element (r, c)
 * lives at `src.real[r + c * rows]`; the destination is shaped
 * `[cols, rows]` so element (c, r) of the destination lands at
 * `out.real[c + r * cols]`.
 *
 * Mtoc's ownership model: every tensor expression produces a freshly-
 * owned tensor, so this helper allocates a new buffer. The caller's
 * `src` is independently freed at its scope exit.
 */

static mtoc_tensor_t mtoc_tensor_transpose(mtoc_tensor_t src) {
  long rows = src.dims[0];
  long cols = src.dims[1];
  long out_dims[2] = { cols, rows };
  mtoc_tensor_t out = mtoc_tensor_alloc_nd(2, out_dims);
  for (long r = 0; r < rows; r++) {
    for (long c = 0; c < cols; c++) {
      out.real[c + r * cols] = src.real[r + c * rows];
    }
  }
  return out;
}
