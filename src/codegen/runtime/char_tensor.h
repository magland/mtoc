/* mtoc char-tensor runtime: the C representation for every numbl char
 * array (single-quoted char-vec) that mtoc emits as multi-element.
 *
 * numbl's `char` type is a 1×N row-vector of code units. mtoc maps it
 * to one of:
 *   - bare C `char`         — for a 1×1 scalar char (no struct, no heap).
 *   - `mtoc_char_tensor_t`  — for any 1×N (N≥2) char array: a compact
 *     struct with a char buffer, shape, and an owned flag.
 *
 * The `owned` flag follows the same idiom as `mtoc_string_t`: 0 for
 * literal-pointing non-owning handles (from
 * `mtoc_char_tensor_from_literal`), 1 for heap-allocated buffers.
 * `mtoc_char_tensor_free` inspects this flag before calling `free`.
 *
 * Char arithmetic (`'A' + 1`, `'abc' + 2`) widens char elements to
 * `double` at the per-element loop site and produces a plain
 * `mtoc_tensor_t` (double) result — no mixed-type arithmetic struct.
 */

typedef struct {
  char *data;   /* pointer to char bytes; NULL only in the empty state */
  long rows;
  long cols;
  int owned;    /* 1 iff data is heap-allocated and must be free()'d */
} mtoc_char_tensor_t;
