import { describe, expect, it } from "vitest";

import { parseSnippetSource } from "../src/codegen/runtime.js";

describe("parseSnippetSource", () => {
  it("parses well-formed #include lines into headers", () => {
    const raw = `#include <stdio.h>
#include <stdlib.h>
void foo(void) {}
`;
    const { headers, code } = parseSnippetSource(raw);
    expect(headers).toEqual(["<stdio.h>", "<stdlib.h>"]);
    expect(code).toContain("void foo(void) {}");
    expect(code).not.toContain("#include");
  });

  it("accepts #include with surrounding whitespace", () => {
    const raw = `  #  include   <math.h>  \nvoid bar(void) {}\n`;
    const { headers } = parseSnippetSource(raw);
    expect(headers).toEqual(["<math.h>"]);
  });

  it("accepts double-quoted #include headers", () => {
    const raw = `#include "myheader.h"\nvoid baz(void) {}\n`;
    const { headers } = parseSnippetSource(raw);
    expect(headers).toEqual(['"myheader.h"']);
  });

  it("throws on a #include with a trailing // comment", () => {
    const raw = `#include <stdio.h> // needed for printf\nvoid fn(void) {}\n`;
    expect(() => parseSnippetSource(raw)).toThrow(/unexpected #include form/);
  });

  it("throws on a #include with no space before the header", () => {
    const raw = `#include<stdlib.h>\nvoid fn(void) {}\n`;
    expect(() => parseSnippetSource(raw)).toThrow(/unexpected #include form/);
  });

  it("throws on #include with extra trailing text", () => {
    const raw = `#include <stdio.h> extra\nvoid fn(void) {}\n`;
    expect(() => parseSnippetSource(raw)).toThrow(/unexpected #include form/);
  });

  it("strips leading and trailing blank body lines", () => {
    const raw = `#include <stdio.h>\n\nvoid fn(void) {}\n\n`;
    const { code } = parseSnippetSource(raw);
    expect(code.startsWith("\n")).toBe(false);
    expect(code.trimEnd().endsWith("}")).toBe(true);
  });
});
