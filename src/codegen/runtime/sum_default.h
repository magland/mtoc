/* mtoc runtime helper: sum(t) along numbl's default reduction dim —
 * the first non-singleton axis of `t` (1-based; matches
 * `firstReduceDim` in numbl/src/numbl-core/helpers/reduction-helpers.ts).
 *
 * Used for statically-matrix inputs: the lowerer routes
 * single-non-singleton-axis ("vector-like") shapes through the scalar-
 * returning `mtoc_sum` instead. Here we know at least two axes have a
 * statically-non-singleton size, so the result is a tensor (one axis
 * collapsed to 1, trailing singletons stripped to keep ndim >= 2).
 *
 * Column-major fiber walk: for each `outer` slab of `slab = inner *
 * reduceN` source elements, we sweep `reduceN` values along the reduce
 * axis (stride = inner) and write one accumulated value per inner
 * offset.
 *
 * Scaffold via MTOC_REDUCTION_WALK_REAL (reduction_walk.h).
 */

MTOC_REDUCTION_WALK_REAL(mtoc_sum_default,
  n > 0 ? t.real[0] : 0.0,
  double s = 0.0;,
  s += t.real[slabBase + i + k * inner];,
  out.real[out_idx++] = s;
)
