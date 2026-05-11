import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("chars", () => {
  // Char-literal codegen. Cross-runner tests in test_scripts/chars/
  // already verify byte-for-byte stdout against numbl. These vitest
  // assertions additionally pin the *shape* of the emitted C.

  it("emits char declaration, assign, and disp for a scalar char", () => {
    const c = translate("c = 'a'; disp(c);");
    expect(c).toContain("char c = '\\0';");
    expect(c).toContain("c = 'a';");
    expect(c).toContain("mtoc_disp_char(c);");
    // Scalar char is not heap-owned — no free call.
    expect(c).not.toContain("mtoc_char_tensor_free");
  });

  it("emits mtoc_char_tensor_from_literal for multi-element char assignment", () => {
    const c = translate("s = 'abc'; disp(s);");
    expect(c).toContain("mtoc_char_tensor_t s = mtoc_char_tensor_empty();");
    expect(c).toContain('mtoc_char_tensor_from_literal("abc", 3)');
    expect(c).toContain("mtoc_char_tensor_assign(&s,");
    expect(c).toContain("mtoc_disp_text(mtoc_text_from_char_tensor(s));");
    expect(c).toContain("mtoc_char_tensor_free(&s);");
  });

  it("emits elementwise loop reading (double)(str[i]) for char-array arithmetic", () => {
    // `'abc' + 1` → a double row-vec computed element-wise over the
    // char literal's bytes.  The iter body reads from the string
    // literal inline (not via a struct field).
    const c = translate("v = 'abc' + 1; disp(v);");
    // The loop body should read bytes from the string literal.
    expect(c).toMatch(/\(double\)\("abc"\[_mtoc_i/);
    // Result is a double tensor.
    expect(c).toContain("mtoc_tensor_t v = mtoc_tensor_empty();");
  });
});
