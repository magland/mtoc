/* mtoc runtime helper: deep-copy a string handle into a fresh
 * heap buffer.
 *
 * Returns `{malloc'd, len, 1}` — the caller owns the new buffer and
 * is responsible for releasing it (typically via `mtoc_string_assign`,
 * which takes ownership, or `mtoc_string_free`). The byte content is
 * memcpy'd verbatim; encoding is not inspected. Used wherever the
 * lowerer / codegen wants a stand-alone owned copy of a string —
 * notably the `c = a;` assignment path emits
 * `mtoc_string_assign(&c, mtoc_string_copy(a));`.
 */

#include <string.h>

static mtoc_string_t mtoc_string_copy(mtoc_string_t s) {
  mtoc_string_t out;
  if (s.len <= 0 || s.data == (const char *)0) {
    /* Empty input → empty output. Avoid a zero-byte malloc, which is
     * implementation-defined; just return an empty owned handle so
     * callers' uniform free-on-owned behavior still applies. */
    out.data = (const char *)0;
    out.len = 0;
    out.owned = 1;
    return out;
  }
  char *buf = mtoc_string_alloc_bytes(s.len);
  memcpy(buf, s.data, (size_t)s.len);
  out.data = buf;
  out.len = s.len;
  out.owned = 1;
  return out;
}
