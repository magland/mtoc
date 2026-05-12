import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

/**
 * Tests for the same-shape elementwise fusion optimization
 * (`src/codegen/opt/fuseSameShape.ts`).
 *
 * The peephole collapses back-to-back same-shape elementwise
 * `Assign`s into a single fused loop whenever the first statement's
 * result is consumed exactly once by the next.
 *
 * These tests pin both the positive cases (fusion fires; loop count
 * drops; comments stack) and the negative cases (fusion correctly
 * declines).
 */

/** Count the number of elementwise / broadcast staging-buffer
 *  allocations emitted into a function or main body. The flat-iter
 *  and broadcast emitters both declare their staging tensor as
 *  `mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(...)`, which is unique
 *  to the per-stmt staging buffer (the slice emitter uses
 *  `_mtoc_tensor_alloc_nd`, and the various runtime-helper bodies
 *  contain the substring `mtoc_tensor_alloc(` but not the typed-
 *  staging form). Counting that line is a precise proxy for "number
 *  of elementwise loops emitted." */
function elementwiseAllocCount(c: string): number {
  const match =
    c.match(/mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(?:_complex)?\(/g) ?? [];
  return match.length;
}

describe("same-shape elementwise fusion", () => {
  it("collapses a 2-stmt chain into one loop", () => {
    const c = translate("a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n");
    // Without fusion this would emit 2 elementwise allocs (one for
    // `b`, one for `c`). With fusion the producer's loop is skipped,
    // leaving 1.
    expect(elementwiseAllocCount(c)).toBe(1);
    // The single fused loop body computes the full chain in place
    // — no intermediate b reads.
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0;/
    );
    // Both producer + consumer comments survive, stacked above the
    // fused loop.
    const bCommentIdx = c.indexOf("/* b = a + 1 */");
    const cCommentIdx = c.indexOf("/* c = b * 2 */");
    expect(bCommentIdx).toBeGreaterThan(-1);
    expect(cCommentIdx).toBeGreaterThan(-1);
    expect(bCommentIdx).toBeLessThan(cCommentIdx);
  });

  it("collapses a 3-stmt chain transitively", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nd = b * 2;\ne = d - 5;\ndisp(e);\n"
    );
    // Three elementwise stmts → 1 loop after chain fusion.
    expect(elementwiseAllocCount(c)).toBe(1);
    // Precedence-aware printer drops redundant parens around the
    // outer subtract since `*` binds tighter than `-`.
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0 - 5\.0;/
    );
  });

  it("does NOT fuse when the producer is used twice", () => {
    // `b` is read by both `c` and `disp(b)`, so it's not single-use.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(b);\ndisp(c);\n"
    );
    // Two elementwise allocs survive: one for b, one for c.
    expect(elementwiseAllocCount(c)).toBe(2);
    // b's loop body still emits its own read.
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_i\] = a\.real\[_mtoc_i\] \+ 1\.0;/);
  });

  it("does NOT fuse a TensorLit producer", () => {
    // `a = [1 2 3 4]` is a TensorLit Assign — has its own emission
    // path, not the iter-loop elementwise emitter. Not fusion-eligible.
    const c = translate("a = [1 2 3 4];\nb = a + 1;\ndisp(b);\n");
    // The tensor literal still emits one helper call, `b` emits one
    // alloc. The TensorLit doesn't go through alloc but uses
    // mtoc_tensor_from_row — so we count differently here. Instead
    // assert the b loop emits with a Var read of a.
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_i\] = a\.real\[_mtoc_i\] \+ 1\.0;/);
  });

  it("does NOT fuse across a control-flow boundary", () => {
    // `b = a + 1` is followed by an `if`, then `c = b * 2`. The
    // intervening if-stmt resets the fusion candidate.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nif a(1) > 0\n  disp(a);\nend\nc = b * 2;\ndisp(c);\n"
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("does NOT fuse when shapes differ statically", () => {
    // Broadcast producer (1x4 + 3x1 row+col) → flat-iter consumer.
    // Different operand shapes route through the broadcast emitter;
    // the MVP only fuses flat-iter ↔ flat-iter.
    const c = translate(
      "r = [1 2 3 4];\ncol = [10; 20; 30];\nb = r + col;\nd = b * 2;\ndisp(d);\n"
    );
    // `b = r + col` is broadcast → two-loop nest. `d = b * 2` is
    // flat-iter. They don't fuse, so two elementwise allocs survive.
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("respects disableOptimizations=true", () => {
    const fused = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n"
    );
    const unfused = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n",
      { disableOptimizations: true }
    );
    expect(elementwiseAllocCount(fused)).toBe(1);
    expect(elementwiseAllocCount(unfused)).toBe(2);
    // The unfused emission keeps a `b.real[_mtoc_i<n>]` read in the
    // consumer (b is materialized). The iter index gets a numeric
    // suffix when a second elementwise loop emits in the same scope.
    expect(unfused).toMatch(/b\.real\[_mtoc_i\d*\] \* 2\.0/);
  });

  it("frees the producer's operand after the fused consumer", () => {
    // `a` is dead-after `b = a + 1` in the unfused IR; with fusion,
    // its last touch moves to the consumer. The free of `a` should
    // appear AFTER the fused loop, not between the (skipped) producer
    // and the consumer.
    const c = translate("a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n");
    const fusedLoopIdx = c.indexOf("(a.real[_mtoc_i] + 1.0) * 2.0");
    const freeAIdx = c.indexOf("mtoc_tensor_free(&a);");
    expect(fusedLoopIdx).toBeGreaterThan(-1);
    expect(freeAIdx).toBeGreaterThan(-1);
    expect(freeAIdx).toBeGreaterThan(fusedLoopIdx);
  });

  it("fires inside function bodies", () => {
    // Function-scope plan-building is independent of main's. A small
    // user-function exercises that path.
    const c = translate(
      "disp(f(ones(3, 4)));\nfunction y = f(a)\n  b = a + 1;\n  y = b * 2;\nend\n"
    );
    // One elementwise alloc inside the function specialization
    // (was 2 pre-fusion).
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    const allocs = fnBody.match(/mtoc_tensor_alloc\(/g) ?? [];
    expect(allocs.length).toBe(1);
  });

  it("does NOT fuse a producer whose cName escapes the iter-slot reach", () => {
    // `b = a + 1` then `c = b(1) + b * 2`. The consumer reads `b` both
    // as an iter-slot Var AND as an IndexLoad base. The fusion would
    // leave the IndexLoad pointing at an empty (skipped-producer)
    // handle, so the plan-builder must decline.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b(1) + b * 2;\ndisp(c);\n"
    );
    // Two elementwise allocs survive: producer + consumer.
    expect(elementwiseAllocCount(c)).toBe(2);
    // The producer's loop body must emit normally.
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_i\] = a\.real\[_mtoc_i\] \+ 1\.0;/);
  });
});
