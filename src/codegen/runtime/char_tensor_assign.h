/* mtoc runtime helper: consume-and-replace assignment for char tensors.
 *
 * Frees `*lhs`'s current backing (only if owned — `mtoc_char_tensor_free`
 * checks the flag) and moves `rhs` into place. Codegen guarantees every
 * RHS is either a freshly-allocated owned handle or a literal handle
 * (owned=0 from `mtoc_char_tensor_from_literal`); both shapes are valid.
 */

static void mtoc_char_tensor_assign(mtoc_char_tensor_t *lhs,
                                     mtoc_char_tensor_t rhs) {
  mtoc_char_tensor_free(lhs);
  *lhs = rhs;
}
