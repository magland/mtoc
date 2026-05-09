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
