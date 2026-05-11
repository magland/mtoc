import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("N-D elementwise codegen", () => {
  it("routes a 3-D elementwise add through mtoc_tensor_alloc_nd", () => {
    const c = translate(
      "v = [1 2 3 4 5 6 7 8 9 10 11 12];\n" +
        "A = reshape(v, 2, 3, 2);\n" +
        "B = A + 1;\n" +
        "disp(B);\n"
    );
    expect(c).toContain("static mtoc_tensor_t mtoc_tensor_alloc_nd(");
    // Stash-tensor alloc carries the full dim vector as a compound literal.
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc_nd(3, (long[]){"
    );
    // The element-count expression multiplies every axis, not just two.
    expect(c).toMatch(
      /long _mtoc_n = A\.dims\[0\] \* A\.dims\[1\] \* A\.dims\[2\];/
    );
    // The legacy 2-D alloc should NOT appear for an N-D result.
    expect(c).not.toMatch(/mtoc_tensor_alloc\(A\.dims\[0\], A\.dims\[1\]\)/);
  });

  it("uses the N-D complex alloc when the result is complex N-D", () => {
    const c = translate(
      "v = [1+1i 2 3+2i 4 5 6+3i];\n" +
        "A = reshape(v, 1, 2, 3);\n" +
        "B = A + 1;\n" +
        "disp(B);\n"
    );
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc_nd_complex(3, (long[]){"
    );
  });

  it("keeps the legacy 2-D alloc shape for 2-D results", () => {
    // Pure refactor regression guard: a plain 2-D elementwise op
    // should still emit `mtoc_tensor_alloc(M.dims[0], M.dims[1])`,
    // not the N-D variant, so existing byte-for-byte test scripts
    // stay byte-identical.
    const c = translate("M = [1 2; 3 4];\nN = M + 1;\ndisp(N);\n");
    expect(c).toContain("mtoc_tensor_alloc(M.dims[0], M.dims[1])");
    expect(c).not.toContain("mtoc_tensor_alloc_nd(");
  });
});
