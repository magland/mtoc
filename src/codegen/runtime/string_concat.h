/* mtoc runtime helper: concatenate two text views into a fresh
 * heap-allocated owned string.
 *
 * Implements numbl's `"a" + "b" == "ab"` semantics, generalized to
 * accept either strings or char arrays on each side (numbl coerces
 * char into string at the `+` boundary; mtoc bridges via the text
 * view at the call site). Both inputs are non-owning views; the
 * returned handle owns its buffer and the caller must pass it to
 * `mtoc_string_assign` (which takes ownership) or
 * `mtoc_string_free`.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static mtoc_string_t mtoc_string_concat(mtoc_text_view_t a, mtoc_text_view_t b) {
  long alen = a.len > 0 ? a.len : 0;
  long blen = b.len > 0 ? b.len : 0;
  size_t total;
#if defined(__has_builtin) && __has_builtin(__builtin_add_overflow)
  if (__builtin_add_overflow((size_t)alen, (size_t)blen, &total)) {
    fprintf(stderr,
      "mtoc: string concat allocation overflow (%ld + %ld bytes)\n", alen, blen);
    abort();
  }
#else
  if ((size_t)alen > SIZE_MAX - (size_t)blen) {
    fprintf(stderr,
      "mtoc: string concat allocation overflow (%ld + %ld bytes)\n", alen, blen);
    abort();
  }
  total = (size_t)alen + (size_t)blen;
#endif
  mtoc_string_t out;
  if (total == 0) {
    out.data = (const char *)0;
    out.len = 0;
    out.owned = 1;
    return out;
  }
  char *buf = mtoc_string_alloc_bytes(total);
  if (alen > 0) memcpy(buf, a.data, (size_t)alen);
  if (blen > 0) memcpy(buf + alen, b.data, (size_t)blen);
  out.data = buf;
  out.len = (long)total;
  out.owned = 1;
  return out;
}
