import { describe, expect, it } from "vitest";

import {
  anonymousHandle,
  builtinHandle,
  canonicalizeType,
  storageCategory,
  unify,
  userFuncHandle,
} from "../src/lowering/types.js";

import { translate } from "./_helpers.js";

describe("function handles — type-system invariants", () => {
  // Captures-free synthesis of a fake AST is enough for the type-level
  // checks below; nothing here touches body lowering.
  const fakeAst = {
    type: "Function",
    name: "f",
    functionId: "f",
    params: ["x"],
    outputs: ["y"],
    body: [],
    argumentsBlocks: [],
    span: { file: "fake.m", start: 0, end: 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("two userFunc handles with identical (file, name) unify to the same handle", () => {
    const a = userFuncHandle("foo", "x.m", fakeAst);
    const b = userFuncHandle("foo", "x.m", fakeAst);
    const u = unify(a, b);
    expect(u).toEqual(a);
  });

  it("two userFunc handles differing in name unify to Unknown", () => {
    const a = userFuncHandle("foo", "x.m", fakeAst);
    const b = userFuncHandle("bar", "x.m", fakeAst);
    expect(unify(a, b).kind).toBe("Unknown");
  });

  it("two userFunc handles differing in file unify to Unknown", () => {
    const a = userFuncHandle("foo", "x.m", fakeAst);
    const b = userFuncHandle("foo", "y.m", fakeAst);
    expect(unify(a, b).kind).toBe("Unknown");
  });

  it("a userFunc handle vs a builtin handle of the same name unify to Unknown", () => {
    const a = userFuncHandle("sin", "x.m", fakeAst);
    const b = builtinHandle("sin");
    expect(unify(a, b).kind).toBe("Unknown");
  });

  it("storageCategory keys handles on target identity", () => {
    const u = userFuncHandle("foo", "x.m", fakeAst);
    const b = builtinHandle("sin");
    const a = anonymousHandle("anon_0", fakeAst, "x.m");
    expect(storageCategory(u)).toBe("handle:userFunc:x.m:foo");
    expect(storageCategory(b)).toBe("handle:builtin:sin");
    expect(storageCategory(a)).toBe("handle:anonymous:anon_0");
    // Two distinct anonymous handles must have distinct categories.
    const a2 = anonymousHandle("anon_1", fakeAst, "x.m");
    expect(storageCategory(a)).not.toBe(storageCategory(a2));
  });

  it("canonicalizeType produces distinct JSON for differently-targeted handles", () => {
    const a = userFuncHandle("foo", "x.m", fakeAst);
    const b = userFuncHandle("bar", "x.m", fakeAst);
    expect(JSON.stringify(canonicalizeType(a))).not.toBe(
      JSON.stringify(canonicalizeType(b))
    );
  });

  it("canonicalizeType excludes the AST so the JSON stays compact", () => {
    const a = userFuncHandle("foo", "x.m", fakeAst);
    const json = JSON.stringify(canonicalizeType(a));
    expect(json).not.toMatch(/argumentsBlocks/);
    expect(json).not.toMatch(/body/);
    expect(json).toMatch(/foo/);
  });
});

describe("function handles — lowering", () => {
  it("rejects an anonymous function that captures an enclosing local", () => {
    const src = ["k = 5;", "f = @(x) x + k;", "disp(f(3));"].join("\n");
    expect(() => translate(src)).toThrow(/captures 'k'/);
  });

  it("rejects an anonymous function whose body invokes a captured variable", () => {
    const src = [
      "g = @sq;",
      "f = @(x) g(x) + 1;",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    expect(() => translate(src)).toThrow(/captures 'g'/);
  });

  it("accepts an anonymous function whose body calls a workspace function", () => {
    const src = [
      "f = @(x) sq(x) + 1;",
      "disp(f(3));",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    expect(() => translate(src)).not.toThrow();
  });

  it("rejects `@unknown_name` with an unresolved-target error", () => {
    expect(() => translate("f = @nope_not_a_func;")).toThrow(
      /unresolved function-handle target/
    );
  });

  it("two `apply(@foo, x)` and `apply(@bar, x)` produce two distinct specializations", () => {
    const src = [
      "disp(apply(@foo, 5));",
      "disp(apply(@bar, 5));",
      "function r = apply(h, x); r = h(x); end",
      "function y = foo(x); y = x + 1; end",
      "function y = bar(x); y = x - 1; end",
    ].join("\n");
    const c = translate(src);
    // One `apply__<hex>` per distinct handle target — the canonical
    // hash differs in the handle shard.
    const matches = c.match(/static double apply__[0-9a-f]+/g) ?? [];
    expect(new Set(matches).size).toBe(2);
  });
});

describe("function handles — codegen elision", () => {
  it("handle-typed user-function parameters are absent from the emitted signature", () => {
    const src = [
      "disp(apply(@sq, 5));",
      "function r = apply(h, x); r = h(x); end",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // `apply` should have ONE param (x), not two (h, x). Match the
    // entire signature — handle h is elided.
    expect(c).toMatch(/static double apply__[0-9a-f]+\(double x\)/);
    // Header comment annotates the elided handle param.
    expect(c).toMatch(/h\s*:\s*Handle<.*>\s*\(handle, elided\)/);
  });

  it("a top-level handle variable is not predeclared in main", () => {
    const src = [
      "f = @sq;",
      "disp(f(3));",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // `f` is a handle — no `double f` or any declaration for it.
    expect(c).not.toMatch(/[\s,(]\s*f\s*;/);
    expect(c).not.toMatch(/= f\s*\(/);
  });

  it("a factory function returning a handle is emitted as `void` and its call survives for side effects", () => {
    const src = [
      "f = get_h();",
      "disp(f(3));",
      "function h = get_h(); disp(99); h = @sq; end",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // The factory becomes a `void` function (handle return is phantom).
    expect(c).toMatch(/static void get_h__[0-9a-f]+\(void\) \{/);
    // The call survives at the caller for side effects (the `disp(99)`
    // inside the factory must still fire).
    expect(c).toMatch(/^\s*get_h__[0-9a-f]+\(\);/m);
  });
});
