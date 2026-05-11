import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("pow complex-lift gating (nonpositive base)", () => {
  // Before tightening baseDefinitelyNegative, a `nonpositive` base
  // (sign that includes zero) was incorrectly treated the same as a
  // strictly `negative` base and lifted to cpow for non-integer constant
  // exponents. A nonpositive base can be zero, and 0^0.5 = 0 is real, so
  // the lift must not fire for `nonpositive`.

  it("does NOT lift nonpositive^(non-integer-const) to cpow", () => {
    // x gets sign nonpositive via the join of negative (-3) and zero (if-false branch).
    const src =
      ["x = -3;", "if false", "  x = 0;", "end", "disp(x ^ 0.5);"].join("\n") +
      "\n";
    const c = translate(src);
    expect(c).not.toContain("cpow(");
    expect(c).toContain("pow(");
    expect(c).not.toContain("double _Complex");
  });

  it("DOES lift strictly-negative^(non-integer-const) to cpow", () => {
    // A strictly negative literal stays sign=negative and must lift.
    const c = translate("disp((-4) ^ 0.5);\n");
    expect(c).toContain("cpow(");
    expect(c).toContain("double _Complex");
  });
});
