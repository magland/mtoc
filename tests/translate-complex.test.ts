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
