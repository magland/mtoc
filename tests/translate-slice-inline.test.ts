import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

/**
 * Tests for the column/row-slice inlining peephole
 * (`src/codegen/opt/inlineColumnSlice.ts`).
 *
 * The peephole recognizes `Assign` producers of the form
 * `_anf = base(:, k)` or `_anf = base(k, :)` and inlines the slice
 * read into a downstream elementwise consumer, eliminating the
 * slice's allocation and copy loop.
 *
 * Each test pins both the structural change in the emitted C (the
 * inlined read appears; the producer's loop is gone) and the
 * boundary conditions where the peephole correctly declines.
 */

describe("column/row slice inlining", () => {
  it("inlines a column slice into a broadcast consumer", () => {
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 1);\n" +
        "  row = m(1, :);\n" +
        "  r = col + row;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // Both slice producers' alloc loops are elided (their source
    // comments still appear, but no per-slice alloc remains).
    expect(fnBody).toMatch(/\/\* col = m\(:, 1\) \*\//);
    expect(fnBody).toMatch(/\/\* row = m\(1, :\) \*\//);
    // The consumer's loop body reads from `m` directly with the
    // column-major offset, not from a separate `col.real` /
    // `row.real` slice handle.
    expect(fnBody).toMatch(
      /m\.real\[_mtoc_k0 \+ _mtoc_inline_col_fixed \* m\.dims\[0\]\]/
    );
    expect(fnBody).toMatch(
      /m\.real\[_mtoc_inline_row_fixed \+ _mtoc_k1 \* m\.dims\[0\]\]/
    );
    // Hoisted fixed-index locals declared with the 1-based-to-0-
    // based conversion.
    expect(fnBody).toMatch(
      /long _mtoc_inline_col_fixed = \(long\)\(1\.0\) - 1L;/
    );
    expect(fnBody).toMatch(
      /long _mtoc_inline_row_fixed = \(long\)\(1\.0\) - 1L;/
    );
    // No `col`/`row` staging-buffer alloc remains in the function
    // body. The broadcast consumer's single alloc is the only one.
    const allocs = fnBody.match(/_mtoc_t = mtoc_tensor_alloc/g) ?? [];
    expect(allocs.length).toBe(1);
  });

  it("inlines a column slice into a flat-iter consumer", () => {
    // Two same-shape column slices from the same base feed a
    // flat-iter elementwise consumer. Both slices inline; the
    // consumer's shape source resolves to `base.dims[0], 1L`.
    const c = translate(
      "function r = f(m)\n" +
        "  a = m(:, 1);\n" +
        "  b = m(:, 2);\n" +
        "  r = a + b;\n" +
        "end\n" +
        "M = ones(4, 3);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // No per-slice slice-alloc remains.
    const sliceAllocs = fnBody.match(/_mtoc_t = mtoc_tensor_alloc_nd/g) ?? [];
    expect(sliceAllocs.length).toBe(0);
    // The consumer's flat-iter alloc reads its shape from `m`'s
    // dims[0] with the slice's fixed axis folded to 1L.
    expect(fnBody).toMatch(/mtoc_tensor_alloc\(m\.dims\[0\], 1L\)/);
    // Body reads both operands directly from `m`.
    expect(fnBody).toMatch(
      /m\.real\[_mtoc_i \+ _mtoc_inline_a_fixed \* m\.dims\[0\]\] \+ m\.real\[_mtoc_i \+ _mtoc_inline_b_fixed \* m\.dims\[0\]\]/
    );
  });

  it("does NOT inline when the slice is used twice", () => {
    // `col` is read by both `r1` and `r2`. Single-use precondition
    // fails; the slice materializes.
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 1);\n" +
        "  r1 = col + 1;\n" +
        "  r2 = col * 2;\n" +
        "  r = r1 + r2;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // The slice's own alloc-and-copy loop is emitted.
    expect(fnBody).toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
    // The consumer reads from `col.real`, not directly from `m`.
    expect(fnBody).toMatch(/col\.real\[_mtoc_i\] \+ 1\.0/);
  });

  it("does NOT inline when a stmt between producer and consumer writes the base", () => {
    // `m(1, 1) = 99` mutates the base between the slice and the
    // consumer. The peephole must bail or the consumer reads stale
    // values.
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 1);\n" +
        "  m(1, 1) = 99;\n" +
        "  r = col + 1;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // The slice's alloc-and-copy loop is emitted.
    expect(fnBody).toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
    // The consumer reads from `col.real[...]`, not from `m`.
    expect(fnBody).toMatch(/col\.real\[_mtoc_i\]/);
  });

  it("does NOT inline across an If boundary", () => {
    const c = translate(
      "function r = f(m, flag)\n" +
        "  col = m(:, 1);\n" +
        "  if flag > 0\n" +
        "    disp(m);\n" +
        "  end\n" +
        "  r = col + 1;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M, 1));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // The slice materializes; the If was an opaque mutation point.
    expect(fnBody).toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
  });

  it("does NOT inline when the consumer is non-elementwise (e.g. transpose)", () => {
    // `col = m(:, 1)` then `t = col.'` — the consumer's RHS is a
    // direct `mtoc_tensor_transpose(...)` call (an owned producer),
    // not an iter-loop elementwise stmt. The slice must materialize.
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 1);\n" +
        "  t = col.';\n" +
        "  r = t + 1;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
  });

  it("respects disableOptimizations=true", () => {
    const src =
      "function r = f(m)\n" +
      "  col = m(:, 1);\n" +
      "  r = col + 1;\n" +
      "end\n" +
      "M = ones(3, 4);\n" +
      "disp(f(M));\n";
    const opt = translate(src);
    const noOpt = translate(src, { disableOptimizations: true });
    // With optimization, the slice's alloc-and-copy loop is gone.
    const optFn = opt.slice(
      opt.indexOf("static mtoc_tensor_t f__"),
      opt.indexOf("\n}\n", opt.indexOf("static mtoc_tensor_t f__"))
    );
    expect(optFn).not.toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
    // Without optimization, the slice materializes.
    const noOptFn = noOpt.slice(
      noOpt.indexOf("static mtoc_tensor_t f__"),
      noOpt.indexOf("\n}\n", noOpt.indexOf("static mtoc_tensor_t f__"))
    );
    expect(noOptFn).toMatch(/_mtoc_t = mtoc_tensor_alloc_nd/);
  });

  it("keeps the slice's source-line comment above the consumer", () => {
    // The producer's emission is skipped, but its IR-render comment
    // still emits so the C reader can trace each numbl statement.
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 2);\n" +
        "  r = col + 1;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    const colCommentIdx = fnBody.indexOf("/* col = m(:, 2) */");
    const rCommentIdx = fnBody.indexOf("/* r = col + 1 */");
    expect(colCommentIdx).toBeGreaterThan(-1);
    expect(rCommentIdx).toBeGreaterThan(-1);
    expect(colCommentIdx).toBeLessThan(rCommentIdx);
  });

  it("keeps the base alive until after the inlined consumer", () => {
    // With the producer skipped, the base's last touch moves from
    // the producer's slot to the consumer's slot. The free should
    // appear AFTER the consumer's fused loop, not between.
    const c = translate(
      "function r = f(m)\n" +
        "  col = m(:, 1);\n" +
        "  r = col + 1;\n" +
        "end\n" +
        "M = ones(3, 4);\n" +
        "disp(f(M));\n"
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    const inlineReadIdx = fnBody.indexOf(
      "m.real[_mtoc_i + _mtoc_inline_col_fixed * m.dims[0]]"
    );
    const freeMIdx = fnBody.indexOf("mtoc_tensor_free(&m);");
    expect(inlineReadIdx).toBeGreaterThan(-1);
    expect(freeMIdx).toBeGreaterThan(-1);
    expect(freeMIdx).toBeGreaterThan(inlineReadIdx);
  });
});
