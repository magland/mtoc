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
// Note: parseMFile / Workspace / lower are also used directly by the
// IRStmt.Disp assertion below (it inspects the lowered IR rather than
// the emitted C, to exercise the lowering boundary explicitly).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const example1Path = join(repoRoot, "examples", "example1.m");

function translate(source: string): string {
  const ast = parseMFile(source, "test.m");
  const ws = new Workspace("test.m");
  ws.addFile({ name: "test.m", source, ast });
  return emitC(lower(ast, ws));
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

  it("rejects unsupported constructs (string literal)", () => {
    // Char/string literals aren't yet lowerable.
    expect(() => translate("s = 'hi';")).toThrow(
      /unsupported expression: Char/
    );
  });

  it("accepts a row-vector literal (statically-sized)", () => {
    const c = translate("v = [1 2 3]; disp(v);");
    expect(c).toContain("mtoc_tensor_t v");
    expect(c).toContain("v.real[0] = 1.0;");
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

  it("rejects shape-changing reassignment at lowering with a span", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\nv = [1 2 3 4];\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/fixed shape|dynamic|shape/i);
  });

  it("rejects a tensor literal embedded inside a binary expression", () => {
    let err: unknown;
    try {
      translate("a = [1 2 3];\nb = a + [4 5 6];\n");
    } catch (e) {
      err = e;
    }
    // Either passes (Binary tensor + tensor lowered to elementwise; we
    // reject TensorLit nested inside Binary at lowering). Confirm the
    // error has a span and the right name.
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/tensor literal/i);
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
});
