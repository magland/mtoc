import { describe, expect, it } from "vitest";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";

import { translate } from "./_helpers.js";

describe("strings", () => {
  it("emits an mtoc_string_t predeclaration + literal handle on assignment", () => {
    const c = translate('s = "hi";\ndisp(s);\n');
    expect(c).toContain("mtoc_string_t s = mtoc_string_empty();");
    expect(c).toMatch(
      /mtoc_string_assign\(&s, mtoc_string_from_literal\("hi", 2\)\);/
    );
    expect(c).toContain("mtoc_disp_text(mtoc_text_from_string(s));");
    // Scope-exit free.
    expect(c).toContain("mtoc_string_free(&s);");
  });

  it("emits mtoc_string_concat for `+` on two strings", () => {
    const c = translate('a = "x";\nb = "y";\nc = a + b;\ndisp(c);\n');
    expect(c).toMatch(
      /mtoc_string_assign\(&c, mtoc_string_concat\(mtoc_text_from_string\(a\), mtoc_text_from_string\(b\)\)\);/
    );
  });

  it("hoists nested string concat via ANF", () => {
    // The post-lowering ANF pass lifts the inner concat into its
    // own `_mtoc_anf_<N>` Assign so each concat happens at a clean
    // consume site — no buffer leaks.
    const c = translate('a = "x";\nb = "y";\nc = "z";\nd = a + b + c;\n');
    expect(c).toMatch(/_mtoc_anf_/);
    // The inner (a + b) concat lands in the ANF temp; the outer
    // concat lands in `d`. Both shapes appear verbatim in main().
    expect(c).toMatch(
      /mtoc_string_assign\(&_mtoc_anf_\d+, mtoc_string_concat\(mtoc_text_from_string\(a\), mtoc_text_from_string\(b\)\)\);/
    );
    expect(c).toMatch(
      /mtoc_string_assign\(&d, mtoc_string_concat\(mtoc_text_from_string\(_mtoc_anf_\d+\), mtoc_text_from_string\(c\)\)\);/
    );
    // The lifted temp gets freed (either early-free or scope-exit).
    expect(c).toMatch(/mtoc_string_free\(&_mtoc_anf_/);
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
    expect(e.message).toMatch(/string or char array/);
  });

  it("concatenates string + char-array via the text view", () => {
    // Mixed `+` with a string and a char-array bridges both arms
    // through `mtoc_text_view_t`; the result is a string handle.
    const c = translate("a = \"hi\";\nb = a + 'lo';\ndisp(b);\n");
    expect(c).toContain("mtoc_string_t b = mtoc_string_empty();");
    expect(c).toMatch(
      /mtoc_string_assign\(&b, mtoc_string_concat\(mtoc_text_from_string\(a\), mtoc_text_from_char_tensor\(mtoc_char_tensor_from_literal\("lo", 2\)\)\)\);/
    );
    expect(c).toContain("mtoc_disp_text(mtoc_text_from_string(b));");
  });

  it("concatenates char-array + string via the text view", () => {
    // The symmetric case: char-array on the left, string on the right.
    const c = translate("a = 'hi';\nb = a + \"lo\";\ndisp(b);\n");
    expect(c).toContain("mtoc_string_t b = mtoc_string_empty();");
    expect(c).toMatch(
      /mtoc_string_concat\(mtoc_text_from_char_tensor\(a\), mtoc_text_from_string\(mtoc_string_from_literal\("lo", 2\)\)\)/
    );
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
      /mtoc_error_text\(mtoc_text_from_string\(mtoc_string_from_literal\("boom", 4\)\)\);/
    );
  });

  it("error(s) accepts a char-array message", () => {
    // Numbl treats `error('msg')` and `error("msg")` interchangeably;
    // mtoc bridges via the text view.
    const c = translate("error('boom');\n");
    expect(c).toMatch(
      /mtoc_error_text\(mtoc_text_from_char_tensor\(mtoc_char_tensor_from_literal\("boom", 4\)\)\);/
    );
  });

  it("strcmp emits the text-view helper for two strings", () => {
    const c = translate('a = "x";\nb = "y";\ndisp(strcmp(a, b));\n');
    expect(c).toContain(
      "mtoc_strcmp_text(mtoc_text_from_string(a), mtoc_text_from_string(b))"
    );
    expect(c).toContain("static double mtoc_strcmp_text");
  });

  it("strcmp emits the text-view helper for two char arrays", () => {
    const c = translate("a = 'hello';\ndisp(strcmp(a, 'hello'));\n");
    expect(c).toContain(
      "mtoc_strcmp_text(mtoc_text_from_char_tensor(a), mtoc_text_from_char_tensor("
    );
  });

  it("strcmp emits the text-view helper for mixed char-array × string", () => {
    const c = translate("a = 'hi';\ndisp(strcmp(a, \"hi\"));\n");
    expect(c).toContain(
      "mtoc_strcmp_text(mtoc_text_from_char_tensor(a), mtoc_text_from_string("
    );
  });

  it("strcmp rejects non-text arguments with a clear message", () => {
    let err: unknown;
    try {
      translate("disp(strcmp(1, 2));\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.message).toMatch(/char arrays or strings/);
  });

  it("hoists a string concat expression as a disp arg via ANF", () => {
    // ANF lifts the string-concat to a `_mtoc_anf_<N>` Assign and
    // disp consumes the resulting `Var` via `mtoc_disp_text`.
    const c = translate('a = "x";\nb = "y";\ndisp(a + b);\n');
    expect(c).toMatch(/_mtoc_anf_/);
    expect(c).toMatch(/mtoc_string_concat/);
    expect(c).toMatch(/mtoc_disp_text\(mtoc_text_from_string\(_mtoc_anf_/);
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
    const dispIdx = c.indexOf("mtoc_disp_text(mtoc_text_from_string(c));");
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
