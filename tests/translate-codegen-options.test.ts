import { describe, expect, it } from "vitest";

import { translate } from "./_helpers.js";

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
