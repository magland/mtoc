/* mtoc runtime helper: 2-D non-conjugate transpose of a complex tensor.
 *
 * Mirrors `mtoc_tensor_transpose` for the complex case — the real and
 * imag lanes are reordered identically; the imag lane is NOT negated
 * (that is the conjugate-transpose `'` operation, which mtoc doesn't
 * implement yet).
 */

static mtoc_tensor_t mtoc_tensor_transpose_complex(mtoc_tensor_t src) {
  long rows = src.dims[0];
  long cols = src.dims[1];
  long out_dims[2] = { cols, rows };
  mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(2, out_dims);
  for (long r = 0; r < rows; r++) {
    for (long c = 0; c < cols; c++) {
      long src_idx = r + c * rows;
      long dst_idx = c + r * cols;
      out.real[dst_idx] = src.real[src_idx];
      out.imag[dst_idx] = src.imag[src_idx];
    }
  }
  return out;
}
