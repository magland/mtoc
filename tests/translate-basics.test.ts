import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";

import { example1Path, translate } from "./_helpers.js";

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

  it("translates a char-array literal to mtoc_char_tensor_from_literal", () => {
    // Char literals are now supported. A multi-element char ('hi')
    // assigns via mtoc_char_tensor_assign / mtoc_char_tensor_from_literal,
    // and disp via the unified text-view helper.
    const c = translate("s = 'hi'; disp(s);");
    expect(c).toContain('mtoc_char_tensor_from_literal("hi", 2)');
    expect(c).toContain("mtoc_disp_text(mtoc_text_from_char_tensor(s));");
    expect(c).toContain("mtoc_char_tensor_t s = mtoc_char_tensor_empty();");
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

  it("hoists a tensor literal embedded inside a binary expression via ANF", () => {
    // The post-lowering ANF pass lifts TensorLit operands of Binary
    // into their own `_mtoc_anf_<N>` synthetic Assigns, so the
    // subsequent iter-loop Assign reads them as Vars. Confirms ANF
    // ran and the program compiles.
    const c = translate("a = [1 2 3];\nb = a + [4 5 6];\ndisp(b);\n");
    expect(c).toMatch(/_mtoc_anf_/);
    expect(c).toMatch(
      /mtoc_tensor_from_row\(\(double\[\]\)\{4\.0, 5\.0, 6\.0\}/
    );
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

  it("assert(cond) lowers to IRStmt.Assert (statement-only path)", () => {
    const source = "assert(1 + 1 == 2);\n";
    const ast = parseMFile(source, "test.m");
    const ws = new Workspace("test.m");
    ws.addFile({ name: "test.m", source, ast });
    const ir = lower(ast, ws);
    const asserts = ir.stmts.filter(s => s.kind === "Assert");
    expect(asserts.length).toBe(1);
  });

  it("assert(cond) emits the runtime helper call", () => {
    const c = translate("assert(1 + 1 == 2);\n");
    expect(c).toContain("mtoc_assert_double(");
    expect(c).toMatch(/static void mtoc_assert_double\(double cond\)/);
  });

  it("assert(cond, msg) lowers to mtoc_assert_double_msg_text", () => {
    const c = translate('assert(1 == 1, "boom");\n');
    expect(c).toMatch(
      /mtoc_assert_double_msg_text\(1\.0 == 1\.0, mtoc_text_from_string\(mtoc_string_from_literal\("boom", 4\)\)\);/
    );
  });

  it("assert(cond, msg) accepts a string variable", () => {
    const c = translate('m = "boom";\nassert(0, m);\n');
    expect(c).toContain(
      "mtoc_assert_double_msg_text(0.0, mtoc_text_from_string(m));"
    );
  });

  it("assert(cond, msg) accepts a char-array message", () => {
    // Numbl accepts `assert(cond, 'msg')`; mtoc bridges via the text view.
    const c = translate("assert(1, 'boom');\n");
    expect(c).toMatch(
      /mtoc_assert_double_msg_text\(1\.0, mtoc_text_from_char_tensor\(mtoc_char_tensor_from_literal\("boom", 4\)\)\);/
    );
  });

  it("assert rejects a non-string msg with a clear message", () => {
    let err: unknown;
    try {
      translate("assert(0, 42);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.message).toMatch(/message must be a string/);
  });

  it("assert accepts a nested-string msg expression via ANF", () => {
    // ANF lifts the string concat into its own `_mtoc_anf_<N>` Assign,
    // so the assert's msg arg ends up as a `Var` that codegen routes
    // through `mtoc_assert_double_msg_text`.
    const c = translate('a = "x";\nb = "y";\nassert(0, a + b);\n');
    expect(c).toMatch(/_mtoc_anf_/);
    expect(c).toMatch(/mtoc_string_concat/);
    expect(c).toMatch(/mtoc_assert_double_msg_text/);
  });

  it("assert rejects a non-scalar-real argument with a clear message", () => {
    let err: unknown;
    try {
      translate('assert("hi");\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.message).toMatch(/scalar real/);
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
