/* mtoc text view: a non-owning (data, len) pair used as the common
 * argument type for runtime helpers that read text byte-for-byte
 * (`disp`, `error`, `assert(_, msg)`, `strcmp`, `string_concat`).
 *
 * numbl distinguishes `char` (1×N row-vector of bytes, single-quoted)
 * from `string` (scalar handle to a UTF-8 buffer, double-quoted), but
 * the helpers above only need to walk the bytes. `mtoc_text_view_t`
 * is what we pass to them; `mtoc_text_from_string` /
 * `mtoc_text_from_char_tensor` are zero-copy adapters the call site
 * uses to bridge either source struct into the view.
 *
 * The view is *non-owning*: the underlying storage stays with the
 * caller (literal in `.rodata`, owned `mtoc_string_t`, owned
 * `mtoc_char_tensor_t`). Helpers that need to *return* text
 * (`mtoc_string_concat`) still produce an owned `mtoc_string_t`.
 */

typedef struct {
  const char *data;
  long len;
} mtoc_text_view_t;

static mtoc_text_view_t mtoc_text_from_string(mtoc_string_t s) {
  mtoc_text_view_t v;
  v.data = s.data;
  v.len = s.len > 0 ? s.len : 0;
  return v;
}

static mtoc_text_view_t mtoc_text_from_char_tensor(mtoc_char_tensor_t c) {
  mtoc_text_view_t v;
  v.data = c.data;
  v.len = c.rows * c.cols;
  return v;
}
