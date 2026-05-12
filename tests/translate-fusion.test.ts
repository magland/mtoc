import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

/**
 * Tests for the tensor-expression inlining pass
 * (`src/codegen/fuse/inlinePass.ts`).
 *
 * The pass collapses chains of single-use elementwise Assigns where
 * both producer and consumer go through the flat-iter (same-shape)
 * codegen path. Positive cases assert that fusion fires and the
 * resulting C has fewer elementwise loops; negative cases assert
 * the precondition gates correctly decline.
 *
 * The opt-in flag is `enableTensorFusion: true` — off by default
 * during MVP rollout so the cross-runner stays byte-stable.
 */

/** Count the number of elementwise / broadcast staging-buffer
 *  allocations emitted into a function or main body. The flat-iter
 *  and broadcast emitters both declare their staging tensor as
 *  `mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(...)`. Counting that
 *  line is a precise proxy for "number of elementwise loops emitted." */
function elementwiseAllocCount(c: string): number {
  const match =
    c.match(/mtoc_tensor_t _mtoc_t = mtoc_tensor_alloc(?:_complex)?\(/g) ?? [];
  return match.length;
}

describe("tensor-expression inlining (V2 MVP)", () => {
  it("is a no-op when enableTensorFusion is not set", () => {
    const src = "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n";
    const fused = translate(src, { enableTensorFusion: true });
    const unfused = translate(src);
    expect(elementwiseAllocCount(unfused)).toBe(2);
    expect(elementwiseAllocCount(fused)).toBe(1);
  });

  it("collapses a 2-stmt elementwise chain into one loop", () => {
    const c = translate("a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n", {
      enableTensorFusion: true,
    });
    expect(elementwiseAllocCount(c)).toBe(1);
    // The fused body computes the full chain in place; no separate
    // read of `b` survives.
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0;/
    );
    // The original producer's `b = a + 1` Assign is gone; its
    // `assignedVars` predecl + empty-handle scope-exit free remain
    // as no-ops.
    expect(c).toMatch(/mtoc_tensor_t b = mtoc_tensor_empty\(\);/);
    expect(c).not.toMatch(/mtoc_tensor_assign\(&b,/);
  });

  it("collapses a 3-stmt chain transitively (fixed-point)", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nd = b * 2;\ne = d - 5;\ndisp(e);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(1);
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0 - 5\.0;/
    );
  });

  it("does NOT fuse when the producer is multi-use", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(b);\ndisp(c);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("does NOT fuse a TensorLit producer (only iter-loop-emitter RHSes)", () => {
    // `a = [1 2 3 4]` is a TensorLit; emit path is `emitTensorLitAssign`,
    // not the iter-loop emitter. Fusion declines, and the consumer
    // emits its own loop.
    const c = translate("a = [1 2 3 4];\nb = a + 1;\ndisp(b);\n", {
      enableTensorFusion: true,
    });
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_i\] = a\.real\[_mtoc_i\] \+ 1\.0;/);
  });

  it("does NOT fuse across a control-flow boundary", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nif a(1) > 0\n  disp(a);\nend\nc = b * 2;\ndisp(c);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("does NOT fuse when shapes differ statically (broadcast — V3 territory)", () => {
    // `b = r + col` produces a [3,4] matrix via broadcast; `d = b * 2`
    // is then flat-iter. MVP only handles flat→flat fusion.
    const c = translate(
      "r = [1 2 3 4];\ncol = [10; 20; 30];\nb = r + col;\nd = b * 2;\ndisp(d);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("does NOT fuse when an intervening write touches a producer input", () => {
    // `b = a + 1` then `a(1) = 99`: `a` is mutated before `c` would
    // see it via the fused expression. Bail.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\na(1) = 99;\nc = b * 2;\ndisp(c);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("protects a function's output cName from being inlined out", () => {
    // `r = a + 1` is the function's return value. Even though
    // its use-count INSIDE the body is 0, the implicit return
    // counts as a use. Pass 1 must protect it.
    const c = translate(
      "disp(f(ones(3, 4)));\nfunction r = f(a)\n  b = a + 1;\n  r = b * 2;\nend\n",
      { enableTensorFusion: true }
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // One alloc (the fused body), but the `r = ...` Assign survives
    // — its LHS is the function output, not an intermediate.
    expect(fnBody).toMatch(/mtoc_tensor_assign\(&r,/);
    expect(fnBody.match(/mtoc_tensor_alloc\(/g)?.length).toBe(1);
  });

  it("fires inside function bodies independently of main", () => {
    const c = translate(
      "disp(f(ones(3, 4)));\nfunction y = f(a)\n  b = a + 1;\n  c = b * 2;\n  y = c - 5;\nend\n",
      { enableTensorFusion: true }
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // Three-step chain → one fused loop.
    const allocs = fnBody.match(/mtoc_tensor_alloc\(/g) ?? [];
    expect(allocs.length).toBe(1);
  });

  it("declines when the producer's cName appears as IndexLoad.base", () => {
    // `b = a + 1; c = b(1) + b * 2` — `b` appears as both a Var
    // (iter-slot) AND an IndexLoad base. Substitution would leave
    // the IndexLoad pointing at the now-empty `b` handle. The
    // appearsInNonSlotPosition gate must bail.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b(1) + b * 2;\ndisp(c);\n",
      { enableTensorFusion: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("emits numerically identical output when fusion fires (small e2e)", () => {
    // Same input, fused vs unfused — the printed body Assign should
    // compute the same per-element formula. We can't easily run
    // both binaries here; instead assert the fused C contains both
    // operand reads directly (no intermediate `b.real[]`).
    // Use a direct-owned producer for `a` (ones() alone, no arithmetic)
    // so ANF doesn't lift it and pass 1 leaves it materialized. Then
    // b → c is the fusion candidate.
    const src = "a = ones(3, 4);\nb = a + 1;\nc = b * 0.5;\ndisp(c);\n";
    const fused = translate(src, { enableTensorFusion: true });
    expect(fused).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 0\.5;/
    );
    // No read of `b` survives.
    expect(fused).not.toMatch(/b\.real\[/);
  });
});
