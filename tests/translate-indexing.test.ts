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

describe("indexing — range and colon reads", () => {
  it("emits an alloc + counted loop for v(a:b)", () => {
    const c = translate("v = [10 20 30 40];\nw = v(2:3);\ndisp(w);\n");
    // Allocation sized by the iteration-count formula; row-vec base
    // → row result (1 × _mtoc_n).
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(1, _mtoc_n)"
    );
    // The loop body reads from the base.
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_k\] = v\.real\[\(long\)\(_mtoc_start \+ 1\.0 \* \(double\)_mtoc_k\) - 1L\]/
    );
    // Final consume-replace into the LHS variable.
    expect(c).toContain("mtoc_tensor_assign(&w, _mtoc_t);");
  });

  it("v(:) emits a column-allocating linearization", () => {
    const c = translate("v = [10 20 30];\nw = v(:);\ndisp(w);\n");
    // Colon: count = base.rows * base.cols, result is column.
    expect(c).toContain("long _mtoc_n = v.rows * v.cols;");
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(_mtoc_n, 1)"
    );
    // Per-iteration read uses k directly (no MATLAB→C conversion).
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_k\] = v\.real\[_mtoc_k\];/);
  });

  it("preserves column orientation for c(2:3) on a column base", () => {
    const c = translate("c = [10; 20; 30; 40];\nw = c(2:3);\ndisp(w);\n");
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(_mtoc_n, 1)"
    );
  });

  it("uses the index orientation (row) for a matrix range slice", () => {
    const c = translate("M = [1 2; 3 4];\nw = M(2:3);\ndisp(w);\n");
    // Matrix base under linear range → row result, matching numbl.
    expect(c).toContain(
      "mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(1, _mtoc_n)"
    );
  });

  it("end inside a 1-slot range resolves to numel via rows*cols", () => {
    const c = translate("v = [1 2 3 4 5];\nw = v(2:end);\ndisp(w);\n");
    // The range's end is `end` → renders as `(v.rows * v.cols)`.
    expect(c).toContain("double _mtoc_end = (v.rows * v.cols);");
  });

  it("emits both real and imag fills for a complex range slice", () => {
    const c = translate("z = [1+2i, 3+4i, 5+6i];\nw = z(1:2);\ndisp(w);\n");
    expect(c).toContain("mtoc_tensor_alloc_complex(1, _mtoc_n)");
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_k\] = z\.real\[/);
    expect(c).toMatch(/_mtoc_t\.imag\[_mtoc_k\] = z\.imag\[/);
  });

  it("rejects a range slice nested inside a larger expression", () => {
    // Indexing produces a fresh tensor — only legal at the top of
    // Assign.rhs. The lowering-pass validator catches a nested use.
    let err: unknown;
    try {
      translate("v = [1 2 3];\nw = v(1:2) + v(2:3);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/range\/colon/i);
  });

  it("rejects a range slice as a disp arg with a clear message", () => {
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

  it("rejects a non-literal step", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3 4];\ns = 2;\nw = v(1:s:4);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/numeric literal/i);
  });

  it("rejects char-tensor range indexing (deferred)", () => {
    let err: unknown;
    try {
      translate("s = 'abcdef';\nw = s(2:4);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/char tensor/i);
  });

  it("rejects multi-slot range indexing on read (deferred)", () => {
    let err: unknown;
    try {
      translate("M = [1 2; 3 4];\nw = M(:, 1);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/multi-slot/i);
  });
});

describe("indexing — scalar writes", () => {
  it("emits an in-place write for v(i) = x on a real vector", () => {
    const c = translate("v = [10 20 30];\nv(2) = 99;\ndisp(v);\n");
    expect(c).toMatch(/v\.real\[\(long\)\(2\.0\) - 1L\] = 99\.0;/);
    // The base is NOT reassigned via mtoc_tensor_assign — the heap
    // backing is mutated in place.
    expect(c).not.toMatch(/mtoc_tensor_assign\(&v, .*99/);
  });

  it("emits the column-major formula for M(i, j) = x", () => {
    const c = translate("M = [1 2; 3 4];\nM(2, 1) = 99;\ndisp(M);\n");
    expect(c).toMatch(
      /M\.real\[\(long\)\(2\.0\) - 1L \+ \(\(long\)\(1\.0\) - 1L\) \* M\.rows\] = 99\.0;/
    );
  });

  it("v(end) = x resolves end via numel for a 1-slot write", () => {
    const c = translate("v = [1 2 3 4];\nv(end) = 99;\ndisp(v);\n");
    expect(c).toMatch(
      /v\.real\[\(long\)\(\(v\.rows \* v\.cols\)\) - 1L\] = 99\.0;/
    );
  });

  it("does NOT emit an early free between an Assign and a subsequent IndexStore", () => {
    // Regression test: the future-touch dataflow must see IndexStore
    // as a use of its base. If it's missing, the prior Assign's
    // dead-after pass would emit `mtoc_tensor_free(&v)` before the
    // `v(2) = 99;` write, corrupting the program.
    const c = translate("v = [10 20 30];\nv(2) = 99;\ndisp(v);\n");
    const assignIdx = c.indexOf("mtoc_tensor_assign(&v,");
    const writeIdx = c.indexOf("v.real[(long)(2.0) - 1L] = 99.0;");
    const freeIdx = c.indexOf("mtoc_tensor_free(&v);");
    expect(assignIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    // The IndexStore must precede any free — and the only free
    // emitted should be the final scope-exit free.
    expect(writeIdx).toBeLessThan(freeIdx);
    // Exactly one free of v across the whole program (the scope-exit
    // safety net).
    expect((c.match(/mtoc_tensor_free\(&v\);/g) ?? []).length).toBe(1);
  });

  it("writes both .real and .imag for a complex RHS into a complex base", () => {
    const c = translate("z = [1+2i, 3+4i];\nz(1) = 7+8i;\ndisp(z);\n");
    // Complex RHS path: stash + creal/cimag.
    expect(c).toMatch(/double _Complex _mtoc_rhs = .*7\.0.* \+ .*8\.0.* I/);
    expect(c).toMatch(/z\.real\[_mtoc_off\] = creal\(_mtoc_rhs\);/);
    expect(c).toMatch(/z\.imag\[_mtoc_off\] = cimag\(_mtoc_rhs\);/);
  });

  it("writes .imag = 0.0 for a real RHS into a complex base (numbl semantics)", () => {
    const c = translate("z = [1+2i, 3+4i];\nz(2) = 99;\ndisp(z);\n");
    expect(c).toMatch(/z\.real\[_mtoc_off\] = 99\.0;/);
    expect(c).toMatch(/z\.imag\[_mtoc_off\] = 0\.0;/);
  });

  it("rejects a complex RHS into a real-typed base with a TypeError", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\nv(1) = 1 + 2i;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("TypeError");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/imaginary/i);
  });

  it("rejects a tensor RHS in an indexed write", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\nw = [4 5];\nv(1) = w;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("TypeError");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/numeric scalar/i);
  });

  it("rejects an indexed write into a char tensor (deferred)", () => {
    let err: unknown;
    try {
      translate("s = 'abc';\ns(1) = 'z';\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/char tensor/i);
  });

  it("rejects a TensorLit RHS in a range write (must be Var or scalar)", () => {
    // Range writes with a Var RHS or a scalar RHS work; the user
    // has to materialize a TensorLit into a name first so the
    // intermediate's lifetime is observable. Earlier this whole
    // form was rejected outright; now only the TensorLit RHS is.
    let err: unknown;
    try {
      translate("v = [1 2 3 4];\nv(2:3) = [99 88];\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/named tensor variable/i);
  });

  it("rejects an indexed write into a scalar variable", () => {
    let err: unknown;
    try {
      translate("x = 5;\nx(1) = 99;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
  });
});

describe("indexing — range and colon writes", () => {
  it("emits a per-slot loop and runtime count check for v(a:b) = w", () => {
    const c = translate(
      "v = [1 2 3 4 5];\nw = [10 20];\nv(2:3) = w;\ndisp(v);\n"
    );
    // The codegen emits the count formula + a runtime check before
    // the loop.
    expect(c).toMatch(/long _mtoc_n = \(long\)floor\(/);
    expect(c).toContain("long _mtoc_rhs_n = w.rows * w.cols;");
    expect(c).toContain("if (_mtoc_n != _mtoc_rhs_n)");
    expect(c).toContain("range-write count mismatch");
    // Loop body writes into the base from rhs, with the dst offset
    // from the range formula.
    expect(c).toMatch(/v\.real\[_mtoc_dst\] = w\.real\[_mtoc_k\];/);
  });

  it("v(:) = w emits the column-flat copy without a range formula", () => {
    const c = translate("v = [1 2 3];\nw = [9 8 7];\nv(:) = w;\ndisp(v);\n");
    // Colon: count = base.rows * base.cols; dst offset is just k.
    expect(c).toContain("long _mtoc_n = v.rows * v.cols;");
    expect(c).toMatch(/long _mtoc_dst = _mtoc_k;/);
    expect(c).toMatch(/v\.real\[_mtoc_dst\] = w\.real\[_mtoc_k\];/);
  });

  it("scalar RHS broadcasts via a stashed _mtoc_rhs", () => {
    const c = translate("v = [1 2 3 4];\nv(2:3) = -1;\ndisp(v);\n");
    // Stash + per-slot write of the same value.
    expect(c).toMatch(/double _mtoc_rhs = -1\.0;/);
    expect(c).toMatch(/v\.real\[_mtoc_dst\] = _mtoc_rhs;/);
  });

  it("real-tensor RHS into a complex base zeros the imag side per slot", () => {
    const c = translate(
      "z = [1+2i, 3+4i, 5+6i];\nw = [10 20];\nz(1:2) = w;\ndisp(z);\n"
    );
    expect(c).toMatch(/z\.real\[_mtoc_dst\] = w\.real\[_mtoc_k\];/);
    expect(c).toMatch(/z\.imag\[_mtoc_dst\] = 0\.0;/);
  });

  it("complex-tensor RHS into a complex base copies both halves", () => {
    const c = translate(
      "z = [1+2i, 3+4i];\nw = [7+8i, 9+10i];\nz(:) = w;\ndisp(z);\n"
    );
    expect(c).toMatch(/z\.real\[_mtoc_dst\] = w\.real\[_mtoc_k\];/);
    expect(c).toMatch(/z\.imag\[_mtoc_dst\] = w\.imag\[_mtoc_k\];/);
  });

  it("complex scalar broadcast stashes both halves once", () => {
    const c = translate("z = [1+2i, 3+4i];\nz(:) = 1+1i;\ndisp(z);\n");
    expect(c).toMatch(/double _Complex _mtoc_rhs = /);
    expect(c).toMatch(/double _mtoc_rhs_re = creal\(_mtoc_rhs\);/);
    expect(c).toMatch(/double _mtoc_rhs_im = cimag\(_mtoc_rhs\);/);
    expect(c).toMatch(/z\.real\[_mtoc_dst\] = _mtoc_rhs_re;/);
    expect(c).toMatch(/z\.imag\[_mtoc_dst\] = _mtoc_rhs_im;/);
  });

  it("rejects a non-Var tensor RHS in a range write", () => {
    // The user must materialize a TensorLit RHS into a name first.
    let err: unknown;
    try {
      translate("v = [1 2 3 4];\nv(2:3) = [99 98];\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/named tensor variable/i);
  });

  it("rejects a complex RHS into a real base", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3 4];\nw = [1+2i, 3+4i];\nv(2:3) = w;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("TypeError");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/imaginary/i);
  });

  it("rejects char-tensor range writes", () => {
    let err: unknown;
    try {
      translate("s = 'abc';\nw = [99 98];\ns(1:2) = w;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/char tensor/i);
  });

  it("rejects a non-literal step in a range write", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3 4 5];\nw = [99 98];\ns = 2;\nv(1:s:5) = w;\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/numeric literal/i);
  });
});
