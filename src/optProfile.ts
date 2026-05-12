/**
 * Optimization profiles — bundled defaults for the trio of toggles that
 * affect both translation and the build:
 *   - `enableTempInlining` (IR-to-IR temp-substitution pass)
 *   - `fastMath` (`-ffast-math` on the cc line)
 *   - `threads` (OpenMP parallel-for emission + `-fopenmp` link)
 *
 * Shared by the CLI ([cli.ts](./cli.ts)), the web IDE
 * ([components/IDEWorkspace.tsx](./components/IDEWorkspace.tsx)), and the
 * remote execution server ([../server/execution-service.ts](../server/execution-service.ts))
 * so a profile name resolves to the same trio everywhere.
 *
 * Two-step resolution: pick a profile, then apply any explicit per-flag
 * overrides on top. That keeps positive flags (`--fast-math`) and
 * negative flags (`--no-fast-math`) composable with `--opt aggressive`
 * / `--opt none` etc. Individual overrides always win over the profile.
 */

export type OptProfile = "none" | "safe" | "default" | "aggressive";

export const OPT_PROFILES: ReadonlyArray<OptProfile> = [
  "none",
  "safe",
  "default",
  "aggressive",
];

export const DEFAULT_OPT_PROFILE: OptProfile = "default";

export interface OptSettings {
  enableTempInlining: boolean;
  fastMath: boolean;
  threads: number | "auto";
}

/** The bundled settings for each profile name.
 *
 *  `default` and `safe` are intentionally identical — the split exists
 *  so a future "default" tweak can move without churning callers that
 *  pin to "safe" specifically. `none` reproduces the pre-profile
 *  baseline (single-threaded, no inlining, no fast-math) so users who
 *  want byte-stability with older mtoc output have a named handle.
 *  `aggressive` opts into `-ffast-math` — numerics may drift in the
 *  last few ulps. */
const PROFILES: Readonly<Record<OptProfile, OptSettings>> = {
  none: { enableTempInlining: false, fastMath: false, threads: 1 },
  safe: { enableTempInlining: true, fastMath: false, threads: "auto" },
  default: { enableTempInlining: true, fastMath: false, threads: "auto" },
  aggressive: { enableTempInlining: true, fastMath: true, threads: "auto" },
};

export function profileSettings(profile: OptProfile): OptSettings {
  return PROFILES[profile];
}

/** Resolve the final trio of settings from a profile + per-flag
 *  overrides. Undefined overrides leave the profile's choice
 *  untouched. */
export function resolveOptSettings(
  profile: OptProfile = DEFAULT_OPT_PROFILE,
  overrides: Partial<OptSettings> = {}
): OptSettings {
  const base = PROFILES[profile];
  return {
    enableTempInlining: overrides.enableTempInlining ?? base.enableTempInlining,
    fastMath: overrides.fastMath ?? base.fastMath,
    threads: overrides.threads ?? base.threads,
  };
}

/** True when `s` is one of the four profile names. Used by the CLI's
 *  `--opt` validator and the server's request validator. */
export function isOptProfile(s: unknown): s is OptProfile {
  return (
    typeof s === "string" && (OPT_PROFILES as ReadonlyArray<string>).includes(s)
  );
}
