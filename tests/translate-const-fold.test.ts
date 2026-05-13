/**
 * Stage-C constant folding for literal-kind IR operands. The fold
 * fires when both sides of a binary op (or the operand of a unary
 * op) reduce to a NumLit / CharLit / ImagLit / StringLit at lowering
 * time, collapsing the IR to a single literal. These tests assert
 * the post-fold C shape — the value bypasses any C-side operator
 * entirely.
 */
import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("Stage-C constant folding (literal IR operands)", () => {
  it("folds real scalar arithmetic to a NumLit", () => {
    const c = translate("r = 2 + 3 * 4;\ndisp(r);\n");
    // Result: 2 + 12 = 14; both `+` and `*` collapse.
    expect(c).toMatch(/r = 14\.0;/);
    expect(c).not.toMatch(/r = 2\.0 \+ /);
    expect(c).not.toMatch(/\* 4\.0/);
  });

  it("folds real scalar comparisons to 1.0 / 0.0", () => {
    const c = translate("a = 5 == 5;\nb = 3 < 2;\ndisp(a);\ndisp(b);\n");
    expect(c).toMatch(/a = 1\.0;/);
    expect(c).toMatch(/b = 0\.0;/);
  });

  it("folds real scalar Pow when the base is non-negative", () => {
    const c = translate("r = 2^10;\ndisp(r);\n");
    expect(c).toMatch(/r = 1024\.0;/);
    expect(c).not.toContain("pow(");
  });

  it(
    "defers folding when negative base + non-integer exponent " +
      "(complex-lift path still wins)",
    () => {
      const c = translate("r = (-1)^0.5;\ndisp(r);\n");
      // Result is complex; lift to cpow runs unchanged.
      expect(c).toContain("double _Complex r");
      expect(c).toContain("cpow(-1.0, 0.5)");
    }
  );

  it("folds string concat (StringLit + StringLit) into one StringLit", () => {
    const c = translate('s = "hello" + " " + "world";\ndisp(s);\n');
    // The runtime concat call should be absent — the C carries one
    // pre-baked literal payload. (The runtime preamble mentions
    // `mtoc_string_concat` in doc comments; assert no actual CALL.)
    expect(c).not.toMatch(/mtoc_string_concat\(/);
    expect(c).toContain('mtoc_string_from_literal("hello world", 11)');
  });

  it("folds scalar char arithmetic via the char→double promotion", () => {
    const c = translate("r = 'a' + 1;\ndisp(r);\n");
    // 'a' (97) + 1 = 98; result is a real double.
    expect(c).toMatch(/r = 98\.0;/);
  });

  it("folds scalar char comparison to 1.0 / 0.0", () => {
    const c = translate(
      "a = 'a' == 'a';\nb = 'a' < 'b';\ndisp(a);\ndisp(b);\n"
    );
    expect(c).toMatch(/a = 1\.0;/);
    expect(c).toMatch(/b = 1\.0;/);
  });

  it("folds pure-imag arithmetic to ImagLit when result stays imaginary", () => {
    // (3i) + (4i) = 7i — fits ImagLit's `0 + value*i` shape.
    const c = translate("z = 3i + 4i;\ndisp(z);\n");
    expect(c).toMatch(/z = \(7\.0 \* I\);/);
  });

  it("folds (bi)(di) = -bd to a real NumLit", () => {
    // (2i)(3i) = -6 — the result lands back in the real domain.
    const c = translate("z = (2i) * (3i);\ndisp(z);\n");
    expect(c).toMatch(/z = -6\.0;/);
    // Variable should be declared as real double, not complex.
    expect(c).not.toContain("double _Complex z");
  });

  it("folds unary minus on scalar char to NumLit", () => {
    const c = translate("r = -'a';\ndisp(r);\n");
    expect(c).toMatch(/r = -97\.0;/);
  });

  it("preserves Binary IR when only one operand is literal", () => {
    // Variable + literal can't fold today (no variable-value
    // propagation in this stage); the C keeps `n + 1.0`.
    const c = translate("n = 5;\nr = n + 1;\ndisp(r);\n");
    expect(c).toMatch(/r = n \+ 1\.0;/);
  });

  it("re-folds across nested literal expressions", () => {
    // The outer Add folds because both children fold first.
    const c = translate("r = (1 + 2) * (3 + 4);\ndisp(r);\n");
    expect(c).toMatch(/r = 21\.0;/);
  });
});
