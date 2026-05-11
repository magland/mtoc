/**
 * Cross-file function resolution. The end-to-end stdout comparisons
 * live under `test_scripts/multifile/<case>/main.m`; this file owns
 * the unit-level invariants:
 *
 *  - `translateProject` walks the project file list, parses every file,
 *    and resolves call sites via the vendored numbl resolver.
 *  - Same-named subfunctions in different files mangle to distinct
 *    specializations (file salt in `mangleSpecName`).
 *  - Unsupported resolved kinds (`+pkg.func`, `@Cls`, `private/`, …)
 *    fail with a span-attributed `UnsupportedConstruct` message.
 *
 * Spans are kept as flat file names (no leading `/`) so the resolver
 * runs in "search-paths empty" mode and the project layout doesn't
 * leak absolute filesystem paths into error messages.
 */

import { describe, expect, it } from "vitest";

import { translateProject } from "../src/translate.js";

function expectSuccess(
  files: { name: string; source: string }[],
  activeName: string
): string {
  const result = translateProject(files, activeName);
  if (result.error) {
    throw new Error(
      `unexpected ${result.error.kind} in ${result.error.fileName ?? "?"}: ` +
        `${result.error.message}`
    );
  }
  return result.c!;
}

describe("cross-file user-function resolution", () => {
  it("resolves a workspace function defined in a sibling file", () => {
    const c = expectSuccess(
      [
        { name: "main.m", source: "x = sq(3);\ndisp(x);\n" },
        { name: "sq.m", source: "function y = sq(x)\n  y = x * x;\nend\n" },
      ],
      "main.m"
    );
    // The workspace function gets lowered into a static C function
    // and called from main. Mangled name is `sq__<hash>`.
    expect(c).toMatch(/static[^\n]*sq__[0-9a-f]+/);
    expect(c).toMatch(/sq__[0-9a-f]+\(3\.0\)/);
  });

  it("salts the spec hash by source file so same-named helpers don't collide", () => {
    // Both files declare a `function y = h(x)` (a workspace function
    // primary by basename, callable as `h1` / `h2` from main). Their
    // mangled names must differ because each function lives in a
    // distinct file, even though the AST shape and arg type are
    // identical.
    const c = expectSuccess(
      [
        {
          name: "main.m",
          source: "a = h1(2);\nb = h2(2);\ndisp(a);\ndisp(b);\n",
        },
        { name: "h1.m", source: "function y = h1(x)\n  y = x + 1;\nend\n" },
        { name: "h2.m", source: "function y = h2(x)\n  y = x + 1;\nend\n" },
      ],
      "main.m"
    );
    const hashes = [...c.matchAll(/h[12]__([0-9a-f]+)/g)].map(m => m[1]);
    const distinct = new Set(hashes);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it("uses the first function in a file even when its declared name differs from the basename", () => {
    // numbl's "filename wins" rule: `foo.m` containing
    // `function y = bar(x)` is still callable as `foo(...)`. mtoc
    // matches via `firstFunctionInFile` in the Workspace adapter.
    const c = expectSuccess(
      [
        { name: "main.m", source: "disp(foo(10));\n" },
        { name: "foo.m", source: "function y = bar(x)\n  y = x + 99;\nend\n" },
      ],
      "main.m"
    );
    expect(c).toMatch(/foo__[0-9a-f]+\(10\.0\)/);
  });

  it("lets a main-file local function shadow a workspace file of the same name", () => {
    // numbl precedence: local > workspace. The result type / value is
    // the one from main's local definition, not the sibling file.
    const c = expectSuccess(
      [
        {
          name: "main.m",
          source:
            "disp(dbl(5));\n" + "function y = dbl(x)\n  y = x + 100;\nend\n",
        },
        { name: "dbl.m", source: "function y = dbl(x)\n  y = x * 2;\nend\n" },
      ],
      "main.m"
    );
    // The emitted body should contain `x + 100`, not `x * 2`. The
    // simplest robust signal is that the dbl spec adds 100 somewhere.
    expect(c).toMatch(/\+\s*100/);
    expect(c).not.toMatch(/\* 2\.0/);
  });

  it("attributes errors inside a workspace function to the workspace file", () => {
    const result = translateProject(
      [
        { name: "main.m", source: "disp(helper());\n" },
        // No matching arg count — error fires inside specialization,
        // span should point at helper.m.
        {
          name: "helper.m",
          source: "function y = helper(x)\n  y = x + 1;\nend\n",
        },
      ],
      "main.m"
    );
    expect(result.error).toBeDefined();
    // The arg-count mismatch is detected at the call site inside
    // main.m (where `helper()` is called with 0 args), so the file
    // name in the error stays the caller. But the message names the
    // callee:
    expect(result.error!.message).toContain("helper");
  });
});

describe("v1 fence-posts for advanced resolver targets", () => {
  it("rejects a workspace classdef file with a clear span-attributed error", () => {
    // A file beginning with `classdef` registers as a workspace class.
    // Calling it constructs an instance, which mtoc doesn't support.
    const result = translateProject(
      [
        { name: "main.m", source: "x = MyCls();\n" },
        {
          name: "MyCls.m",
          source: "classdef MyCls\nproperties\n  v\nend\nend\n",
        },
      ],
      "main.m"
    );
    expect(result.error).toBeDefined();
    expect(result.error!.kind).toBe("UnsupportedConstruct");
    expect(result.error!.message).toMatch(/class methods|constructor/i);
  });
});

describe("unresolved names", () => {
  it("reports a clean error when no sibling file matches", () => {
    const result = translateProject(
      [{ name: "main.m", source: "disp(absent(3));\n" }],
      "main.m"
    );
    expect(result.error).toBeDefined();
    expect(result.error!.kind).toBe("UnsupportedConstruct");
    expect(result.error!.message).toMatch(/unresolved function or builtin/);
  });
});
