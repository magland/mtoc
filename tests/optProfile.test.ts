import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPT_PROFILE,
  OPT_PROFILES,
  isOptProfile,
  profileSettings,
  resolveOptSettings,
} from "../src/optProfile.js";

/**
 * Tests for the optimization-profile resolver in
 * [src/optProfile.ts](../src/optProfile.ts). The CLI, the web IDE, and
 * the remote execution server all flow through `resolveOptSettings`, so
 * pinning the table here is the single source of truth for "what does
 * `--opt aggressive --no-fast-math` actually translate to."
 */

describe("OPT_PROFILES table", () => {
  it("`none` is the pre-optimization baseline", () => {
    // The `none` profile is the handle users reach for when they need
    // byte-stability with older mtoc output — every toggle is off,
    // threads pinned at 1.
    expect(profileSettings("none")).toEqual({
      enableTempInlining: false,
      fastMath: false,
      threads: 1,
    });
  });

  it("`safe` and `default` are identical", () => {
    // Keeping them separate (with the same body) means we can move
    // `default` later without breaking callers that pin to `safe`.
    expect(profileSettings("safe")).toEqual(profileSettings("default"));
  });

  it("`default` has inline-temps + threads auto but NOT fast-math", () => {
    // Fast-math changes numerics in the last few ulps — surprising
    // as a silent default. Users opt in via `--opt aggressive` or
    // `--fast-math`.
    expect(profileSettings("default")).toEqual({
      enableTempInlining: true,
      fastMath: false,
      threads: "auto",
    });
  });

  it("`aggressive` flips fast-math on", () => {
    expect(profileSettings("aggressive")).toEqual({
      enableTempInlining: true,
      fastMath: true,
      threads: "auto",
    });
  });

  it("the default profile name is 'default'", () => {
    expect(DEFAULT_OPT_PROFILE).toBe("default");
  });

  it("OPT_PROFILES enumerates the four valid names", () => {
    expect([...OPT_PROFILES]).toEqual([
      "none",
      "safe",
      "default",
      "aggressive",
    ]);
  });
});

describe("isOptProfile", () => {
  it("accepts the four valid names", () => {
    expect(isOptProfile("none")).toBe(true);
    expect(isOptProfile("safe")).toBe(true);
    expect(isOptProfile("default")).toBe(true);
    expect(isOptProfile("aggressive")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isOptProfile("")).toBe(false);
    expect(isOptProfile("DEFAULT")).toBe(false);
    expect(isOptProfile("max")).toBe(false);
    expect(isOptProfile(undefined)).toBe(false);
    expect(isOptProfile(null)).toBe(false);
    expect(isOptProfile(0)).toBe(false);
  });
});

describe("resolveOptSettings (profile + per-flag overrides)", () => {
  it("with no args returns the `default` profile's settings", () => {
    expect(resolveOptSettings()).toEqual(profileSettings("default"));
  });

  it("returns the profile's settings when no overrides are passed", () => {
    expect(resolveOptSettings("none")).toEqual(profileSettings("none"));
    expect(resolveOptSettings("aggressive")).toEqual(
      profileSettings("aggressive")
    );
  });

  it("individual overrides win over the profile", () => {
    // `aggressive --no-fast-math` is the documented escape hatch for
    // "I want parallel + inlining but keep IEEE-754 numerics."
    expect(resolveOptSettings("aggressive", { fastMath: false })).toEqual({
      enableTempInlining: true,
      fastMath: false,
      threads: "auto",
    });
  });

  it("partial overrides leave the rest of the profile untouched", () => {
    // Just `--threads 4` on top of `--opt none` should bump threads
    // without re-enabling inlining or fast-math.
    expect(resolveOptSettings("none", { threads: 4 })).toEqual({
      enableTempInlining: false,
      fastMath: false,
      threads: 4,
    });
  });

  it("explicit `false` overrides flip a profile's `true` setting off", () => {
    // The tristate is the whole point of this layer — `false` and
    // `undefined` must be distinguishable so `--no-inline-temps`
    // (false) cleanly cancels `default`'s `true`.
    expect(
      resolveOptSettings("default", { enableTempInlining: false })
    ).toMatchObject({ enableTempInlining: false });
  });

  it("explicit `true` overrides flip a profile's `false` setting on", () => {
    expect(resolveOptSettings("none", { enableTempInlining: true })).toEqual({
      enableTempInlining: true,
      fastMath: false,
      threads: 1,
    });
  });
});
