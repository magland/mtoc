/* mtoc PRNG: xoshiro128** seeded via splitmix32, matching numbl's
 * `helpers/prng.ts` byte-for-byte. Used by `rand`, `randn`,
 * `randi`, etc. Numbl's unseeded fallback uses `Math.random()`
 * (V8 xorshift128+, not portable); mtoc instead defaults to a
 * fixed seed of 0 when the user has not called `rng(seed)`. To
 * get cross-runtime byte-identical output, the user's program
 * should call `rng(<seed>)` explicitly before any `rand` /
 * `randn` call.
 *
 * State is a process-wide static: there is no thread safety
 * (mtoc-generated programs are single-threaded). Reseeding via
 * `mtoc_rng_seed` clears the box-Muller spare cache.
 */

#include <math.h>
#include <stdint.h>

static uint32_t mtoc_rng_state[4] = {0, 0, 0, 0};
static int mtoc_rng_initialized = 0;
static double mtoc_bm_spare = 0.0;
static int mtoc_bm_spare_full = 0;

static uint32_t mtoc__rotl_u32(uint32_t x, int k) {
  return (x << k) | (x >> (32 - k));
}

static uint32_t mtoc__splitmix32_step(uint32_t *s) {
  *s = *s + 0x9e3779b9u;
  uint32_t z = *s;
  z = (z ^ (z >> 16)) * 0x85ebca6bu;
  z = (z ^ (z >> 13)) * 0xc2b2ae35u;
  return z ^ (z >> 16);
}

/* Match JS `Math.round(seed) | 0`: round-half-toward-+inf, then
 * truncate to signed 32-bit by reinterpreting as uint32_t. */
static void mtoc_rng_seed(double seed_d) {
  long rounded = (long)floor(seed_d + 0.5);
  uint32_t seed_u32 = (uint32_t)(int32_t)rounded;
  uint32_t s = seed_u32;
  for (int i = 0; i < 4; i++) {
    mtoc_rng_state[i] = mtoc__splitmix32_step(&s);
  }
  mtoc_rng_initialized = 1;
  mtoc_bm_spare_full = 0;
}

static uint32_t mtoc__xoshiro128ss(void) {
  if (!mtoc_rng_initialized) {
    /* Default seed when the user hasn't called rng() — fixed to 0
     * so output is deterministic across runs. Numbl's Math.random
     * fallback is not portable. */
    mtoc_rng_seed(0.0);
  }
  uint32_t result = mtoc__rotl_u32(mtoc_rng_state[1] * 5u, 7) * 9u;
  uint32_t t = mtoc_rng_state[1] << 9;
  mtoc_rng_state[2] ^= mtoc_rng_state[0];
  mtoc_rng_state[3] ^= mtoc_rng_state[1];
  mtoc_rng_state[1] ^= mtoc_rng_state[2];
  mtoc_rng_state[0] ^= mtoc_rng_state[3];
  mtoc_rng_state[2] ^= t;
  mtoc_rng_state[3] = mtoc__rotl_u32(mtoc_rng_state[3], 11);
  return result;
}

static double mtoc_rng_random(void) {
  return (double)mtoc__xoshiro128ss() / 4294967296.0;
}

/* Marsaglia polar method with a one-element spare cache, mirroring
 * numbl's `boxMullerRandom`. Returns a `N(0, 1)` sample. */
static double mtoc_rng_randn(void) {
  if (mtoc_bm_spare_full) {
    mtoc_bm_spare_full = 0;
    return mtoc_bm_spare;
  }
  double u, v, s;
  do {
    u = 2.0 * mtoc_rng_random() - 1.0;
    v = 2.0 * mtoc_rng_random() - 1.0;
    s = u * u + v * v;
  } while (s >= 1.0 || s == 0.0);
  double mul = sqrt((-2.0 * log(s)) / s);
  mtoc_bm_spare = v * mul;
  mtoc_bm_spare_full = 1;
  return u * mul;
}
