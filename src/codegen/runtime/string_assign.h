/* mtoc runtime helper: consume-and-replace assignment for strings.
 *
 * Frees `*lhs`'s current backing (only if owned — `mtoc_string_free`
 * checks the flag) and moves `rhs` into place. Codegen guarantees
 * every RHS handed here is either a freshly-allocated owned handle
 * (`mtoc_string_concat` result, `mtoc_string_copy` result) or a
 * literal handle (owned=0 from `mtoc_string_from_literal`); both
 * shapes are valid moves into `*lhs`.
 */

static void mtoc_string_assign(mtoc_string_t *lhs, mtoc_string_t rhs) {
  mtoc_string_free(lhs);
  *lhs = rhs;
}
