/* mtoc runtime helper: sum(t) along numbl's default reduction dim,
 * complex variant. See `sum_default.h` for the fiber-walk rationale.
 *
 * Real and imag lanes are summed independently — addition distributes
 * over the lane split (unlike multiplication, which needs the mixed
 * accumulator in `complexProd`).
 *
 * Scaffold via MTOC_REDUCTION_WALK_COMPLEX (reduction_walk.h).
 */

MTOC_REDUCTION_WALK_COMPLEX(mtoc_sum_complex_default,
  n > 0 ? t.real[0] : 0.0,
  n > 0 ? t.imag[0] : 0.0,
  double sr = 0.0; double si = 0.0;,
  long idx = slabBase + i + k * inner; sr += t.real[idx]; si += t.imag[idx];,
  out.real[out_idx] = sr; out.imag[out_idx] = si; out_idx++;
)
