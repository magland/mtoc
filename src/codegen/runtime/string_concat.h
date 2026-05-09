/* mtoc runtime helper: concatenate two string handles into a fresh
 * heap-allocated owned string.
 *
 * Implements numbl's `"a" + "b" == "ab"` semantics. Both inputs are
 * read-only views (their `owned` flag is irrelevant here — they
 * remain the caller's responsibility). The returned handle owns its
 * buffer; the caller must pass it to `mtoc_string_assign` (which
 * takes ownership) or `mtoc_string_free`.
 */

#include <string.h>

static mtoc_string_t mtoc_string_concat(mtoc_string_t a, mtoc_string_t b) {
  long alen = a.len > 0 ? a.len : 0;
  long blen = b.len > 0 ? b.len : 0;
  long total = alen + blen;
  mtoc_string_t out;
  if (total <= 0) {
    out.data = (const char *)0;
    out.len = 0;
    out.owned = 1;
    return out;
  }
  char *buf = mtoc_string_alloc_bytes(total);
  if (alen > 0) memcpy(buf, a.data, (size_t)alen);
  if (blen > 0) memcpy(buf + alen, b.data, (size_t)blen);
  out.data = buf;
  out.len = total;
  out.owned = 1;
  return out;
}
