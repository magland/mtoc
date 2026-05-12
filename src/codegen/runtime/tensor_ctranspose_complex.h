/* mtoc runtime helper: 2-D conjugate transpose of a complex tensor.
 *
 * Mirrors `mtoc_tensor_transpose_complex` but negates the imag lane
 * — matching numbl's `'` (conjugate-transpose) operator. The real
 * lane is reordered identically to `.'`; only the imag entries flip
 * sign. Real tensors don't need this helper — they share the same
 * `mtoc_tensor_transpose` helper as `.'` since negating a zero imag
 * lane is a no-op.
 */

static mtoc_tensor_t mtoc_tensor_ctranspose_complex(mtoc_tensor_t src) {
  long rows = src.dims[0];
  long cols = src.dims[1];
  long out_dims[2] = { cols, rows };
  mtoc_tensor_t out = mtoc_tensor_alloc_nd_complex(2, out_dims);
  for (long r = 0; r < rows; r++) {
    for (long c = 0; c < cols; c++) {
      long src_idx = r + c * rows;
      long dst_idx = c + r * cols;
      out.real[dst_idx] = src.real[src_idx];
      out.imag[dst_idx] = -src.imag[src_idx];
    }
  }
  return out;
}
