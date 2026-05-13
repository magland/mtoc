import { describe, expect, it } from "vitest";

import {
  canonicalizeType,
  isString,
  scalarChar,
  scalarComplex,
  scalarDouble,
  stringType,
  STRING,
  unify,
  type NumericType,
} from "../src/lowering/types.js";

describe("type system invariants", () => {
  // Sign is meaningful only when isComplex === false. The invariant is
  // enforced at observation sites (canonicalizeType, unify) so a stray
  // sign carried through can't bloat the specialization cache.

  const complexScalar = (sign: NumericType["sign"]): NumericType => ({
    kind: "Numeric",
    elem: "double",
    isComplex: true,
    dims: [{ kind: "one" }, { kind: "one" }],
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

  it("isString narrows MType to StringType", () => {
    const s = STRING;
    expect(isString(s)).toBe(true);
    expect(isString({ kind: "Unknown" })).toBe(false);
    expect(isString(complexScalar("unknown"))).toBe(false);
  });

  it("unify of two strings is a string; string vs numeric collapses to Unknown", () => {
    expect(unify(STRING, STRING)).toEqual(STRING);
    expect(unify(STRING, complexScalar("unknown")).kind).toBe("Unknown");
    expect(unify(complexScalar("unknown"), STRING).kind).toBe("Unknown");
  });

  it("canonicalizeType picks a stable hash entry for strings", () => {
    expect(canonicalizeType(STRING)).toEqual({ kind: "String" });
  });
});

describe("exact-value tracking on scalar types", () => {
  // The `exact` field carries a statically-known scalar value:
  //   - real double scalar → number
  //   - complex double scalar → {re, im}
  //   - scalar char → one-char string
  //   - string → string value
  // Stage A: factories accept it, unify preserves/drops it, but
  // canonicalizeType (specialization keys) ignores it.

  it("scalarDouble factory pins the exact value when provided", () => {
    const t = scalarDouble("positive", 5);
    expect(t.exact).toBe(5);
    expect(t.sign).toBe("positive");
    // Omitting the third arg leaves exact unset.
    expect(scalarDouble("positive").exact).toBeUndefined();
  });

  it("scalarComplex factory pins the {re,im} exact when provided", () => {
    const t = scalarComplex({ re: 3, im: 4 });
    expect(t.exact).toEqual({ re: 3, im: 4 });
    expect(scalarComplex().exact).toBeUndefined();
  });

  it("scalarChar factory pins the one-char exact when provided", () => {
    const t = scalarChar("a");
    expect(t.exact).toBe("a");
    expect(scalarChar().exact).toBeUndefined();
  });

  it("stringType factory pins the string exact when provided", () => {
    const t = stringType("hello");
    expect(t.exact).toBe("hello");
    expect(stringType().exact).toBeUndefined();
    // No-exact form returns the canonical STRING singleton.
    expect(stringType()).toBe(STRING);
  });

  it("unify preserves exact when both sides agree", () => {
    const a = scalarDouble("positive", 5);
    const b = scalarDouble("positive", 5);
    const u = unify(a, b);
    expect(u.kind).toBe("Numeric");
    if (u.kind === "Numeric") expect(u.exact).toBe(5);

    const sa = stringType("hi");
    const sb = stringType("hi");
    const su = unify(sa, sb);
    expect(su.kind).toBe("String");
    if (su.kind === "String") expect(su.exact).toBe("hi");
  });

  it("unify drops exact when the two sides differ", () => {
    const a = scalarDouble("positive", 5);
    const b = scalarDouble("positive", 6);
    const u = unify(a, b);
    expect(u.kind).toBe("Numeric");
    if (u.kind === "Numeric") expect(u.exact).toBeUndefined();

    const sa = stringType("hi");
    const sb = stringType("bye");
    const su = unify(sa, sb);
    expect(su.kind).toBe("String");
    if (su.kind === "String") expect(su.exact).toBeUndefined();
  });

  it("unify drops exact when one side carries it and the other does not", () => {
    const a = scalarDouble("unknown", 5);
    const b = scalarDouble("unknown");
    const u = unify(a, b);
    expect(u.kind).toBe("Numeric");
    if (u.kind === "Numeric") expect(u.exact).toBeUndefined();
  });

  it("unify drops exact when the merged shape is no longer scalar", () => {
    // Scalar+tensor merge widens the shape to unknown — exact must
    // not survive (the carrier invariant is scalar-only).
    const scalar = scalarDouble("positive", 5);
    const tensor: NumericType = {
      kind: "Numeric",
      elem: "double",
      isComplex: false,
      dims: [{ kind: "one" }, { kind: "notOne" }],
      sign: "positive",
    };
    const u = unify(scalar, tensor);
    expect(u.kind).toBe("Numeric");
    if (u.kind === "Numeric") expect(u.exact).toBeUndefined();
  });

  it("complex exact compares by {re,im} pair", () => {
    const a = scalarComplex({ re: 3, im: 4 });
    const b = scalarComplex({ re: 3, im: 4 });
    const u = unify(a, b);
    expect(u.kind).toBe("Numeric");
    if (u.kind === "Numeric") expect(u.exact).toEqual({ re: 3, im: 4 });

    const c = scalarComplex({ re: 3, im: 5 });
    const u2 = unify(a, c);
    expect(u2.kind).toBe("Numeric");
    if (u2.kind === "Numeric") expect(u2.exact).toBeUndefined();
  });

  it("canonicalizeType does NOT include exact (Stage A: spec keys unchanged)", () => {
    // Two scalars with different exact values must canonicalize the
    // same way — otherwise every literal-fed call site would split
    // into its own specialization.
    const a = canonicalizeType(scalarDouble("positive", 5));
    const b = canonicalizeType(scalarDouble("positive", 6));
    const bare = canonicalizeType(scalarDouble("positive"));
    expect(a).toEqual(bare);
    expect(b).toEqual(bare);

    expect(canonicalizeType(stringType("hi"))).toEqual({ kind: "String" });
    expect(canonicalizeType(stringType("bye"))).toEqual({ kind: "String" });
  });
});
