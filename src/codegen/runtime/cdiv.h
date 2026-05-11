/* mtoc runtime helper: complex scalar division `a / b`.
 *
 * C99's bare `/` on `double _Complex` evaluates `(ac+bd)/(c²+d²) +
 * (bc-ad)/(c²+d²)*i`, which produces `NaN + NaN*I` whenever the
 * divisor is exactly zero. numbl's interpreter takes a different
 * path: it explicitly carves out the divide-by-zero case to produce
 * signed-Inf parts (with a zero numerator part mapping to 0, not
 * NaN). That carve-out is what tests like
 * `arithmetic/test_complex_div_zero.m` exercise.
 *
 * Mirrors numbl's `complexDivide`
 * (numbl/src/numbl-core/helpers/arithmetic.ts):
 *
 *   if (bRe == 0 && bIm == 0):
 *     if (aRe == 0 && aIm == 0): return NaN + 0i
 *     return signedInf(aRe) + signedInf(aIm)*i        // 0→0, +→+Inf, -→-Inf
 *   else: Smith's algorithm (numerically stable; avoids overflow in
 *         bRe² + bIm² when one part is large).
 *
 * Codegen routes every `Div` / `ElemDiv` with at least one complex
 * operand through this helper; real operands are auto-promoted to
 * `double _Complex` at the call site via C99's implicit conversion.
 */

#include <complex.h>
#include <math.h>

static double _Complex mtoc_cdiv(double _Complex a, double _Complex b) {
  double ar = creal(a), ai = cimag(a);
  double br = creal(b), bi = cimag(b);
  if (br == 0.0 && bi == 0.0) {
    if (ar == 0.0 && ai == 0.0) return NAN + 0.0 * I;
    double rr = ar > 0.0 ? INFINITY : (ar < 0.0 ? -INFINITY : 0.0);
    double ri = ai > 0.0 ? INFINITY : (ai < 0.0 ? -INFINITY : 0.0);
    /* `rr + ri * I` would corrupt the parts: `INFINITY * I` evaluates
     * via `Inf*(0 + 1i)` and the 0*Inf term yields NaN in the real
     * lane. Use CMPLX() (C11) to assemble the two parts directly
     * without arithmetic; fall back to the GCC/Clang __real__/__imag__
     * builtins (well-defined, no aliasing) on older toolchains. */
#if defined(CMPLX)
    double _Complex result = CMPLX(rr, ri);
#else
    double _Complex result;
    __real__ result = rr;
    __imag__ result = ri;
#endif
    return result;
  }
  if (fabs(br) >= fabs(bi)) {
    double r = bi / br;
    double d = br + bi * r;
    return ((ar + ai * r) / d) + ((ai - ar * r) / d) * I;
  }
  double r = br / bi;
  double d = bi + br * r;
  return ((ar * r + ai) / d) + ((ai * r - ar) / d) * I;
}
