import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("broadcasting codegen", () => {
  it("emits per-axis mtoc_broadcast_dim chains for row + col", () => {
    const c = translate(
      "row = [10 20 30];\n" +
        "col = [1; 2];\n" +
        "S = row + col;\n" +
        "disp(S);\n"
    );
    // Output dim 0 is the broadcast of row.dims[0] and col.dims[0];
    // output dim 1 mirrors that for dims[1]. (Operand order tracks
    // collectMultiElementVarsByCName's DFS, which is left-first.)
    expect(c).toContain(
      "long _mtoc_d0 = mtoc_broadcast_dim(row.dims[0], col.dims[0]);"
    );
    expect(c).toContain(
      "long _mtoc_d1 = mtoc_broadcast_dim(row.dims[1], col.dims[1]);"
    );
    // 2-D output stays on the legacy (rows, cols) alloc form, not the
    // N-D compound-literal variant.
    expect(c).toContain("mtoc_tensor_alloc(_mtoc_d0, _mtoc_d1)");
    expect(c).not.toContain("mtoc_tensor_alloc_nd(");
    // Helper body is present.
    expect(c).toMatch(/static long mtoc_broadcast_dim\(/);
  });

  it("emits nested column-major loops with a flat output index", () => {
    const c = translate(
      "row = [10 20 30];\n" +
        "col = [1; 2];\n" +
        "S = row + col;\n" +
        "disp(S);\n"
    );
    // Outermost loop iterates the highest axis (column-major fill);
    // innermost iterates axis 0. Output linear index is
    //   k0 + k1*d0  (so the loop yields a column-major output buffer).
    expect(c).toMatch(
      /for \(long _mtoc_k1 = 0; _mtoc_k1 < _mtoc_d1; _mtoc_k1\+\+\) \{[\s\S]*for \(long _mtoc_k0 = 0; _mtoc_k0 < _mtoc_d0; _mtoc_k0\+\+\) \{/
    );
    expect(c).toContain("long _mtoc_oi = _mtoc_k0 + _mtoc_k1 * _mtoc_d0;");
  });

  it("drops the size-1 axis term from each operand's index", () => {
    const c = translate(
      "row = [10 20 30];\n" +
        "col = [1; 2];\n" +
        "S = row + col;\n" +
        "disp(S);\n"
    );
    // Row vector [one, notOne]: axis 0 is statically `one` (contributes
    // 0; dropped); axis 1 is `notOne` (uses _mtoc_k1; stride row.dims[0]).
    expect(c).toContain("long _mtoc_row_idx = _mtoc_k1 * row.dims[0];");
    // Column vector [notOne, one]: axis 0 is `notOne` (uses _mtoc_k0,
    // stride 1); axis 1 is `one` (contributes 0; dropped).
    expect(c).toContain("long _mtoc_col_idx = _mtoc_k0;");
    // Body reads each operand at its own precomputed index.
    expect(c).toContain(
      "_mtoc_t.real[_mtoc_oi] = row.real[_mtoc_row_idx] + col.real[_mtoc_col_idx];"
    );
  });

  it("keeps the flat-iter path for same-shape operands (no regression)", () => {
    // Two 1x3 row vectors — same static shape, so the broadcast
    // detection rejects and we stay on the legacy flat-iter form
    // with `mtoc_check_shape` plus a single `_mtoc_i` loop.
    const c = translate("v = [1 2 3];\nw = [4 5 6];\nr = v + w;\ndisp(r);\n");
    expect(c).toContain("mtoc_check_shape(v, w);");
    expect(c).toContain("mtoc_tensor_alloc(v.dims[0], v.dims[1])");
    expect(c).toContain("for (long _mtoc_i = 0;");
    expect(c).not.toContain("mtoc_broadcast_dim(");
  });

  it("uses N-D alloc when one operand is 3-D (mat + matrix-broadcast)", () => {
    const c = translate(
      "v = [1 2 3 4 5 6 7 8 9 10 11 12];\n" +
        "A = reshape(v, 2, 3, 2);\n" +
        "M = [10 20 30; 40 50 60];\n" +
        "S = A + M;\n" +
        "disp(S);\n"
    );
    // Output is 3-D; the 2-D operand has a trailing implicit `one`
    // axis that contributes a `1L` to the broadcast chain.
    expect(c).toContain("long _mtoc_d2 = mtoc_broadcast_dim(A.dims[2], 1L);");
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc_nd(3, (long[]){_mtoc_d0, _mtoc_d1, _mtoc_d2});"
    );
    // Three nested loops, outermost is axis 2.
    expect(c).toMatch(/for \(long _mtoc_k2 = 0;[\s\S]*_mtoc_k1[\s\S]*_mtoc_k0/);
  });

  it("emits creal/cimag splits in the broadcast body for a complex result", () => {
    const c = translate(
      "row = [1+1i, 2-1i, 3+0i];\n" +
        "col = [10; 20];\n" +
        "S = row + col;\n" +
        "disp(S);\n"
    );
    // Complex output goes through the alloc_complex helper and the
    // body splits into .real / .imag via creal/cimag (same body shape
    // as the flat-iter complex path, but indexed by _mtoc_oi).
    expect(c).toContain("mtoc_tensor_alloc_complex(_mtoc_d0, _mtoc_d1)");
    expect(c).toContain("double _Complex _mtoc_c =");
    expect(c).toContain("_mtoc_t.real[_mtoc_oi] = creal(_mtoc_c);");
    expect(c).toContain("_mtoc_t.imag[_mtoc_oi] = cimag(_mtoc_c);");
  });

  it("activates the mtoc_broadcast_dim runtime helper body once", () => {
    const c = translate(
      "row = [1 2 3];\ncol = [10; 20];\nS = row + col;\ndisp(S);\n"
    );
    // Helper definition is present exactly once even though both axes
    // call into it.
    const matches = c.match(/static long mtoc_broadcast_dim\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });
});
