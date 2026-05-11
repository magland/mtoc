/* mtoc runtime helpers: tic / toc — wall-clock elapsed time.
 *
 * Mirrors numbl's `tic` / `toc` (numbl/src/numbl-core/interpreter/builtins/time-system.ts
 * and runtime/specialBuiltins.ts). Both keep a process-wide "last tic
 * start" so `toc` without an argument reports elapsed since the most
 * recent `tic` call. `toc(handle)` reports elapsed against the value
 * returned by an earlier `tic` (the handle is a number — seconds from
 * the same monotonic origin).
 *
 * Timing source is `clock_gettime(CLOCK_MONOTONIC)` (not wall time,
 * so it isn't affected by system clock adjustments). Numbl uses
 * `performance.now()` which is also monotonic; the absolute values
 * differ between runtimes (numbl's origin is process start, mtoc's is
 * system boot) but elapsed differences match in practice. Tests that
 * compare numbl and mtoc output byte-for-byte must not print the
 * absolute tic value or the elapsed duration — only derived predicates
 * (e.g. `disp(elapsed >= 0)`).
 *
 * The "print" variants (`mtoc_toc_print` / `mtoc_toc_print_h`) format
 * with `%.6f` to match numbl's `elapsed.toFixed(6)`.
 */

#include <stdio.h>
#include <time.h>

static double mtoc_tic_state_sec = 0.0;

static double mtoc__now_seconds(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static double mtoc_tic(void) {
  mtoc_tic_state_sec = mtoc__now_seconds();
  return mtoc_tic_state_sec;
}

static double mtoc_toc(void) {
  return mtoc__now_seconds() - mtoc_tic_state_sec;
}

static double mtoc_toc_h(double h) {
  return mtoc__now_seconds() - h;
}

static void mtoc_toc_print(void) {
  double elapsed = mtoc__now_seconds() - mtoc_tic_state_sec;
  printf("Elapsed time is %.6f seconds.\n", elapsed);
}

static void mtoc_toc_print_h(double h) {
  double elapsed = mtoc__now_seconds() - h;
  printf("Elapsed time is %.6f seconds.\n", elapsed);
}
