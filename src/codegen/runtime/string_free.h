/* mtoc runtime helper: release a string handle's backing buffer if
 * owned, then reset it to the empty state.
 *
 * The owned flag distinguishes literal-pointing handles (no free) from
 * heap-allocated ones (must free). After this call the struct is in
 * the same shape as `mtoc_string_empty()`, so calling free a second
 * time on the same struct is a safe no-op — useful for the
 * scope-exit safety net at branch merges.
 */

#include <stdlib.h>

static void mtoc_string_free(mtoc_string_t *s) {
  if (s->owned && s->data) {
    free((void *)s->data);
  }
  s->data = (const char *)0;
  s->len = 0;
  s->owned = 0;
}
