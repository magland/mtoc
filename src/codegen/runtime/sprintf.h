/* mtoc runtime helper: sprintf — return formatted text as an owned
 * string or char-array, matching numbl's `sprintf`
 * (numbl/src/numbl-core/interpreter/builtins/strings.ts).
 *
 * Numbl returns:
 *   - a `char` value when the format arg is char (single-quoted),
 *   - a `string` value when the format arg is string (double-quoted).
 * mtoc tracks that statically and routes:
 *   - char-typed format → mtoc_sprintf_char → mtoc_char_tensor_t
 *   - string-typed format → mtoc_sprintf_str → mtoc_string_t
 *
 * Both entry points share the format-engine walker via a growable-
 * buffer writer. The returned handle owns its byte buffer; the
 * caller passes it to `mtoc_string_assign` / `mtoc_char_tensor_assign`
 * (or frees it directly via `mtoc_string_free` / `mtoc_char_tensor_free`).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  char *data;
  long len;
  long cap;
} mtoc__sprintf_buf_t;

static void mtoc__sprintf_writer(void *ctx, const char *bytes, long len) {
  mtoc__sprintf_buf_t *b = (mtoc__sprintf_buf_t *)ctx;
  if (len <= 0) return;
  if (b->len + len > b->cap) {
    long new_cap = b->cap == 0 ? 64 : b->cap * 2;
    while (new_cap < b->len + len) new_cap *= 2;
    char *nb = (char *)realloc(b->data, (size_t)new_cap);
    if (!nb) {
      fprintf(stderr, "mtoc: out of memory in mtoc_sprintf\n");
      abort();
    }
    b->data = nb;
    b->cap = new_cap;
  }
  memcpy(b->data + b->len, bytes, (size_t)len);
  b->len += len;
}

static mtoc_string_t mtoc_sprintf_str(mtoc_text_view_t fmt,
                                      int nargs,
                                      const mtoc_fprintf_arg_t *args) {
  mtoc__sprintf_buf_t b;
  b.data = (char *)0;
  b.len = 0;
  b.cap = 0;
  mtoc__format_walk(mtoc__sprintf_writer, &b, fmt, nargs, args);
  mtoc_string_t s;
  if (b.len == 0) {
    free(b.data);
    s.data = (const char *)0;
    s.len = 0;
    s.owned = 1;
    return s;
  }
  /* Trim to exact size — sprintf results may be long-lived, so the
   * trailing slack from doubling has real cost. */
  char *trimmed = (char *)realloc(b.data, (size_t)b.len);
  s.data = trimmed ? trimmed : b.data;
  s.len = b.len;
  s.owned = 1;
  return s;
}

static mtoc_char_tensor_t mtoc_sprintf_char(mtoc_text_view_t fmt,
                                            int nargs,
                                            const mtoc_fprintf_arg_t *args) {
  mtoc__sprintf_buf_t b;
  b.data = (char *)0;
  b.len = 0;
  b.cap = 0;
  mtoc__format_walk(mtoc__sprintf_writer, &b, fmt, nargs, args);
  mtoc_char_tensor_t c;
  if (b.len == 0) {
    free(b.data);
    c.data = (char *)0;
    c.rows = 0;
    c.cols = 0;
    c.owned = 1;
    return c;
  }
  char *trimmed = (char *)realloc(b.data, (size_t)b.len);
  c.data = trimmed ? trimmed : b.data;
  c.rows = 1;
  c.cols = b.len;
  c.owned = 1;
  return c;
}
