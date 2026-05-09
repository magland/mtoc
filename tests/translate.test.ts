import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";
import { emitC } from "../src/codegen/emit.js";
import {
  canonicalizeType,
  isString,
  STRING,
  unify,
  type NumericType,
} from "../src/lowering/types.js";
// Note: parseMFile / Workspace / lower are also used directly by the
// IRStmt.Disp assertion below (it inspects the lowered IR rather than
// the emitted C, to exercise the lowering boundary explicitly).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const example1Path = join(repoRoot, "examples", "example1.m");

function translate(
  source: string,
  opts: { includeRuntime?: boolean } = {}
): string {
  const ast = parseMFile(source, "test.m");
  const ws = new Workspace("test.m");
  ws.addFile({ name: "test.m", source, ast });
  return emitC(lower(ast, ws), opts);
}

describe("translate scalar example", () => {
  it("emits expected C for example1.m", () => {
    const source = readFileSync(example1Path, "utf8");
    const c = translate(source);
    expect(c).toContain("#include <stdio.h>");
    // Vars predeclared at top of main; assignments come later.
    expect(c).toMatch(/double x = 0\.0;/);
    expect(c).toMatch(/double y = 0\.0;/);
    expect(c).toMatch(/double z = 0\.0;/);
    expect(c).toMatch(/^\s*x = 3\.0;/m);
    expect(c).toMatch(/^\s*y = 4\.5;/m);
    expect(c).toMatch(/^\s*z = x \+ y \* 2\.0;/m);
    expect(c).toContain("mtoc_disp_double(z);");
    expect(c).toContain("return 0;");
  });

  it("emits second assignment without re-declaring", () => {
    const source = "x = 1;\nx = x + 1;\ndisp(x);\n";
    const c = translate(source);
    // `x` is declared once at the top with the zero default.
    const decls = c.match(/double x = 0\.0;/g) ?? [];
    expect(decls.length).toBe(1);
    expect(c).toMatch(/^\s*x = 1\.0;/m);
    expect(c).toMatch(/^\s*x = x \+ 1\.0;/m);
  });

  it("rejects char literals with a clear pointer to use double-quoted strings", () => {
    // Single-quoted char literals are deferred — numbl semantics for
    // char (a row-vector of code units) diverge from string (a scalar
    // handle), so the lowerer rejects with a span and points the user
    // at the supported `"..."` form.
    let err: unknown;
    try {
      translate("s = 'hi';");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/char/i);
    expect(e.message).toMatch(/double-quoted/);
  });

  it("accepts a row-vector literal (dynamic-shape allocation)", () => {
    const c = translate("v = [1 2 3]; disp(v);");
    // Predeclared empty via the helper; the assignment collapses to
    // one helper-pair line — `mtoc_tensor_assign(&v,
    // mtoc_tensor_from_row((double[]){...}, 3))`.
    expect(c).toContain("mtoc_tensor_t v = mtoc_tensor_empty();");
    expect(c).toContain(
      "mtoc_tensor_assign(&v, mtoc_tensor_from_row((double[]){1.0, 2.0, 3.0}, 3));"
    );
    expect(c).toContain("mtoc_disp_tensor(v);");
  });

  it("rejects undefined variable use", () => {
    expect(() => translate("y = z + 1;")).toThrow(/undefined variable 'z'/);
  });

  it("accepts sqrt of a known-positive literal", () => {
    const c = translate("disp(sqrt(2));\n");
    expect(c).toContain("sqrt(2.0)");
    expect(c).toContain("#include <math.h>");
  });

  it("accepts sqrt(abs(x)) because abs forces nonneg", () => {
    const c = translate("x = -5;\ndisp(sqrt(abs(x)));\n");
    expect(c).toContain("sqrt(fabs(x))");
  });

  it("rejects sqrt(x) when x is not provably nonneg", () => {
    // x is assigned a negative literal so its sign is 'negative'.
    expect(() => translate("x = -5;\ndisp(sqrt(x));\n")).toThrow(
      /sqrt requires .* to be statically nonnegative/
    );
  });

  it("sqrt(x) rejection flows through params[0].domain (reports arg sign)", () => {
    // The `validateDomain` path off `BuiltinSig.params[0].domain`
    // includes the inferred sign in its message — proves the error
    // came from the registry-driven domain check rather than an
    // ad-hoc string compare.
    expect(() => translate("x = -5;\ndisp(sqrt(x));\n")).toThrow(
      /got sign='negative'/
    );
  });

  it("disp(x) lowers via IRStmt.Disp (statement-only path)", () => {
    // The registry entry for `disp` has `category: "stmt"`; the
    // ExprStmt(disp(...)) shortcut in lower.ts must produce an
    // `IRStmt.Disp` node so codegen picks the dedicated runtime
    // helper rather than emitting a value-bearing call.
    const source = "x = 1;\ndisp(x);\n";
    const ast = parseMFile(source, "test.m");
    const ws = new Workspace("test.m");
    ws.addFile({ name: "test.m", source, ast });
    const ir = lower(ast, ws);
    const dispStmts = ir.stmts.filter(s => s.kind === "Disp");
    expect(dispStmts.length).toBe(1);
  });

  it("rejects log(x) when x is not provably positive", () => {
    expect(() => translate("x = 0;\ndisp(log(x));\n")).toThrow(
      /log requires .* to be statically positive/
    );
  });

  it("does not split a tensor reassignment at a different runtime shape", () => {
    // After dim coarsening, `[1 2 3]` and `[1 2 3 4]` share the same
    // coarse type (row vector with `cols: notOne`); the second
    // assignment goes through the same `mtoc_tensor_assign` helper
    // and reuses the predeclared `v` rather than introducing a
    // fresh `_mtoc_v__v<N>` binding.
    const c = translate("v = [1 2 3];\ndisp(v);\nv = [1 2 3 4];\ndisp(v);\n");
    expect(c).toContain("mtoc_tensor_t v = mtoc_tensor_empty();");
    // No split binding.
    expect(c).not.toMatch(/_mtoc_v__v/);
    // Two assignment-site helper calls, both consuming a freshly-
    // built tensor of the right runtime shape.
    const assigns = c.match(/mtoc_tensor_assign\(&v, /g) ?? [];
    expect(assigns.length).toBe(2);
    expect(c).toContain(
      "mtoc_tensor_assign(&v, mtoc_tensor_from_row((double[]){1.0, 2.0, 3.0}, 3));"
    );
    expect(c).toContain(
      "mtoc_tensor_assign(&v, mtoc_tensor_from_row((double[]){1.0, 2.0, 3.0, 4.0}, 4));"
    );
    // Single scope-exit free; the two assignments consume their old
    // buffers internally.
    const frees = c.match(/mtoc_tensor_free\(&v\);/g) ?? [];
    expect(frees.length).toBe(1);
  });

  it("splits a scalar→tensor top-level reassignment", () => {
    const c = translate("x = 4;\ndisp(x);\nx = [1 2 3];\ndisp(x);\n");
    expect(c).toMatch(/double x = 0\.0;/);
    expect(c).toMatch(/mtoc_tensor_t _mtoc_x__v\d+ /);
  });

  it("still rejects category-changing reassignment inside control flow", () => {
    // After dim coarsening, two row-vector literals share the same
    // coarse type, so swapping them inside an `if` is now valid (the
    // codegen handles the realloc). A scalar↔tensor change still
    // crosses C categories, so it remains rejected with a span.
    let err: unknown;
    try {
      translate("v = 1;\nif 1\n  v = [1 2 3];\nend\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/control flow|hoist|category/i);
  });

  it("does not split when reassigning to a compatible type", () => {
    // x stays scalar real on both writes — should remain a single
    // `double x` declaration with no split bindings introduced.
    const c = translate("x = 1;\nx = x + 1;\nx = x * 10;\ndisp(x);\n");
    const decls = c.match(/double x = 0\.0;/g) ?? [];
    expect(decls.length).toBe(1);
    expect(c).not.toMatch(/_mtoc_x__v/);
  });

  it("rejects a tensor literal embedded inside a binary expression", () => {
    let err: unknown;
    try {
      translate("a = [1 2 3];\nb = a + [4 5 6];\n");
    } catch (e) {
      err = e;
    }
    // We reject TensorLit nested inside Binary at lowering. Confirm
    // the error has a span and the right name.
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/tensor literal/i);
  });

  it("emits mtoc_tensor_free(&v) before the implicit return of a function with a tensor local", () => {
    // The function declares a tensor local; codegen heap-allocates
    // its backing at the assignment site and must release it before
    // the function returns. Free comes immediately before `return`.
    const c = translate(
      "disp(sum_first());\n" +
        "function r = sum_first()\n" +
        "  v = [1 2 3];\n" +
        "  r = sum(v);\n" +
        "end\n"
    );
    // The function body has `mtoc_tensor_free(&v);\n  return r;`
    // adjacent (modulo whitespace).
    expect(c).toMatch(/mtoc_tensor_free\(&v\);\s*\n\s*return r;/);
  });

  it("emits mtoc_tensor_free(&v) at every IRStmt.ReturnFromFunction early-exit site", () => {
    // Each `return` keyword inside the function body lowers to its
    // own ReturnFromFunction node, and each one must carry a copy of
    // the free preamble for tensor locals in scope.
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
    // At least two `mtoc_tensor_free(&v);` should appear inside the
    // function body — one for the explicit `return` and one for the
    // implicit fall-through return.
    const frees = c.match(/mtoc_tensor_free\(&v\);/g) ?? [];
    expect(frees.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects disp of a non-Var tensor expression at lowering", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\ndisp(v + 1);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/disp/i);
  });

  it("emits `mtoc_tensor_t v` for a tensor function parameter", () => {
    // Lifting the "real-scalar arguments only" restriction: the avg
    // example specializes on a row-vector arg, so the C signature
    // should carry the borrowed-by-value `mtoc_tensor_t` struct
    // (NOT a bare `double`).
    const c = translate(
      "function s = avg(v)\n" +
        "  s = sum(v) / length(v);\n" +
        "end\n" +
        "x = [1.0 2.0 3.0 4.0 5.0];\n" +
        "m = avg(x);\n" +
        "disp(m);\n"
    );
    expect(c).toMatch(/static double avg__[0-9a-f]+\(mtoc_tensor_t v\)/);
    expect(c).not.toMatch(/static double avg__[0-9a-f]+\(double v\)/);
  });

  it("allows tensor-parameter reassignment under copy-on-arg-pass", () => {
    // The callee owns its tensor argument (caller wraps it in
    // `mtoc_tensor_copy` at the call site), so the body is free to
    // reassign through `mtoc_tensor_assign(&v, ...)`. The scope-exit
    // free releases the final buffer regardless of how many times v
    // was reassigned.
    const c = translate(
      "x = [1 2 3];\n" +
        "disp(foo(x));\n" +
        "function y = foo(v)\n" +
        "  v = v .* 2;\n" +
        "  y = sum(v);\n" +
        "end\n"
    );
    // Caller-side: tensor arg wrapped in a copy.
    expect(c).toMatch(/foo__[0-9a-f]+\(mtoc_tensor_copy\(x\)\)/);
    // Callee-side: param signature, reassign-via-helper, scope-exit
    // free of the param.
    expect(c).toMatch(/static double foo__[0-9a-f]+\(mtoc_tensor_t v\)/);
    expect(c).toContain("mtoc_tensor_assign(&v, ");
    expect(c).toMatch(/mtoc_tensor_free\(&v\);\s*\n\s*return y;/);
  });

  it("emits mtoc_tensor_copy at user-function call sites (copy-on-arg-pass)", () => {
    const c = translate(
      "function s = total(v)\n" +
        "  s = sum(v);\n" +
        "end\n" +
        "a = [1 2 3];\n" +
        "disp(total(a));\n"
    );
    expect(c).toMatch(/total__[0-9a-f]+\(mtoc_tensor_copy\(a\)\)/);
  });

  it("does NOT wrap builtin tensor args in mtoc_tensor_copy", () => {
    // Builtins (disp, sum, length, numel) are read-only; the args
    // are passed through by value with no copy wrap.
    const c = translate("v = [1 2 3];\ndisp(v);\ndisp(sum(v));\n");
    expect(c).toContain("mtoc_disp_tensor(v);");
    expect(c).toContain("mtoc_sum(v)");
    expect(c).not.toMatch(/mtoc_tensor_copy\(v\)/);
  });

  it("emits mtoc_tensor_assign + mtoc_tensor_copy for tensor-by-name assignment", () => {
    // `b = a;` collapses to one helper-pair line — the cleanest
    // manifestation of "copy on every manipulation".
    const c = translate("a = [1 2 3];\nb = a;\ndisp(b);\n");
    expect(c).toContain("mtoc_tensor_assign(&b, mtoc_tensor_copy(a));");
  });

  it("emits a single specialization for two row-vector shapes", () => {
    // After the dim coarsening, calls with a 1x3 and a 1x4 row-vector
    // arg both canonicalize to `cols: notOne` — the specific size is
    // runtime data — so they share a single mangled specialization.
    const c = translate(
      "function s = total(v)\n" +
        "  s = sum(v);\n" +
        "end\n" +
        "a = [1 2 3];\n" +
        "b = [10 20 30 40];\n" +
        "disp(total(a));\n" +
        "disp(total(b));\n"
    );
    const sigRe = /static double total__([0-9a-f]+)\(mtoc_tensor_t v\)/g;
    const hashes = new Set<string>();
    for (const m of c.matchAll(sigRe)) hashes.add(m[1]);
    expect(hashes.size).toBe(1);
  });
});

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
      /r = mtoc_sum\(v\);\s*\n\s*mtoc_tensor_free\(&v\);\s*\n\s*if/
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

describe("CLI translate + run", () => {
  it("translate writes a .c file with main()", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mtoc-test-"));
    const outC = join(tmp, "out.c");
    execFileSync("npx", ["tsx", cliPath, "translate", example1Path, outC], {
      stdio: "pipe",
    });
    const c = readFileSync(outC, "utf8");
    expect(c).toContain("int main(void)");
    expect(c).toContain("mtoc_disp_double(z);");
  });

  it("run compiles and executes, printing 12", () => {
    const stdout = execFileSync("npx", ["tsx", cliPath, "run", example1Path], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    expect(stdout.trim()).toBe("12");
  });

  it("translate fails on unsupported input with non-zero exit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mtoc-test-"));
    const inputM = join(tmp, "bad.m");
    const outC = join(tmp, "bad.c");
    writeFileSync(inputM, "s = 'hi';\n");
    expect(() =>
      execFileSync("npx", ["tsx", cliPath, "translate", inputM, outC], {
        stdio: "pipe",
      })
    ).toThrow();
  });

  it("translate with no output path writes to stdout", () => {
    const stdout = execFileSync(
      "npx",
      ["tsx", cliPath, "translate", example1Path],
      { stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    expect(stdout).toContain("int main(void)");
    expect(stdout).toContain("mtoc_disp_double(z);");
  });

  it("translate --no-runtime omits helper bodies", () => {
    const stdout = execFileSync(
      "npx",
      ["tsx", cliPath, "translate", example1Path, "--no-runtime"],
      { stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    expect(stdout).toContain("int main(void)");
    expect(stdout).toContain("mtoc_disp_double(z);"); // referenced
    expect(stdout).not.toContain("static void mtoc_disp_double"); // not defined
  });

  it("run --no-runtime is rejected with a clear error", () => {
    let stderr = "";
    expect(() => {
      try {
        execFileSync(
          "npx",
          ["tsx", cliPath, "run", example1Path, "--no-runtime"],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (e) {
        stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
        throw e;
      }
    }).toThrow();
    expect(stderr).toMatch(/--no-runtime is incompatible with `run`/);
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

describe("complex scalar codegen", () => {
  // Cross-runner tests in test_scripts/complex/ already verify
  // byte-for-byte stdout against numbl. These vitest assertions
  // additionally pin the *shape* of the emitted C — specific patterns
  // (`creal(a) == 1.0`, `&&` expansion) that stdout comparison alone
  // can't catch. They lock in the codegen so a refactor doesn't
  // silently change the emitted form.

  it("emits creal/cimag-based equality on a complex/real mix", () => {
    const c = translate("a = 1 + 2i;\ndisp(a == 1);\n");
    expect(c).toContain("#include <complex.h>");
    expect(c).toMatch(/creal\(a\) == 1\.0/);
    expect(c).toMatch(/cimag\(a\) == 0\.0/);
  });

  it("emits real-part-only ordering on complex inputs", () => {
    const c = translate("a = 1 + 2i;\nb = 3 + 4i;\ndisp(a < b);\n");
    // Real-part-only — `creal(a) < creal(b)`.
    expect(c).toMatch(/creal\(a\) < creal\(b\)/);
  });

  it("emits toBool-based && on complex operands", () => {
    const c = translate("a = 1 + 2i;\nb = 0 + 0i;\ndisp(a && b);\n");
    expect(c).toMatch(/creal\(a\) != 0\.0 \|\| cimag\(a\) != 0\.0/);
    expect(c).toMatch(/creal\(b\) != 0\.0 \|\| cimag\(b\) != 0\.0/);
    expect(c).toMatch(/&&/);
  });

  it("emits toBool-negated unary ~ on complex", () => {
    const c = translate("a = 1 + 2i;\ndisp(~a);\n");
    expect(c).toMatch(/!\(creal\(a\) != 0\.0 \|\| cimag\(a\) != 0\.0\)/);
  });

  it("emits double _Complex declaration and (V * I) literal", () => {
    const c = translate("z = 2.5i;\ndisp(z);\n");
    expect(c).toContain("double _Complex z = 0.0;");
    expect(c).toContain("z = (2.5 * I);");
    expect(c).toContain("mtoc_disp_complex(z);");
  });
});

describe("emitC includeRuntime option", () => {
  // The runtime-helper bodies (mtoc_format_double, mtoc_disp_double,
  // mtoc_tensor_t typedef, etc.) get omitted when includeRuntime is
  // false. User code, user-function specializations, main(), and the
  // headers needed by the user code itself stay.

  it("default (includeRuntime: true) includes runtime helpers", () => {
    const c = translate("v = [1 2 3]; s = sum(v); disp(s);");
    expect(c).toContain("typedef struct {");
    expect(c).toContain("mtoc_tensor_t");
    expect(c).toContain("static double mtoc_sum");
    expect(c).toContain("static int mtoc_format_double");
    expect(c).toContain("static void mtoc_disp_double");
  });

  it("includeRuntime: false omits the runtime-helper bodies", () => {
    const c = translate("v = [1 2 3]; s = sum(v); disp(s);", {
      includeRuntime: false,
    });
    // No helper bodies / typedef.
    expect(c).not.toContain("typedef struct {");
    expect(c).not.toContain("static double mtoc_sum");
    expect(c).not.toContain("static int mtoc_format_double");
    expect(c).not.toContain("static void mtoc_disp_double");
    // User code still references the helper names — caller's link
    // environment supplies them.
    expect(c).toContain("mtoc_tensor_t v");
    expect(c).toContain("mtoc_sum(v)");
    expect(c).toContain("mtoc_disp_double(s)");
    expect(c).toContain("int main(void) {");
  });

  it("includeRuntime: false drops runtime-only headers but keeps user-code headers", () => {
    // disp_tensor pulls in <stdlib.h> and <string.h> for malloc/strlen.
    // With runtime stripped, those should disappear; <stdio.h> always
    // stays, and <math.h> stays because the for-loop emits floor().
    const c = translate("for k = 1:5; disp(k); end", { includeRuntime: false });
    expect(c).toContain("#include <stdio.h>");
    expect(c).toContain("#include <math.h>"); // user code uses floor()
    expect(c).not.toContain("#include <stdlib.h>");
    expect(c).not.toContain("#include <string.h>");
  });
});

describe("type system invariants", () => {
  // Sign is meaningful only when isComplex === false. The invariant is
  // enforced at observation sites (canonicalizeType, unify) so a stray
  // sign carried through can't bloat the specialization cache.

  const complexScalar = (sign: NumericType["sign"]): NumericType => ({
    kind: "Numeric",
    elem: "double",
    isComplex: true,
    rows: { kind: "one" },
    cols: { kind: "one" },
    sign,
  });

  it("canonicalizeType normalizes sign on complex to 'unknown'", () => {
    const a = canonicalizeType(complexScalar("positive"));
    const b = canonicalizeType(complexScalar("negative"));
    const c = canonicalizeType(complexScalar("unknown"));
    // All three must hash identically — sign must not influence the
    // specialization key when isComplex is true.
    expect(a).toEqual(c);
    expect(b).toEqual(c);
  });

  it("unify of complex types produces sign='unknown' regardless of inputs", () => {
    const merged = unify(complexScalar("positive"), complexScalar("negative"));
    expect(merged.kind).toBe("Numeric");
    if (merged.kind === "Numeric") {
      expect(merged.isComplex).toBe(true);
      expect(merged.sign).toBe("unknown");
    }
  });

  it("isString narrows MType to StringType", () => {
    const s = STRING;
    expect(isString(s)).toBe(true);
    expect(isString({ kind: "Unknown" })).toBe(false);
    expect(isString(complexScalar("unknown"))).toBe(false);
  });

  it("unify of two strings is a string; string vs numeric collapses to Unknown", () => {
    expect(unify(STRING, STRING)).toEqual(STRING);
    expect(unify(STRING, complexScalar("unknown")).kind).toBe("Unknown");
    expect(unify(complexScalar("unknown"), STRING).kind).toBe("Unknown");
  });

  it("canonicalizeType picks a stable hash entry for strings", () => {
    expect(canonicalizeType(STRING)).toEqual({ kind: "String" });
  });
});

describe("strings", () => {
  it("emits an mtoc_string_t predeclaration + literal handle on assignment", () => {
    const c = translate('s = "hi";\ndisp(s);\n');
    expect(c).toContain("mtoc_string_t s = mtoc_string_empty();");
    expect(c).toMatch(
      /mtoc_string_assign\(&s, mtoc_string_from_literal\("hi", 2\)\);/
    );
    expect(c).toContain("mtoc_disp_string(s);");
    // Scope-exit free.
    expect(c).toContain("mtoc_string_free(&s);");
  });

  it("emits mtoc_string_concat for `+` on two strings", () => {
    const c = translate('a = "x";\nb = "y";\nc = a + b;\ndisp(c);\n');
    expect(c).toMatch(/mtoc_string_assign\(&c, mtoc_string_concat\(a, b\)\);/);
  });

  it("rejects nested string concat (would leak the inner buffer)", () => {
    let err: unknown;
    try {
      translate('a = "x";\nb = "y";\nc = "z";\nd = a + b + c;\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/string concatenation/i);
  });

  it("rejects non-Add binary ops on strings", () => {
    let err: unknown;
    try {
      translate('a = "x";\nb = "y";\nc = a * b;\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/string operands/);
  });

  it("rejects mixed string + numeric `+` with a TypeError", () => {
    let err: unknown;
    try {
      translate('a = "x";\nb = a + 1;\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("TypeError");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/both operands to be strings/);
  });

  it("folds length(s) and numel(s) to the constant 1 (numbl semantics)", () => {
    const c = translate('s = "hello";\ndisp(length(s));\ndisp(numel(s));\n');
    // The numbl rule is `length(string) == numel(string) == 1`. Both
    // calls should be folded at lowering — no runtime helper needed.
    expect(c).not.toContain("mtoc_length");
    expect(c).not.toContain("mtoc_numel");
    expect(c).toContain("mtoc_disp_double(1.0);");
  });

  it("error(s) lowers to IRStmt.Error (statement-only path)", () => {
    const source = 'error("boom");\n';
    const ast = parseMFile(source, "test.m");
    const ws = new Workspace("test.m");
    ws.addFile({ name: "test.m", source, ast });
    const ir = lower(ast, ws);
    const errorStmts = ir.stmts.filter(s => s.kind === "Error");
    expect(errorStmts.length).toBe(1);
  });

  it("error(s) emits the runtime helper call", () => {
    const c = translate('error("boom");\n');
    expect(c).toMatch(
      /mtoc_error_string\(mtoc_string_from_literal\("boom", 4\)\);/
    );
  });

  it("disp of a string concat expression is rejected with a clear message", () => {
    let err: unknown;
    try {
      translate('a = "x";\nb = "y";\ndisp(a + b);\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    // The nested-binary rule fires first, since the disp arg is the
    // outer Binary and its left/right are scanned for nested string
    // Binary nodes.
    expect(e.message).toMatch(/string/i);
  });

  it("splits a string -> numeric top-level reassignment via a fresh binding", () => {
    // String and number can't share one C representation (the slot is
    // either `mtoc_string_t` or `double`). At top level the lowerer
    // splits into a fresh `_mtoc_x__v<N>` binding rather than throwing.
    const c = translate('x = "hi";\ndisp(x);\nx = 42;\ndisp(x);\n');
    expect(c).toContain("mtoc_string_t x = mtoc_string_empty();");
    expect(c).toMatch(/double _mtoc_x__v\d+ = 0\.0;/);
  });

  it("frees a string immediately after its last touch (not at scope exit)", () => {
    // After `c = a + b;`, `a` and `b` have no future touches. The
    // shared "early free" liveness pass — same machinery as tensors —
    // should emit `mtoc_string_free(&a); mtoc_string_free(&b);`
    // between the assignment and `disp(c)`. `c` itself is freed
    // after `disp(c)`.
    const c = translate('a = "x";\nb = "y";\nc = a + b;\ndisp(c);\n');
    const aFreeIdx = c.indexOf("mtoc_string_free(&a);");
    const bFreeIdx = c.indexOf("mtoc_string_free(&b);");
    const cFreeIdx = c.indexOf("mtoc_string_free(&c);");
    const dispIdx = c.indexOf("mtoc_disp_string(c);");
    expect(aFreeIdx).toBeGreaterThan(-1);
    expect(bFreeIdx).toBeGreaterThan(-1);
    expect(cFreeIdx).toBeGreaterThan(-1);
    expect(aFreeIdx).toBeLessThan(dispIdx);
    expect(bFreeIdx).toBeLessThan(dispIdx);
    expect(dispIdx).toBeLessThan(cFreeIdx);
    // Each var is freed exactly once on the linear path — no
    // duplicate scope-exit free after the early free.
    expect((c.match(/mtoc_string_free\(&a\);/g) ?? []).length).toBe(1);
    expect((c.match(/mtoc_string_free\(&b\);/g) ?? []).length).toBe(1);
    expect((c.match(/mtoc_string_free\(&c\);/g) ?? []).length).toBe(1);
  });
});
