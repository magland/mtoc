import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("complex scalar codegen", () => {
  // Cross-runner tests in test_scripts/complex/ already verify
  // byte-for-byte stdout against numbl. These vitest assertions
  // additionally pin the *shape* of the emitted C — specific patterns
  // (`creal(a) == 1.0`, `&&` expansion) that stdout comparison alone
  // can't catch. They lock in the codegen so a refactor doesn't
  // silently change the emitted form.

  it("emits creal/cimag-based equality on a complex/real mix", () => {
    const c = translate("a = 1 + 2i;\ndisp(a == 1);\n");
    expect(c).toContain("#include <complex.h>");
    expect(c).toMatch(/creal\(a\) == 1\.0/);
    expect(c).toMatch(/cimag\(a\) == 0\.0/);
  });

  it("emits real-part-only ordering on complex inputs", () => {
    const c = translate("a = 1 + 2i;\nb = 3 + 4i;\ndisp(a < b);\n");
    // Real-part-only — `creal(a) < creal(b)`.
    expect(c).toMatch(/creal\(a\) < creal\(b\)/);
  });

  it("emits toBool-based && on complex operands", () => {
    const c = translate("a = 1 + 2i;\nb = 0 + 0i;\ndisp(a && b);\n");
    expect(c).toMatch(/creal\(a\) != 0\.0 \|\| cimag\(a\) != 0\.0/);
    expect(c).toMatch(/creal\(b\) != 0\.0 \|\| cimag\(b\) != 0\.0/);
    expect(c).toMatch(/&&/);
  });

  it("emits toBool-negated unary ~ on complex", () => {
    const c = translate("a = 1 + 2i;\ndisp(~a);\n");
    expect(c).toMatch(/!\(creal\(a\) != 0\.0 \|\| cimag\(a\) != 0\.0\)/);
  });

  it("emits double _Complex declaration and (V * I) literal", () => {
    const c = translate("z = 2.5i;\ndisp(z);\n");
    expect(c).toContain("double _Complex z = 0.0;");
    expect(c).toContain("z = (2.5 * I);");
    expect(c).toContain("mtoc_disp_complex(z);");
  });

  it("routes complex `/` through mtoc_cdiv (not C99's bare /)", () => {
    // C99's `/` on `double _Complex` produces NaN+NaN*I on divide-by-
    // zero; numbl's `complexDivide` carves out signed-Inf parts. The
    // helper preserves that semantic, so any complex-involving Div /
    // ElemDiv must route through it.
    const c = translate("a = 1 + 2i;\ndisp(a / 0);\n");
    expect(c).toContain("mtoc_cdiv(a, 0.0)");
    // And the helper body itself should be pulled into the prelude.
    expect(c).toContain("static double _Complex mtoc_cdiv(");
  });

  it("uses mtoc_cdiv for elementwise `./` with a complex operand", () => {
    const c = translate("a = 1 + 2i;\ndisp(a ./ 2);\n");
    expect(c).toContain("mtoc_cdiv(a, 2.0)");
  });

  it("leaves all-real `/` alone (no mtoc_cdiv activation)", () => {
    const c = translate("x = 5;\ny = 2;\ndisp(x / y);\n");
    expect(c).not.toContain("mtoc_cdiv");
    expect(c).toMatch(/x \/ y/);
  });

  it("lifts (negative)^(non-integer-const) to cpow with complex result", () => {
    const c = translate("r = (-1)^0.5;\ndisp(r);\n");
    expect(c).toContain("double _Complex r");
    expect(c).toContain("cpow(-1.0, 0.5)");
  });

  it("folds (negative)^(1/3) to cpow (constant-folds the divide)", () => {
    const c = translate("r = (-8)^(1/3);\ndisp(r);\n");
    expect(c).toContain("double _Complex r");
    expect(c).toContain("cpow(-8.0, 1.0 / 3.0)");
  });

  it("keeps (negative)^(integer-const) on real pow", () => {
    const c = translate("r = (-2)^2;\ndisp(r);\n");
    expect(c).not.toContain("cpow");
    expect(c).toContain("pow(-2.0, 2.0)");
    expect(c).not.toContain("double _Complex r");
  });

  it("keeps (positive)^(non-integer-const) on real pow", () => {
    const c = translate("r = 4^0.5;\ndisp(r);\n");
    expect(c).not.toContain("cpow");
    expect(c).toContain("pow(4.0, 0.5)");
  });
});

describe("complex codegen — no double-evaluation of Call operands", () => {
  // A complex Call operand that appears in Equal / NotEqual / AndAnd /
  // OrOr expands into two C sub-expressions (creal + cimag, or two
  // truthy checks), so without a fix the Call would be evaluated twice.
  // The fix hoists any non-Var complex operand to a temp before the
  // comparison.

  it("does not double-evaluate a complex Call in == comparison", () => {
    // sqrt(-4+0i) = csqrt(z) in C; appears as lhs of ==.
    // Before the fix: creal(csqrt(z)) == ... && cimag(csqrt(z)) == ...
    // After the fix: a temp holds csqrt(z) and is referenced once each.
    const c = translate("z = -4 + 0i; w = 0 + 2i; disp(sqrt(z) == w);");
    expect(c).not.toContain("creal(csqrt(z))");
    expect(c).not.toContain("cimag(csqrt(z))");
    // The temp declaration itself must be present.
    expect(c).toContain("csqrt(z)");
  });

  it("does not double-evaluate a complex Binary operand in == comparison", () => {
    // z + z2 is a non-Var complex expression; it should be hoisted.
    const c = translate(
      "z = 1 + 2i; z2 = 3 + 4i; w = 4 + 6i; disp((z + z2) == w);"
    );
    // The expanded comparison must NOT inline z + z2 twice.
    expect(c).not.toContain("creal(z + z2)");
    expect(c).not.toContain("cimag(z + z2)");
  });

  it("does not double-evaluate complex Call operand in unary ~", () => {
    // ~sqrt(z) negates the toBool of csqrt(z); same double-eval risk.
    const c = translate("z = -4 + 0i; disp(~sqrt(z));");
    expect(c).not.toContain("creal(csqrt(z)) != 0.0 || cimag(csqrt(z))");
    expect(c).toContain("csqrt(z)");
  });

  it("still inlines Var operands directly (no unnecessary temps)", () => {
    // Var operands are pure reads; they should not be hoisted.
    const c = translate("a = 1 + 2i; w = 3 + 4i; disp(a == w);");
    // creal(a) and cimag(a) are fine — no temp needed for a plain var.
    expect(c).toMatch(/creal\(a\) == creal\(w\)/);
    expect(c).toMatch(/cimag\(a\) == cimag\(w\)/);
    expect(c).not.toContain("_mtoc_cx_tmp");
  });
});

describe("complex `^` / `.^`", () => {
  // Scalar `^` / `.^` with at least one complex operand routes through
  // C99's `cpow`. Tensor `.^` produces a complex result tensor at the
  // broadcast shape (the iter-loop already emits cpow per slot via the
  // existing complex-result branch in emitExpr).

  it("emits cpow for scalar complex^integer", () => {
    const c = translate("z = 1 + 2i;\ndisp(z^2);\n");
    expect(c).toContain("cpow(z, 2.0)");
    // result is typed double _Complex
    expect(c).toMatch(/double _Complex/);
  });

  it("emits cpow for scalar real^complex", () => {
    const c = translate("disp(2^(0 + 1i));\n");
    expect(c).toContain("cpow(");
  });

  it("emits cpow elementwise for tensor .^ complex", () => {
    const c = translate("z = [1+2i, 3+4i];\ndisp(z .^ 2);\n");
    expect(c).toContain("cpow(");
    // Result staging buffer uses the complex tensor allocator.
    expect(c).toMatch(/mtoc_tensor_alloc(_nd)?_complex/);
  });
});

describe("complex control-flow conditions (if / elseif / while)", () => {
  // Numbl admits a scalar complex cond in `if`/`elseif`/`while` and
  // applies its toBool rule. Codegen expands `if (z)` to
  // `if (creal(z) != 0.0 || cimag(z) != 0.0)`.

  it("expands `if z` to creal-or-cimag-nonzero", () => {
    const c = translate("z = 1 + 2i;\nif z\n  disp(1);\nend\n");
    expect(c).toMatch(
      /if \(\(creal\(z\) != 0\.0 \|\| cimag\(z\) != 0\.0\)\) \{/
    );
  });

  it("expands `while z` the same way", () => {
    const c = translate("z = 1 + 2i;\nwhile z\n  z = 0 + 0i;\nend\n");
    expect(c).toMatch(
      /while \(\(creal\(z\) != 0\.0 \|\| cimag\(z\) != 0\.0\)\) \{/
    );
  });

  it("expands elseif with a complex cond", () => {
    const c = translate("if 0\n  disp(1);\nelseif 1 + 2i\n  disp(2);\nend\n");
    expect(c).toMatch(
      /else if \(\(creal\(.*\) != 0\.0 \|\| cimag\(.*\) != 0\.0\)\) \{/
    );
  });

  it("hoists a non-Var complex if-cond to a temp (no double-eval)", () => {
    // A complex Binary cond shouldn't be expanded twice.
    const c = translate(
      "z = 1 + 2i;\nw = 3 + 4i;\nif z + w\n  disp(1);\nend\n"
    );
    expect(c).toContain("_mtoc_cx_tmp_");
    // The temp should be on a separate line above the if.
    expect(c).toMatch(/double _Complex _mtoc_cx_tmp_\d+ = z \+ w;/);
  });

  it("keeps real cond on the bare path (no creal/cimag expansion)", () => {
    const c = translate("x = 5;\nif x > 0\n  disp(1);\nend\n");
    expect(c).toContain("if (x > 0.0)");
    expect(c).not.toContain("creal(x");
  });
});

describe("complex rounding family — floor / ceil / round / fix", () => {
  // Numbl applies floor / ceil / round / trunc (`fix`) componentwise
  // on complex inputs. C99 has no cfloor/cceil/cround/ctrunc, so
  // each complex sibling is a small runtime helper.

  it("routes complex floor through mtoc_floor_complex", () => {
    const c = translate("z = 1.5 + 2.5i;\ndisp(floor(z));\n");
    expect(c).toContain("mtoc_floor_complex(z)");
    expect(c).toContain("static double _Complex mtoc_floor_complex(");
  });

  it("routes complex ceil through mtoc_ceil_complex", () => {
    const c = translate("z = 1.5 + 2.5i;\ndisp(ceil(z));\n");
    expect(c).toContain("mtoc_ceil_complex(z)");
  });

  it("routes complex round through mtoc_round_complex", () => {
    const c = translate("z = 1.5 + 2.5i;\ndisp(round(z));\n");
    expect(c).toContain("mtoc_round_complex(z)");
  });

  it("routes complex `fix` through mtoc_trunc_complex", () => {
    const c = translate("z = 1.7 - 2.7i;\ndisp(fix(z));\n");
    expect(c).toContain("mtoc_trunc_complex(z)");
  });

  it("keeps real floor / ceil / round / fix on bare libm names", () => {
    const c = translate("x = 1.5;\ndisp(floor(x));\ndisp(fix(x));\n");
    expect(c).not.toContain("mtoc_floor_complex");
    expect(c).not.toContain("mtoc_trunc_complex");
    expect(c).toContain("floor(x)");
    expect(c).toContain("trunc(x)");
  });
});

describe("complex isnan / isinf / isfinite / logical", () => {
  // Complex inputs route through a runtime helper that expands
  // componentwise per numbl: EITHER-lane for isnan/isinf, BOTH-lanes
  // for isfinite, toBool (creal||cimag != 0) for logical. Using a
  // helper rather than an inline expansion keeps the operand
  // evaluated exactly once on a caller-side Call argument.

  it("routes complex isnan through mtoc_isnan_complex", () => {
    const c = translate("z = 1 + 2i;\ndisp(isnan(z));\n");
    expect(c).toContain("mtoc_isnan_complex(z)");
    expect(c).toContain("static double mtoc_isnan_complex(");
    expect(c).toMatch(/isnan\(creal\(z\)\) \|\| isnan\(cimag\(z\)\)/);
  });

  it("routes complex isinf through mtoc_isinf_complex", () => {
    const c = translate("z = 1 + 2i;\ndisp(isinf(z));\n");
    expect(c).toContain("mtoc_isinf_complex(z)");
    expect(c).toContain("static double mtoc_isinf_complex(");
  });

  it("routes complex isfinite through mtoc_isfinite_complex (AND of lanes)", () => {
    const c = translate("z = 1 + 2i;\ndisp(isfinite(z));\n");
    expect(c).toContain("mtoc_isfinite_complex(z)");
    expect(c).toMatch(/isfinite\(creal\(z\)\) && isfinite\(cimag\(z\)\)/);
  });

  it("rejects complex logical (numbl rejects it too)", () => {
    // Numbl's `logical` has no complex branch — it errors at runtime.
    // We match that by rejecting at lowering.
    expect(() => translate("z = 0 + 1i;\ndisp(logical(z));\n")).toThrow();
  });

  it("keeps real isnan / logical on the inline path (no helper pulled in)", () => {
    const c = translate("x = 3.5;\ndisp(isnan(x));\ndisp(logical(x));\n");
    expect(c).not.toContain("mtoc_isnan_complex");
    expect(c).toContain("isnan(x)");
  });
});
