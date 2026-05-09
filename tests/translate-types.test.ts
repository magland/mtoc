import { describe, expect, it } from "vitest";

import {
  canonicalizeType,
  isString,
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
    rows: { kind: "one" },
    cols: { kind: "one" },
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
