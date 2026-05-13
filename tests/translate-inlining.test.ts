import { describe, expect, it } from "vitest";

import type { IRStmt } from "../src/lowering/ir.js";
import { computeUseCounts } from "../src/codegen/inline/inlinePass.js";
import { scalarDouble, structType, type MType } from "../src/lowering/types.js";
import { translate } from "./_helpers.js";

/**
 * Tests for the tensor-expression inlining pass
 * (`src/codegen/inline/inlinePass.ts`).
 *
 * The pass substitutes every single-use multi-element Assign's RHS
 * into its unique consumer and deletes the producer. The codegen
 * then emits one loop for the larger expression that results.
 * Positive cases assert inlining fires (fewer elementwise allocs,
 * `/* inlined: ... *\/` comment trail, no surviving reads of the
 * elided var); negative cases assert the precondition gates
 * correctly decline.
 *
 * The opt-in flag is `enableTempInlining: true` — off by default
 * during rollout so the cross-runner stays byte-stable.
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

describe("tensor-expression inlining", () => {
  it("is a no-op when enableTempInlining is not set", () => {
    const src = "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n";
    const inlined = translate(src, { enableTempInlining: true });
    const unInlined = translate(src);
    expect(elementwiseAllocCount(unInlined)).toBe(2);
    expect(elementwiseAllocCount(inlined)).toBe(1);
  });

  it("collapses a 2-stmt elementwise chain into one loop", () => {
    const c = translate("a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(c);\n", {
      enableTempInlining: true,
    });
    expect(elementwiseAllocCount(c)).toBe(1);
    // The inlined body computes the full chain in place; no separate
    // read of `b` survives.
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0;/
    );
    // The original producer's `b = a + 1` Assign is gone; its
    // `assignedVars` predecl + empty-handle scope-exit free remain
    // as no-ops.
    expect(c).toMatch(/mtoc_tensor_t b = mtoc_tensor_empty\(\);/);
    expect(c).not.toMatch(/mtoc_tensor_assign\(&b,/);
    // Inlined-from comment trail: the original `b = a + 1` is preserved
    // as a `/* inlined: ... */` comment above the consumer's source-
    // line comment, so a reader of the C can see what got collapsed.
    expect(c).toMatch(
      /\/\* inlined: b = a \+ 1 \*\/\s*\n\s*\/\* c = \(a \+ 1\) \* 2 \*\//
    );
  });

  it("collapses a 3-stmt chain transitively (fixed-point)", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nd = b * 2;\ne = d - 5;\ndisp(e);\n",
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(1);
    expect(c).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 2\.0 - 5\.0;/
    );
    // Chained inlined-from comments: both producers appear above the
    // final consumer, in source order (oldest first).
    expect(c).toMatch(
      /\/\* inlined: b = a \+ 1 \*\/\s*\n\s*\/\* inlined: d = b \* 2 \*\/\s*\n\s*\/\* e = \(a \+ 1\) \* 2 - 5 \*\//
    );
  });

  it("does NOT inline when the producer is multi-use", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nc = b * 2;\ndisp(b);\ndisp(c);\n",
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("does NOT inline a TensorLit producer (only iter-loop-emitter RHSes)", () => {
    // `a = [1 2 3 4]` is a TensorLit; emit path is `emitTensorLitAssign`,
    // not the iter-loop emitter. Inlining declines, and the consumer
    // emits its own loop.
    const c = translate("a = [1 2 3 4];\nb = a + 1;\ndisp(b);\n", {
      enableTempInlining: true,
    });
    expect(c).toMatch(/_mtoc_t\.real\[_mtoc_i\] = a\.real\[_mtoc_i\] \+ 1\.0;/);
  });

  it("does NOT inline across a control-flow boundary", () => {
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\nif a(1) > 0\n  disp(a);\nend\nc = b * 2;\ndisp(c);\n",
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("inlines a broadcast producer into a flat-iter consumer", () => {
    // `b = r + col` is a broadcast result; `d = b * 2` consumes it
    // and would normally be flat-iter. After inlining, d's RHS becomes
    // `(r + col) * 2` with mixed-shape operands — the codegen routes
    // this through the broadcast emitter automatically. Only ONE
    // alloc remains.
    const c = translate(
      "r = [1 2 3 4];\ncol = [10; 20; 30];\nb = r + col;\nd = b * 2;\ndisp(d);\n",
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(1);
    // The inlined-from chain shows b's original form preserved as a
    // comment above d's source-line.
    expect(c).toMatch(/\/\* inlined: b = r \+ col \*\//);
  });

  it("does NOT inline when an intervening write touches a producer input", () => {
    // `b = a + 1` then `a(1) = 99`: `a` is mutated before `c` would
    // see it via the inlined expression. Bail.
    const c = translate(
      "a = ones(3, 4);\nb = a + 1;\na(1) = 99;\nc = b * 2;\ndisp(c);\n",
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("protects a function's output cName from being inlined out", () => {
    // `r = a + 1` is the function's return value. Even though
    // its use-count INSIDE the body is 0, the implicit return
    // counts as a use. The pass must protect it.
    const c = translate(
      "disp(f(ones(3, 4)));\nfunction r = f(a)\n  b = a + 1;\n  r = b * 2;\nend\n",
      { enableTempInlining: true }
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // One alloc (the inlined body), but the `r = ...` Assign survives
    // — its LHS is the function output, not an intermediate.
    expect(fnBody).toMatch(/mtoc_tensor_assign\(&r,/);
    expect(fnBody.match(/mtoc_tensor_alloc\(/g)?.length).toBe(1);
  });

  it("fires inside function bodies independently of main", () => {
    const c = translate(
      "disp(f(ones(3, 4)));\nfunction y = f(a)\n  b = a + 1;\n  c = b * 2;\n  y = c - 5;\nend\n",
      { enableTempInlining: true }
    );
    const fnStart = c.indexOf("static mtoc_tensor_t f__");
    const fnEnd = c.indexOf("\n}\n", fnStart);
    const fnBody = c.slice(fnStart, fnEnd);
    // Three-step chain → one inlined loop.
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
      { enableTempInlining: true }
    );
    expect(elementwiseAllocCount(c)).toBe(2);
  });

  it("emits numerically identical output when inlining fires (small e2e)", () => {
    // Same input, inlined vs un-inlined — the printed body Assign
    // should compute the same per-element formula. We can't easily
    // run both binaries here; instead assert the inlined C contains
    // both operand reads directly (no intermediate `b.real[]`).
    // Use a direct-owned producer for `a` (ones() alone, no arithmetic)
    // so ANF doesn't lift it and the pass leaves it materialized.
    // Then b → c is the inlining candidate.
    const src = "a = ones(3, 4);\nb = a + 1;\nc = b * 0.5;\ndisp(c);\n";
    const inlined = translate(src, { enableTempInlining: true });
    expect(inlined).toMatch(
      /_mtoc_t\.real\[_mtoc_i\] = \(a\.real\[_mtoc_i\] \+ 1\.0\) \* 0\.5;/
    );
    // No read of `b` survives.
    expect(inlined).not.toMatch(/b\.real\[/);
  });
});

describe("inlinePass.computeUseCounts", () => {
  it("counts Var reads inside MemberStore RHS", () => {
    // Regression: the prior hand-rolled `countVarRefsInStmt` switch
    // had no MemberStore arm — Var reads in `s.f = <rhs>` were
    // silently undercounted, so a producer whose only consumer was a
    // field write could be miscategorized as use=0 (skip-inline,
    // benign) or, worse, an additional MemberStore use could go
    // unseen and the inliner would substitute over a still-live read.
    const span = { file: "test", start: 0, end: 0 };
    const numTy: MType = scalarDouble("unknown");
    const sTy: MType = structType([{ name: "f", type: numTy }]);
    const memberStore: IRStmt = {
      kind: "MemberStore",
      base: {
        kind: "Var",
        name: "s",
        cName: "s",
        ty: sTy,
        span,
      },
      fieldPath: ["f"],
      leafTy: numTy,
      rhs: {
        kind: "Var",
        name: "b",
        cName: "b",
        ty: numTy,
        span,
      },
      span,
    };
    const counts = computeUseCounts([memberStore], new Set());
    expect(counts.get("b")).toBe(1);
    // The struct base itself is also read.
    expect(counts.get("s")).toBe(1);
  });
});
