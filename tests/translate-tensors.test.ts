import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cliPath, translate } from "./_helpers.js";

describe("early tensor frees", () => {
  // Every tensor variable should be released as soon as it is no
  // longer needed, not at end-of-scope. The future-touch dataflow in
  // `src/codegen/liveness.ts` decides where the early-free site sits;
  // these assertions pin the behavior at a few representative shapes.

  it("frees tensors right after the elementwise that consumes them", () => {
    // Sketch from the prompt: `c = a + b;` makes `a` and `b` dead
    // immediately after the elementwise block, and `c` dead
    // immediately after its disp.
    const c = translate("a = [1 2 3];\nb = [4 5 6];\nc = a + b;\ndisp(c);\n");
    // Frees of a and b come BEFORE disp(c), and c is freed AFTER.
    // The closing brace of the elementwise block is a `}` line; the
    // frees follow it.
    const aIdx = c.indexOf("mtoc_tensor_free(&a);");
    const bIdx = c.indexOf("mtoc_tensor_free(&b);");
    const cIdx = c.indexOf("mtoc_tensor_free(&c);");
    const dispIdx = c.indexOf("mtoc_disp_tensor(c);");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(-1);
    expect(dispIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(dispIdx);
    expect(bIdx).toBeLessThan(dispIdx);
    expect(dispIdx).toBeLessThan(cIdx);
    // No duplicate scope-exit free for any of them — each appears
    // exactly once on the linear path.
    expect((c.match(/mtoc_tensor_free\(&a\);/g) ?? []).length).toBe(1);
    expect((c.match(/mtoc_tensor_free\(&b\);/g) ?? []).length).toBe(1);
    expect((c.match(/mtoc_tensor_free\(&c\);/g) ?? []).length).toBe(1);
  });

  it("does not insert an early free between a use and a redef", () => {
    // `v = …; disp(v); v = …; disp(v);` — the first disp's last-use
    // status is overridden by the next reassignment, which itself
    // releases the prior buffer via mtoc_tensor_assign. Only the
    // last disp triggers an early free.
    const c = translate("v = [1 2 3];\ndisp(v);\nv = [4 5 6];\ndisp(v);\n");
    const frees = c.match(/mtoc_tensor_free\(&v\);/g) ?? [];
    expect(frees.length).toBe(1);
  });

  it("frees a tensor used only inside a then-branch at the end of that branch", () => {
    // Source-level: `a` allocated at top, used only inside the
    // then-branch. The early-free site sits at the end of the
    // then-branch (after the disp); the implicit-else falls through
    // with no free of its own. The post-If scope-exit safety net
    // catches the else-path.
    const c = translate(
      "a = [1 2 3];\nflag = 1;\nif flag > 0\n  disp(a);\nend\n"
    );
    // The free appears inside the `if (...) { … }` block, after
    // mtoc_disp_tensor(a).
    expect(c).toMatch(
      /mtoc_disp_tensor\(a\);\s*\n\s*mtoc_tensor_free\(&a\);\s*\n\s*\}/
    );
    // No free emitted in an else block (there is no else block, so
    // there's no `} else {` at all — but the assertion guards against
    // an accidental future regression that adds one).
    expect(c).not.toMatch(/} else \{[^}]*mtoc_tensor_free\(&a\);/);
  });

  it("does NOT free a tensor inside a loop body that uses it across iterations", () => {
    // `a` is read inside a for loop, so the future-touch analysis
    // marks it live across iterations. The free belongs after the
    // loop, not inside the body.
    const c = translate("a = [1 2 3];\nfor k = 1:5\n  disp(a);\nend\n");
    // Locate the free of a — it must come after the closing `}` of
    // the for-loop's outer `{ … }` block. There is exactly one
    // free emitted.
    const frees = c.match(/mtoc_tensor_free\(&a\);/g) ?? [];
    expect(frees.length).toBe(1);
    // Find the for-loop opening; the free must come AFTER its
    // matching close.
    const forIdx = c.indexOf("for (long _mtoc_i =");
    const freeIdx = c.indexOf("mtoc_tensor_free(&a);");
    expect(forIdx).toBeGreaterThan(-1);
    expect(freeIdx).toBeGreaterThan(forIdx);
  });

  it("frees a tensor parameter inside the body once its last use is past", () => {
    // The function uses `v` only in the early `r = sum(v);`; after
    // that, v is dead. The early free sits right after the assign
    // to r (the last use of v), with no duplicate at the
    // function-end fall-through return.
    const c = translate(
      "disp(use_once(1));\n" +
        "function r = use_once(flag)\n" +
        "  v = [1 2 3];\n" +
        "  r = sum(v);\n" +
        "  if flag > 0\n" +
        "    r = r * 2;\n" +
        "  end\n" +
        "end\n"
    );
    // Exactly one free of v in the function body.
    const frees = c.match(/mtoc_tensor_free\(&v\);/g) ?? [];
    expect(frees.length).toBe(1);
    // The free is right after `r = mtoc_sum(v);`, BEFORE the
    // remaining if-block.
    expect(c).toMatch(
      /r = mtoc_sum\(v\);\s*\n\s*mtoc_tensor_free\(&v\);\s*\n(\s*\/\*[^\n]*\*\/\s*\n)?\s*if/
    );
  });

  it("frees only once on an explicit return path with a tensor still live", () => {
    // The early-return inside the if-then frees v before `return y;`.
    // v is also dead after the post-if `y = sum(v) * 2;` line, so a
    // SECOND free is emitted there. The implicit fall-through return
    // sees v already in the freedOwned path-tracker and does NOT
    // re-emit.
    const c = translate(
      "disp(pick(1));\n" +
        "function y = pick(flag)\n" +
        "  v = [10 20 30];\n" +
        "  y = sum(v);\n" +
        "  if flag > 0\n" +
        "    return;\n" +
        "  end\n" +
        "  y = sum(v) * 2;\n" +
        "end\n"
    );
    const frees = c.match(/mtoc_tensor_free\(&v\);/g) ?? [];
    // Exactly two: one before the early `return y;`, one before the
    // implicit fall-through `return y;`. NOT three (no duplicate at
    // the fall-through, since v was already freed earlier on that
    // linear path).
    expect(frees.length).toBe(2);
    // Pattern: free immediately before each `return y;`.
    const matches = c.match(/mtoc_tensor_free\(&v\);\s*\n\s*return y;/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe("elementwise shape check", () => {
  // The runtime helper `mtoc_check_shape` traps same-category
  // mismatches the dim lattice can't reject statically (e.g. two
  // row vectors of different runtime widths). Codegen emits one
  // call per distinct non-source multi-element Var, just before
  // the staging-buffer alloc.

  it("aborts with a clear diagnostic on shape-mismatched elementwise op", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mtoc-test-"));
    const inputM = join(tmp, "bad_shape.m");
    writeFileSync(inputM, "a = [1 2 3];\nb = [4 5];\nc = a + b;\ndisp(c);\n");
    let err: { stderr?: Buffer | string } | null = null;
    let stderr = "";
    try {
      execFileSync("npx", ["tsx", cliPath, "run", inputM], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      err = e as { stderr?: Buffer | string };
      stderr = err.stderr?.toString() ?? "";
    }
    expect(err).not.toBeNull();
    expect(stderr).toMatch(/shape mismatch/);
    expect(stderr).toMatch(/1 x 3/); // dimensions in the diagnostic
    expect(stderr).toMatch(/1 x 2/);
  });

  it("does not emit mtoc_check_shape for the same-Var case (v .* v)", () => {
    const c = translate("v = [1 2 3];\nw = v .* v;\ndisp(w);\n");
    // Only one distinct multi-element Var on the RHS, so the helper
    // is neither activated nor called. Confirm both: no body and no
    // call site.
    expect(c).not.toContain("mtoc_check_shape");
  });

  it("emits mtoc_check_shape(<source>, <other>) for two distinct multi-element Vars", () => {
    const c = translate("v = [1 2 3];\nw = [4 5 6];\nr = v + w;\ndisp(r);\n");
    // The shape-source is the first multi-element Var encountered
    // (`v`); the check is emitted against `w`.
    expect(c).toContain("mtoc_check_shape(v, w);");
    // And the helper body is present.
    expect(c).toMatch(/static void mtoc_check_shape\(/);
  });
});

describe("auto-materialized non-owned tensor temps", () => {
  // A multi-element non-Var expression at a consume-as-struct site
  // (disp, error, assert msg, fprintf args, sum/min/max/user-func
  // args) is hoisted by the ANF pass into a synthetic Assign so
  // codegen ultimately sees a Var.

  it("lifts `disp(a + b)` into a synthetic anf temp", () => {
    const c = translate("a = [1 2 3];\nb = [4 5 6];\ndisp(a + b);\n");
    // The synthetic temp holds the Binary result; disp reads it.
    expect(c).toMatch(/_mtoc_anf_\d+/);
    expect(c).toMatch(/mtoc_disp_tensor\(_mtoc_anf_\d+\)/);
    // The synthetic Assign goes through the standard elementwise
    // loop path — a per-slot body adds the two operands. The
    // staging local lands in the anf temp via mtoc_tensor_assign.
    expect(c).toMatch(/a\.real\[[^\]]+\] \+ b\.real\[[^\]]+\]/);
    expect(c).toMatch(/mtoc_tensor_assign\(&_mtoc_anf_\d+,/);
  });

  it("lifts the tensor arg of a reduction Call", () => {
    const c = translate("a = [1 2 3];\nb = [4 5 6];\ndisp(sum(a + b));\n");
    // `sum`'s arg is the lifted temp Var, not the Binary itself.
    expect(c).toMatch(/mtoc_sum\(_mtoc_anf_\d+\)/);
  });

  it("lifts a tensor arg passed into a user function", () => {
    const c = translate(
      "function y = doubled(t)\n  y = t .* 2;\nend\n" +
        "a = [1 2 3];\nz = doubled(a + 1);\ndisp(z);\n"
    );
    expect(c).toMatch(/_mtoc_anf_\d+/);
    expect(c).toMatch(/doubled__[0-9a-f]+\(.*_mtoc_anf_\d+/);
  });

  it("does NOT lift Binary RHS at the top of an elementwise Assign", () => {
    // The Assign-RHS path drives the iter loop directly; no anf
    // temp is needed for `y = a + b`.
    const c = translate("a = [1 2 3];\nb = [4 5 6];\ny = a + b;\n");
    expect(c).not.toMatch(/_mtoc_anf_/);
  });

  it("does NOT lift the tensor arg of an elementwise builtin in an Assign RHS", () => {
    // `sqrt(a + b)` at the top of an Assign goes slot-by-slot via
    // the iter loop — no temp.
    const c = translate("a = [1 2 3];\nb = [4 5 6];\ny = sqrt(a + b);\n");
    expect(c).not.toMatch(/_mtoc_anf_/);
  });
});

describe("range expressions", () => {
  // Bare `a:b` / `a:s:b` lowers to a `MakeRange` IR node that
  // materializes a 1×n row vector through the `mtoc_make_range`
  // runtime helper. Composes with all the usual owned-producer
  // sites via the ANF pass.

  it("emits mtoc_make_range for a bare range assigned to a name", () => {
    const c = translate("v = 1:5;\ndisp(v);\n");
    expect(c).toContain("mtoc_make_range(");
    // Result lands at `v` via the same assign helper TensorLit /
    // IndexSlice use.
    expect(c).toMatch(/mtoc_tensor_assign\(&v,\s*mtoc_make_range\(/);
    // Runtime helper body is included.
    expect(c).toMatch(/static mtoc_tensor_t mtoc_make_range\(/);
  });

  it("defaults the step to 1 when the source omits it", () => {
    const c = translate("v = 1:5;\ndisp(v);\n");
    // Three args: start, step (=1.0), end.
    expect(c).toMatch(/mtoc_make_range\(1\.0,\s*1\.0,\s*5\.0\)/);
  });

  it("threads an explicit float step through unchanged", () => {
    const c = translate("v = 0:0.25:1;\ndisp(v);\n");
    expect(c).toMatch(/mtoc_make_range\(0\.0,\s*0\.25,\s*1\.0\)/);
  });

  it("hoists a range nested inside a larger expression via ANF", () => {
    // `(1:5) + 1` is not a direct Assign-RHS for the range — the
    // ANF pass lifts the producer into its own synthetic Assign.
    const c = translate("v = (1:5) + 1;\ndisp(v);\n");
    expect(c).toContain("mtoc_make_range(");
    // One synthetic _mtoc_anf_<N> binding holds the lifted range.
    expect(c).toMatch(/_mtoc_anf_\d+/);
  });

  it("accepts a runtime-shaped end (range with a variable bound)", () => {
    const c = translate("n = 4;\nv = 1:n;\ndisp(v);\n");
    // The end argument is the C variable `n`, not a literal.
    expect(c).toMatch(/mtoc_make_range\(1\.0,\s*1\.0,\s*n\)/);
  });

  it("rejects a non-scalar range start with a span", () => {
    let err: Error | null = null;
    try {
      translate("a = [1 2 3];\nv = a:5;\n");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/range start must be a real scalar/);
  });
});

describe("elementwise logical `&` / `|`", () => {
  // Non-short-circuit logical AND / OR. Scalars produce a 0/1
  // double; tensor operands lift through the same broadcast emitter
  // the comparison ops use. `&&` / `||` stay scalar-only.

  it("emits `&&` / `||` C operators for scalar `&` / `|`", () => {
    const c = translate("a = 1;\nb = 0;\ndisp(a & b);\ndisp(a | b);\n");
    expect(c).toMatch(/mtoc_disp_double\(a && b\)/);
    expect(c).toMatch(/mtoc_disp_double\(a \|\| b\)/);
  });

  it("lifts `&` / `|` over same-shape tensor operands element-wise", () => {
    const c = translate("a = [1 0 1];\nb = [1 1 0];\ny = a & b;\n");
    // The elementwise iter loop emits `&&` per slot.
    expect(c).toMatch(/a\.real\[[^\]]+\] && b\.real\[[^\]]+\]/);
  });

  it("rejects `&&` on tensor operands with a pointer to the elementwise form", () => {
    let err: Error | null = null;
    try {
      translate("a = [1 0];\nb = [1 1];\ndisp(a && b);\n");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/use the elementwise '&'/);
  });
});
