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
});
