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

  it("splits a top-level shape-changing reassignment into two C variables", () => {
    // v gets two distinct shapes at script top level; the lowerer
    // allocates a fresh `_mtoc_v__v<N>` binding for the second
    // assignment so both can coexist in the same scope.
    const c = translate("v = [1 2 3];\ndisp(v);\nv = [1 2 3 4];\ndisp(v);\n");
    expect(c).toMatch(/mtoc_tensor_t v = \{ _mtoc_v_re,/);
    expect(c).toMatch(
      /mtoc_tensor_t _mtoc_v__v\d+ = \{ _mtoc__mtoc_v__v\d+_re,/
    );
    // Both disps are emitted, on the two different bindings.
    expect(c).toMatch(/mtoc_disp_tensor\(v\);/);
    expect(c).toMatch(/mtoc_disp_tensor\(_mtoc_v__v\d+\);/);
  });

  it("splits a scalar→tensor top-level reassignment", () => {
    const c = translate("x = 4;\ndisp(x);\nx = [1 2 3];\ndisp(x);\n");
    expect(c).toMatch(/double x = 0\.0;/);
    expect(c).toMatch(/mtoc_tensor_t _mtoc_x__v\d+ /);
  });

  it("still rejects shape-changing reassignment inside control flow", () => {
    let err: unknown;
    try {
      translate("v = [1 2 3];\nif 1\n  v = [1 2 3 4];\nend\n");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { name: string; message: string; span: unknown };
    expect(e.name).toBe("UnsupportedConstruct");
    expect(e.span).toBeTruthy();
    expect(e.message).toMatch(/inside control flow|hoist/i);
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

describe("complex scalar codegen", () => {
  // Cross-runner tests live in test_scripts/complex/; these vitest
  // assertions cover the codegen shapes that exercise builtins or paths
  // numbl's default JIT can't run today (and so can't be cross-checked
  // byte-for-byte). They lock in the C we emit so the lowering+codegen
  // doesn't quietly regress while we wait for numbl to grow JIT support
  // for complex comparisons / logicals.

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
    rows: { kind: "exact", n: 1 },
    cols: { kind: "exact", n: 1 },
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
});
