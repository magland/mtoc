import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

/**
 * Tests for the transpose inlining peephole
 * (`src/codegen/opt/inlineTranspose.ts`).
 *
 * The peephole recognizes `Assign` producers of the form
 * `_anf = base.'` (a direct `mtoc_tensor_transpose` call whose arg
 * is a Var) and inlines the swap-axis read into a downstream
 * BROADCAST elementwise consumer, eliminating the transpose's
 * allocation and copy loop.
 *
 * For the MVP, the consumer must be broadcast — flat-iter
 * substitution would need div/mod for the swap-axis math.
 */

describe("transpose inlining", () => {
  it("inlines a column-vec transpose against a column-vec into a broadcast consumer", () => {
    // `col` is a column [notOne, one]; `t = col.'` flips it to a
    // row [one, notOne]; `col + t` then broadcasts to a square
    // matrix. After fusion, the transpose loop is gone and `t`'s
    // read becomes a direct swapped-offset read of `col`.
    const c = translate(
      "function r = f(col)\n" +
        "  t = col.';\n" +
        "  r = col + t;\n" +
        "end\n" +
        "C = [10; 20; 30];\n" +
        "disp(f(C));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // No materialized transpose call survives.
    expect(fnBody).not.toMatch(/mtoc_tensor_transpose\(col\)/);
    // The body reads `col` directly with a swapped offset. With
    // `col`'s static shape `[notOne, one]`, the transpose's output
    // has static shape `[one, notOne]`, so transpose-axis-0 = 0
    // (drops) and transpose-axis-1 = k1 — the `inlinedTransposeRead`
    // simplification path emits `col.real[k1]`.
    expect(fnBody).toMatch(/col\.real\[_mtoc_k1\]/);
  });

  it("inlines a row-vec transpose against a row-vec into a broadcast consumer", () => {
    // Mirror of the previous test: row `[one, notOne]` transposes
    // to `[notOne, one]`. `row + t` broadcasts to a matrix.
    const c = translate(
      "function r = f(row)\n" +
        "  t = row.';\n" +
        "  r = row + t;\n" +
        "end\n" +
        "R = [1 2 3 4];\n" +
        "disp(f(R));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/mtoc_tensor_transpose\(row\)/);
    // With row's static shape `[one, notOne]`, the transpose's
    // output is `[notOne, one]`: transpose-axis-0 = k0,
    // transpose-axis-1 = 0 (drops). Simplification emits
    // `row.real[k0 * row.dims[0]]`.
    expect(fnBody).toMatch(/row\.real\[_mtoc_k0 \* row\.dims\[0\]\]/);
  });

  it("does NOT inline when the transpose is used twice", () => {
    const c = translate(
      "function r = f(col)\n" +
        "  t = col.';\n" +
        "  a = col + t;\n" +
        "  b = col - t;\n" +
        "  r = a + b;\n" +
        "end\n" +
        "C = [10; 20; 30];\n" +
        "disp(f(C));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/mtoc_tensor_transpose\(col\)/);
  });

  it("does NOT inline when the consumer is flat-iter (same static shape)", () => {
    // `t = row.'` produces shape `[notOne, one]`. The consumer
    // `col + t` has BOTH operands of shape `[notOne, one]`, so the
    // emitter routes to flat-iter — which the transpose MVP
    // doesn't handle.
    const c = translate(
      "function r = f(col, row)\n" +
        "  t = row.';\n" +
        "  r = col + t;\n" +
        "end\n" +
        "C = [10; 20; 30];\n" +
        "R = [1 2 3];\n" +
        "disp(f(C, R));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/mtoc_tensor_transpose\(row\)/);
  });

  it("does NOT inline when a stmt between producer and consumer writes the base", () => {
    const c = translate(
      "function r = f(col)\n" +
        "  t = col.';\n" +
        "  col(1) = 99;\n" +
        "  r = col + t;\n" +
        "end\n" +
        "C = [10; 20; 30];\n" +
        "disp(f(C));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/mtoc_tensor_transpose\(col\)/);
  });

  it("respects disableOptimizations=true", () => {
    const src =
      "function r = f(col)\n" +
      "  t = col.';\n" +
      "  r = col + t;\n" +
      "end\n" +
      "C = [10; 20; 30];\n" +
      "disp(f(C));\n";
    const opt = translate(src);
    const noOpt = translate(src, { disableOptimizations: true });
    const optFn = opt.slice(
      opt.indexOf("static mtoc_tensor_t f__"),
      opt.indexOf("\n}\n", opt.indexOf("static mtoc_tensor_t f__"))
    );
    const noOptFn = noOpt.slice(
      noOpt.indexOf("static mtoc_tensor_t f__"),
      noOpt.indexOf("\n}\n", noOpt.indexOf("static mtoc_tensor_t f__"))
    );
    expect(optFn).not.toMatch(/mtoc_tensor_transpose\(col\)/);
    expect(noOptFn).toMatch(/mtoc_tensor_transpose\(col\)/);
  });

  it("keeps the producer comment above the consumer's fused loop", () => {
    const c = translate(
      "function r = f(col)\n" +
        "  t = col.';\n" +
        "  r = col + t;\n" +
        "end\n" +
        "C = [10; 20; 30];\n" +
        "disp(f(C));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // Lowering renders transpose as `transpose(col)` rather than
    // `col.'`, so the comment uses the prefix form.
    const tIdx = fnBody.indexOf("/* t = transpose(col) */");
    const rIdx = fnBody.indexOf("/* r = col + t */");
    expect(tIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeGreaterThan(-1);
    expect(tIdx).toBeLessThan(rIdx);
  });
});
