import { describe, expect, it } from "vitest";

import { parseMFile } from "../src/parser/index.js";
import { Workspace } from "../src/workspace/workspace.js";
import { lower } from "../src/lowering/lower.js";
import { emitC } from "../src/codegen/emit.js";

import { translate } from "./_helpers.js";

describe("zero-output and multi-output user functions", () => {
  // Coverage for the static-checker, the IR shape, and the codegen
  // for the new function-output conventions:
  //   - 0 outputs: `static void <mangled>(args) { ... }`,
  //     callable as a bare statement.
  //   - 1 output : unchanged classic return-by-value.
  //   - N≥2     : `static void <mangled>(args, T *_mtoc_o0, ...)`,
  //     called via `[a, b] = foo(x);` syntax with optional `~`.

  it("emits `static void <mangled>(...)` and no return-value for a zero-output function", () => {
    const c = translate(
      "greet();\n" + "function greet()\n" + "  disp(42);\n" + "end\n"
    );
    expect(c).toMatch(/static void greet__[0-9a-f]+\(void\) \{/);
    // No `return <value>;` line should appear inside the body — only
    // (optionally) a bare `return;` does.
    const bodyMatch = c.match(
      /static void greet__[0-9a-f]+\(void\) \{([\s\S]*?)\n\}/
    );
    expect(bodyMatch).toBeTruthy();
    const body = bodyMatch![1];
    expect(body).not.toMatch(/return\s+[A-Za-z_]/);
    // Caller-side: bare `<mangled>(args);` with no surrounding block
    // for the 0-output statement form.
    expect(c).toMatch(/^\s*greet__[0-9a-f]+\(\);/m);
  });

  it("emits void return-type and out-pointer params for a 2-output function", () => {
    const c = translate(
      "[s, p] = sumprod(3, 4);\n" +
        "disp(s); disp(p);\n" +
        "function [s, p] = sumprod(a, b)\n" +
        "  s = a + b;\n" +
        "  p = a * b;\n" +
        "end\n"
    );
    expect(c).toMatch(
      /static void sumprod__[0-9a-f]+\(double a, double b, double \*_mtoc_o0, double \*_mtoc_o1\)/
    );
    // Implicit fall-through return writes both outputs.
    expect(c).toMatch(/\*_mtoc_o0 = s;\s*\n\s*\*_mtoc_o1 = p;\s*\n\s*return;/);
  });

  it("emits the *_mtoc_oX preamble at every early return inside an N-output function", () => {
    const c = translate(
      "[a, b, c] = pick(5);\n" +
        "disp(a); disp(b); disp(c);\n" +
        "function [a, b, c] = pick(x)\n" +
        "  a = x;\n" +
        "  b = 0;\n" +
        "  c = 0;\n" +
        "  if x > 0\n" +
        "    b = x * 2;\n" +
        "    return;\n" +
        "  end\n" +
        "  c = -x;\n" +
        "end\n"
    );
    // Both the early `return` (inside the `if`) and the implicit
    // fall-through return should each carry their own copy of the
    // three out-pointer writes.
    const writeBlocks = c.match(
      /\*_mtoc_o0 = a;\s*\n\s*\*_mtoc_o1 = b;\s*\n\s*\*_mtoc_o2 = c;\s*\n\s*return;/g
    );
    expect(writeBlocks?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("records both lvalues with the right cName and emits a block with no discard temps for [a, b] = f(x)", () => {
    const source =
      "[s, p] = sumprod(3, 4);\n" +
      "disp(s); disp(p);\n" +
      "function [s, p] = sumprod(a, b)\n" +
      "  s = a + b;\n" +
      "  p = a * b;\n" +
      "end\n";
    const ast = parseMFile(source, "test.m");
    const ws = new Workspace("test.m");
    ws.addFile({ name: "test.m", source, ast });
    const prog = lower(ast, ws);
    expect(prog.assignedVars.has("s")).toBe(true);
    expect(prog.assignedVars.has("p")).toBe(true);
    const c = emitC(prog);
    // Call site: wrapped in a block, no `_mtoc_discard_*` declarations.
    expect(c).toMatch(
      /\{\s*\n\s*sumprod__[0-9a-f]+\(3\.0, 4\.0, &s, &p\);\s*\n\s*\}/
    );
    expect(c).not.toMatch(/_mtoc_discard_/);
  });

  it("declares a discard temp only for the ignored slot in [~, b] = f(x)", () => {
    const c = translate(
      "[~, q] = divmod(17, 5);\n" +
        "disp(q);\n" +
        "function [d, m] = divmod(a, b)\n" +
        "  d = floor(a / b);\n" +
        "  m = a - d * b;\n" +
        "end\n"
    );
    // Block-wrapped, with one discard temp and one named `&q`.
    expect(c).toMatch(
      /\{\s*\n\s*double _mtoc_discard_\d+_0;\s*\n\s*divmod__[0-9a-f]+\(17\.0, 5\.0, &_mtoc_discard_\d+_0, &q\);\s*\n\s*\}/
    );
  });

  it("emits N discard temps for a bare-statement call to an N-output function", () => {
    const c = translate(
      "sumprod(1, 1);\n" +
        "function [s, p] = sumprod(a, b)\n" +
        "  s = a + b;\n" +
        "  p = a * b;\n" +
        "end\n"
    );
    // Drop-all bare-statement form: block + 2 discard temps + 1 call.
    expect(c).toMatch(
      /\{\s*\n\s*double _mtoc_discard_\d+_0;\s*\n\s*double _mtoc_discard_\d+_1;\s*\n\s*sumprod__[0-9a-f]+\(1\.0, 1\.0, &_mtoc_discard_\d+_0, &_mtoc_discard_\d+_1\);\s*\n\s*\}/
    );
  });

  it("rejects a 2-output user function used in expression position", () => {
    let err: unknown;
    try {
      translate(
        "x = sumprod(1, 2);\n" +
          "function [s, p] = sumprod(a, b)\n" +
          "  s = a + b;\n" +
          "  p = a * b;\n" +
          "end\n"
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; span: unknown; message: string };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/sumprod/);
  });

  it("rejects when lvalues.length > fn.outputs.length", () => {
    let err: unknown;
    try {
      translate(
        "[a, b, c] = sumprod(1, 2);\n" +
          "function [s, p] = sumprod(a, b)\n" +
          "  s = a + b;\n" +
          "  p = a * b;\n" +
          "end\n"
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; span: unknown; message: string };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    // The error mentions both the requested and provided counts.
    expect(e.message).toMatch(/sumprod/);
    expect(e.message).toMatch(/2/);
    expect(e.message).toMatch(/3/);
  });

  it("rejects multi-assign of a builtin", () => {
    let err: unknown;
    try {
      translate("[a, b] = sqrt(4);\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; span: unknown; message: string };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/sqrt/);
  });
});
