import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

describe("for-loop count helper", () => {
  it("routes the iteration count through mtoc_loop_count", () => {
    const c = translate("s = 0;\nfor i = 1:5\n  s = s + i;\nend\ndisp(s);\n");
    expect(c).toContain(
      "long _mtoc_n = mtoc_loop_count(_mtoc_start, _mtoc_end, 1.0);"
    );
    expect(c).toContain("static long mtoc_loop_count(");
    // The old `(long)floor(...) + 1` form should no longer leak into
    // emitted user-code lines.
    expect(c).not.toMatch(/long _mtoc_n = \(long\)floor\(/);
  });

  it("does not emit the redundant `if (n < 0) n = 0` clamp", () => {
    // The helper handles non-positive counts internally; the codegen
    // site previously emitted an extra clamp.
    const c = translate("for i = 1:3\n  disp(i);\nend\n");
    expect(c).not.toContain("if (_mtoc_n < 0) _mtoc_n = 0;");
  });
});
