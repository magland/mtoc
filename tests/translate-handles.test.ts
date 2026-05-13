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
    // Storage category encodes both the target identity AND the
    // capture-tuple shape (`:empty` for no captures).
    expect(storageCategory(u)).toEqual({
      kind: "handle",
      id: "handle:userFunc:x.m:foo:empty",
    });
    expect(storageCategory(b)).toEqual({
      kind: "handle",
      id: "handle:builtin:sin:empty",
    });
    expect(storageCategory(a)).toEqual({
      kind: "handle",
      id: "handle:anonymous:anon_0:empty",
    });
    // Two distinct anonymous handles must have distinct categories.
    const a2 = anonymousHandle("anon_1", fakeAst, "x.m");
    expect(storageCategory(a)?.id).not.toBe(storageCategory(a2)?.id);
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
  it("accepts an anonymous function that captures an enclosing scalar local", () => {
    const src = ["k = 5;", "f = @(x) x + k;", "disp(f(3));"].join("\n");
    expect(() => translate(src)).not.toThrow();
  });

  it("accepts an anonymous function whose body invokes a captured handle", () => {
    const src = [
      "g = @sq;",
      "f = @(x) g(x) + 1;",
      "disp(f(4));",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    expect(() => translate(src)).not.toThrow();
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

describe("function handles — codegen", () => {
  it("handle-typed user-function parameters appear in the emitted signature with the handle typedef", () => {
    const src = [
      "disp(apply(@sq, 5));",
      "function r = apply(h, x); r = h(x); end",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // `apply` takes `(h: handle, x: double)`. The handle param uses
    // the shared empty typedef since `@sq` has no captures.
    expect(c).toMatch(
      /static double apply__[0-9a-f]+\(_mtoc_handle_empty_t h, double x\)/
    );
    // No-capture handle typedef is generated with the placeholder field.
    expect(c).toMatch(/typedef struct _mtoc_handle_empty_t \{/);
    expect(c).toMatch(/char _placeholder/);
  });

  it("a top-level handle variable is predeclared as the handle typedef", () => {
    const src = [
      "f = @sq;",
      "disp(f(3));",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // `f` is declared with the empty handle typedef and initialized
    // to its empty helper.
    expect(c).toMatch(
      /_mtoc_handle_empty_t f = _mtoc_handle_empty_t_empty\(\);/
    );
  });

  it("a factory function returning a handle returns the handle struct by value", () => {
    const src = [
      "f = get_h();",
      "disp(f(3));",
      "function h = get_h(); disp(99); h = @sq; end",
      "function y = sq(x); y = x*x; end",
    ].join("\n");
    const c = translate(src);
    // The factory returns the handle typedef by value.
    expect(c).toMatch(
      /static _mtoc_handle_empty_t get_h__[0-9a-f]+\(void\) \{/
    );
    // The factory's body emits `disp(99)` as a side effect.
    expect(c).toMatch(/mtoc_disp_double\(99\.0\);/);
    // The caller installs the returned handle into f via the kind's
    // assign helper.
    expect(c).toMatch(
      /_mtoc_handle_empty_t_assign\(&f, get_h__[0-9a-f]+\(\)\);/
    );
  });

  it("an anonymous function with a scalar capture lowers to a per-shape handle struct", () => {
    const src = ["k = 5;", "f = @(x) x + k;", "disp(f(3));"].join("\n");
    const c = translate(src);
    // Per-capture-shape typedef with a `cap_k: double` field.
    expect(c).toMatch(/typedef struct _mtoc_handle__[0-9a-f]+ \{/);
    expect(c).toMatch(/double cap_k;/);
    // The handle assignment installs a struct literal carrying k's
    // snapshot value.
    expect(c).toMatch(
      /_mtoc_handle__[0-9a-f]+_assign\(&f, \(_mtoc_handle__[0-9a-f]+\)\{\.cap_k = k\}\);/
    );
    // The anonymous body becomes a synthetic user function with the
    // capture as a tail parameter.
    expect(c).toMatch(
      /static double anon_[0-9]+__[0-9a-f]+\(double x, double k\)/
    );
  });

  it("a tensor-typed capture is deep-copied into the handle struct at @-site", () => {
    const src = ["v = [1 2 3];", "f = @(i) v(i);", "disp(f(2));"].join("\n");
    const c = translate(src);
    // The handle's struct has a tensor capture field.
    expect(c).toMatch(/mtoc_tensor_t cap_v;/);
    // The @-site struct literal deep-copies v into cap_v.
    expect(c).toMatch(/\.cap_v = mtoc_tensor_copy\(v\)/);
    // The handle struct's _free helper releases the captured tensor.
    expect(c).toMatch(
      /_mtoc_handle__[0-9a-f]+_free.*mtoc_tensor_free\(&h->cap_v\)/s
    );
  });

  it("two handles with different capture-tuple shapes get distinct typedefs", () => {
    const src = [
      "k = 5;",
      "v = [1 2 3];",
      "f = @(x) x + k;",
      "g = @(i) v(i);",
      "disp(f(1));",
      "disp(g(1));",
    ].join("\n");
    const c = translate(src);
    const typedefs = c.match(/_mtoc_handle__[0-9a-f]+(?= cap|\b)/g) ?? [];
    const uniq = new Set(typedefs.map(t => t.split(" ")[0]));
    // At least two distinct handle typedefs (one for k:double, one for
    // v:tensor). The shared empty placeholder is not present here
    // because both handles capture.
    expect(uniq.size).toBeGreaterThanOrEqual(2);
  });

  it("factory functions returning a handle with captures return the struct by value", () => {
    const src = [
      "f = make_adder(7);",
      "disp(f(3));",
      "function h = make_adder(k); h = @(x) x + k; end",
    ].join("\n");
    const c = translate(src);
    // The factory returns the handle typedef by value.
    expect(c).toMatch(
      /static _mtoc_handle__[0-9a-f]+ make_adder__[0-9a-f]+\(double k\)/
    );
    // The factory body installs the captures into its return handle.
    expect(c).toMatch(
      /_mtoc_handle__[0-9a-f]+_assign\(&h, \(_mtoc_handle__[0-9a-f]+\)\{\.cap_k = k\}\);/
    );
  });
});
