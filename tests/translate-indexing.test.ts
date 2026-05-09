import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("indexing — scalar reads", () => {
  // Cross-runner tests in test_scripts/indexing/ verify byte-for-byte
  // stdout against numbl. These vitest assertions pin the *shape* of
  // the emitted C — specific patterns (`v.real[(long)(i) - 1L]`,
  // `M.real[i + j * M.rows]`) that stdout comparison alone can't
  // catch.

  it("emits v.real[(long)(i) - 1L] for a 1-arg index on a row vector", () => {
    const c = translate("v = [1 2 3];\ni = 2;\ndisp(v(i));\n");
    expect(c).toMatch(/v\.real\[\(long\)\(i\) - 1L\]/);
    // disp routes through the runtime helper; the index expression
    // sits inside the call.
    expect(c).toContain("mtoc_disp_double(v.real[(long)(i) - 1L]);");
  });

  it("emits the column-major formula for a 2-arg index on a matrix", () => {
    const c = translate("M = [1 2 3; 4 5 6];\ndisp(M(2, 3));\n");
    // i + j*rows pattern with the (long)(...) - 1L conversions.
    expect(c).toMatch(
      /M\.real\[\(long\)\(2\.0\) - 1L \+ \(\(long\)\(3\.0\) - 1L\) \* M\.rows\]/
    );
  });

  it("resolves end inside a 1-arg index to numel via rows*cols", () => {
    const c = translate("v = [1 2 3 4];\ndisp(v(end));\n");
    // For 1-arg indexing, `end` resolves to `(v.rows * v.cols)`.
    expect(c).toMatch(/v\.real\[\(long\)\(\(v\.rows \* v\.cols\)\) - 1L\]/);
  });

  it("resolves end in slot 0 of a 2-arg index to .rows", () => {
    const c = translate("M = [1 2; 3 4];\ndisp(M(end, 1));\n");
    expect(c).toMatch(
      /M\.real\[\(long\)\(M\.rows\) - 1L \+ \(\(long\)\(1\.0\) - 1L\) \* M\.rows\]/
    );
  });

  it("resolves end in slot 1 of a 2-arg index to .cols", () => {
    const c = translate("M = [1 2; 3 4];\ndisp(M(1, end));\n");
    expect(c).toMatch(
      /M\.real\[\(long\)\(1\.0\) - 1L \+ \(\(long\)\(M\.cols\) - 1L\) \* M\.rows\]/
    );
  });

  it("composes index reads inside arithmetic", () => {
    const c = translate("v = [10 20 30];\ndisp(v(1) + v(end));\n");
    expect(c).toContain("v.real[(long)(1.0) - 1L]");
    expect(c).toContain("v.real[(long)((v.rows * v.cols)) - 1L]");
    expect(c).toMatch(/v\.real\[.*\] \+ v\.real\[.*\]/);
  });

  it("emits the complex-aware (re + im*I) form for a complex tensor index", () => {
    const c = translate("z = [1+2i, 3+4i];\ndisp(z(1));\n");
    expect(c).toContain("#include <complex.h>");
    expect(c).toMatch(/\(z\.real\[.*\] \+ z\.imag\[.*\] \* I\)/);
  });

  it("emits .data[idx] for a char-tensor index", () => {
    const c = translate("s = 'abc';\ndisp(s(2));\n");
    expect(c).toMatch(/s\.data\[\(long\)\(2\.0\) - 1L\]/);
    // Result is a scalar char — disp goes through mtoc_disp_char (NOT
    // mtoc_disp_char_tensor, which is for whole arrays).
    expect(c).toContain("mtoc_disp_char(s.data[");
  });

  it("rejects indexing into a scalar variable with a span", () => {
    let err: unknown;
    try {
      translate("x = 5;\ndisp(x(1));\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/scalar/i);
  });

  it("rejects more than 2 indices with a span", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\ndisp(v(1, 2, 3));\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/2 indices/i);
  });

  it("rejects a non-scalar index expression with a TypeError", () => {
    // The scalar-only check fires when a slot's lowered type is
    // multi-element. Range / colon indices route through the parser
    // as `Range` / `Colon` expressions and currently raise
    // `UnsupportedConstruct` from lowerExpr's default arm before
    // reaching the index slot check; a tensor-valued index (a Var
    // whose type is multi-element) is the cleanest way to trigger
    // the scalar-only TypeError until range support lands.
    let err: unknown;
    try {
      translate("v = [1 2 3];\nidx = [1 2];\ndisp(v(idx));\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("TypeError");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/real scalar/i);
  });

  it("rejects a range index with an UnsupportedConstruct (range support deferred)", () => {
    // Range-indexed reads (`v(2:5)`) are a known gap; the parser
    // emits a `Range` Expr at the slot, and lowerExpr's default arm
    // surfaces a span-attributed UnsupportedConstruct. This test
    // pins that error path so it stays predictable until the range
    // support commit lands.
    let err: unknown;
    try {
      translate("v = [1 2 3];\ndisp(v(1:2));\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
  });

  it("rejects `end` outside an index expression", () => {
    let err: unknown;
    try {
      translate("disp(end);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/'end' is only valid/i);
  });

  it("does not wrap an index-base read in mtoc_tensor_copy (read-only)", () => {
    // Indexing reads the base via field access; it never transfers
    // ownership and so doesn't trigger the copy-on-arg-pass wrap.
    const c = translate("v = [1 2 3];\ndisp(v(2));\n");
    expect(c).not.toMatch(/mtoc_tensor_copy\(v\)/);
  });

  it("an in-scope variable shadows a same-named user function", () => {
    // MATLAB's "workspace shadows functions" rule: when `pick` is both
    // a local function and an in-scope variable, the variable wins
    // and `pick(2)` lowers as an index.
    const c = translate(
      "function r = pick(x)\n  r = x * 100;\nend\n" +
        "pick = [10 20 30];\n" +
        "disp(pick(2));\n"
    );
    // No call to the user function — should be a direct index.
    expect(c).toMatch(/pick\.real\[\(long\)\(2\.0\) - 1L\]/);
    expect(c).not.toMatch(/pick__[0-9a-f]+\(2\.0\)/);
  });
});
