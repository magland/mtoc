/* mtoc runtime helper: `angle(x)` for a real-scalar x.
 *
 * Mirrors numbl's `angle` real-input branch:
 *   isNaN(x)  → NaN
 *   x >= 0    → 0       (covers +0 and -0; -0 >= 0 is true in IEEE 754)
 *   else      → π
 *
 * The complex branch uses `carg(z)` directly at the call site.
 */

#include <math.h>

static double mtoc_angle_real(double x) {
  if (isnan(x)) return x;
  if (x >= 0.0) return 0.0;
  return M_PI;
}
