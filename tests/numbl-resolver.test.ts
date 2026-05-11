/**
 * Direct tests against the vendored numbl resolver — bypasses mtoc's
 * lowerer so resolver regressions surface independently of the
 * Workspace adapter or codegen.
 *
 * Builds a `LoweringContext`, registers a few fake workspace files,
 * runs `buildFunctionIndex`, and checks what `resolveFunction`
 * returns for representative names. The intent is to catch upstream
 * resolver shape changes early — a failing assertion here means the
 * vendored sources behave differently from what mtoc's adapter
 * expects.
 */

import { describe, expect, it } from "vitest";

import { parseMFile } from "../src/parser/index.js";
import { LoweringContext } from "../src/numbl-core/lowering/loweringContext.js";
import { resolveFunction } from "../src/numbl-core/functionResolve.js";

function buildIndex(
  files: { name: string; source: string }[],
  mainName: string
): LoweringContext {
  const main = files.find(f => f.name === mainName)!;
  const ctx = new LoweringContext(main.source, mainName);
  for (const f of files) {
    ctx.fileASTCache.set(f.name, parseMFile(f.source, f.name));
  }
  // Register every main-file Function stmt as a local function.
  const mainAst = ctx.fileASTCache.get(mainName)!;
  for (const stmt of mainAst.body) {
    if (stmt.type === "Function") ctx.registerLocalFunctionAST(stmt);
  }
  const wsFiles = files
    .filter(f => f.name !== mainName)
    .map(f => ({ name: f.name, source: f.source }));
  ctx.registerWorkspaceFiles(wsFiles);
  ctx.buildFunctionIndex();
  return ctx;
}

describe("vendored numbl resolveFunction", () => {
  it("resolves a sibling .m file as a workspace function", () => {
    const ctx = buildIndex(
      [
        { name: "main.m", source: "x = 1;\n" },
        { name: "sq.m", source: "function y = sq(x)\n  y = x * x;\nend\n" },
      ],
      "main.m"
    );
    const target = resolveFunction(
      "sq",
      [],
      { file: "main.m" },
      ctx.functionIndex
    );
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("workspaceFunction");
    if (target!.kind === "workspaceFunction") {
      expect(target.name).toBe("sq");
    }
  });

  it("places main-file local functions ahead of workspace files", () => {
    const ctx = buildIndex(
      [
        {
          name: "main.m",
          source: "function y = dup(x)\n  y = x;\nend\n",
        },
        { name: "dup.m", source: "function y = dup(x)\n  y = x;\nend\n" },
      ],
      "main.m"
    );
    const target = resolveFunction(
      "dup",
      [],
      { file: "main.m" },
      ctx.functionIndex
    );
    expect(target!.kind).toBe("localFunction");
    if (target!.kind === "localFunction") {
      expect(target.source.from).toBe("main");
    }
  });

  it("hides main-file local functions from workspace-function call sites", () => {
    // A call originating from helper.m should not see main.m's `priv`
    // local — local functions are per-file in numbl.
    const ctx = buildIndex(
      [
        {
          name: "main.m",
          source: "function y = priv(x)\n  y = x;\nend\nhelper(1);\n",
        },
        {
          name: "helper.m",
          source: "function y = helper(x)\n  y = priv(x) + 1;\nend\n",
        },
      ],
      "main.m"
    );
    const target = resolveFunction(
      "priv",
      [],
      { file: "helper.m" },
      ctx.functionIndex
    );
    // `priv` isn't a sibling file and isn't a subfunction of helper.m
    // → no match (would resolve to a builtin only if registered).
    expect(target).toBeNull();
  });

  it("recognizes a subfunction of a workspace file from inside that file", () => {
    const ctx = buildIndex(
      [
        { name: "main.m", source: "x = 1;\n" },
        {
          name: "helper.m",
          source:
            "function y = helper(x)\n  y = subf(x);\nend\n" +
            "function z = subf(x)\n  z = x + 1;\nend\n",
        },
      ],
      "main.m"
    );
    const target = resolveFunction(
      "subf",
      [],
      { file: "helper.m" },
      ctx.functionIndex
    );
    expect(target!.kind).toBe("localFunction");
    if (target!.kind === "localFunction") {
      expect(target.source.from).toBe("workspaceFile");
    }
  });

  it("falls through to builtin when no user function shadows the name", () => {
    const ctx = buildIndex([{ name: "main.m", source: "x = 1;\n" }], "main.m");
    const target = resolveFunction(
      "sin",
      [],
      { file: "main.m" },
      ctx.functionIndex
    );
    expect(target!.kind).toBe("builtin");
  });
});
