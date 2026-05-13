import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cliPath, example1Path } from "./_helpers.js";

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
    // Class definitions are not yet supported — a clear UnsupportedConstruct.
    writeFileSync(inputM, "classdef Foo\nend\n");
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

  it("translate --dump-ir prints lowered-IR JSON", () => {
    // The dump is a debugging surface — we only assert that the
    // shape is JSON, includes the program-level fields, and renders
    // BuiltinSig closures as their human-readable stub. Span and
    // type metadata are intentionally not pinned to specific values
    // so this test stays robust across IR-shape evolution.
    const tmp = mkdtempSync(join(tmpdir(), "mtoc-test-"));
    const inputM = join(tmp, "dump.m");
    writeFileSync(inputM, "x = sqrt(4);\ndisp(x);\n");
    const stdout = execFileSync(
      "npx",
      ["tsx", cliPath, "translate", inputM, "--dump-ir"],
      { stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty("assignedVars");
    expect(parsed).toHaveProperty("functions");
    expect(parsed).toHaveProperty("stmts");
    // No raw `[object Object]` from a Map / Set falling through.
    expect(stdout).not.toContain("[object Object]");
    // BuiltinSig stubs render as the marker string, not as a closure.
    expect(stdout).toContain('"<builtin: sqrt>"');
  });
});
