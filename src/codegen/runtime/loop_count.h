/* mtoc runtime helper: compute the iteration count for a numbl-style
 * `start : step : end` range as a non-negative `long`.
 *
 * numbl evaluates the count as `floor((end - start) / step) + 1` and
 * clamps to zero when the range is empty (start past end with the
 * given step sign). The same formula appears at four codegen sites
 * (for-loops, single-slot slice reads, multi-slot slice setup, slice
 * range writes); routing through one helper centralizes the cast
 * and protects against undefined behavior when `floor(...)` returns
 * a value outside the `long` range.
 *
 * Returns `0` on:
 *   - non-finite floor result (NaN — e.g. step = 0)
 *   - empty range (negative count)
 *   - count that doesn't fit in `long` (clamped rather than aborting:
 *     the user gets an empty range, which is the safest fallback
 *     under static translation — a 1e19-iteration loop is almost
 *     certainly a typo).
 */

#include <limits.h>
#include <math.h>

static long mtoc_loop_count(double start, double end, double step) {
  double n = floor((end - start) / step) + 1.0;
  if (!isfinite(n)) return 0;
  if (n <= 0.0) return 0;
  /* `(long)n` is undefined when n > LONG_MAX. Compare in double
   * space to keep the guard well-defined. */
  if (n > (double)LONG_MAX) return LONG_MAX;
  return (long)n;
}
