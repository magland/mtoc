/* mtoc string runtime: the C representation for every numbl string
 * value mtoc emits.
 *
 * numbl distinguishes `string` (a scalar handle to a UTF-8 buffer,
 * `length("hi") == 1`) from `char` (a row-vector of code units,
 * `length('hi') == 2`). mtoc supports `string` only — char is
 * rejected at lowering today.
 *
 * Storage:
 *   - `data`  — pointer to the byte sequence. Never NULL once the
 *               value is populated; a fresh `mtoc_string_empty()`
 *               leaves it NULL with len=0 and is treated as the
 *               empty string at the runtime helpers.
 *   - `len`   — length in BYTES (not code points). UTF-8 is the
 *               documented encoding by convention; the runtime never
 *               inspects code points so it works for any byte string.
 *   - `owned` — 1 iff `data` was allocated by an mtoc helper and
 *               must be `free()`-d on disposal. 0 for handles
 *               pointing at a C string literal in `.rodata` (the
 *               common case for `mtoc_string_from_literal`); freeing
 *               those would be undefined behavior, so the free helper
 *               checks the flag.
 *
 * The owned flag means literals are zero-allocation while concat
 * results are heap-allocated; the assignment / scope-exit free path
 * sees both shapes uniformly through `mtoc_string_assign` /
 * `mtoc_string_free`.
 */

typedef struct {
  const char *data;
  long len;
  int owned;
} mtoc_string_t;
