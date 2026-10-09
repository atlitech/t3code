// Fork-only (atlitech/t3code). The personal Android app's versionCode, derived
// from the fork release version so each CI-built APK installs over the last.
// apps/mobile/app.config.ts and scripts/fork-android-identity.ts both import
// it, so it stays free of imports and side effects.

/** The versionCode an unversioned build carries: Expo prebuild's default. */
export const ANDROID_VERSION_CODE_FLOOR = 1;

// Same grammar as scripts/fork-release-guard.ts.
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-atli\.(0|[1-9][0-9]*)$/;

// Each part gets its own decimal field. The largest code, for
// 19.99.999-atli.999, is 2000000001: below Google Play's 2100000000 ceiling,
// which a major of 20 would overflow.
const BOUNDS = { major: 19, minor: 99, patch: 999, atli: 999 } as const;

/**
 * Maps a fork release version X.Y.Z-atli.N to a versionCode that grows with
 * release order and stays above ANDROID_VERSION_CODE_FLOOR.
 */
export function androidVersionCode(version: string): number {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`'${version}' is not a fork release version such as 0.0.46-atli.1.`);
  }
  const [major, minor, patch, atli] = match.slice(1, 5).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const parts = { major, minor, patch, atli };
  for (const key of Object.keys(BOUNDS) as Array<keyof typeof BOUNDS>) {
    if (parts[key] > BOUNDS[key]) {
      throw new Error(
        `'${version}' has ${key} ${parts[key]}, above ${BOUNDS[key]}; the Android versionCode cannot encode it.`,
      );
    }
  }
  return ANDROID_VERSION_CODE_FLOOR + 1 + ((major * 100 + minor) * 1000 + patch) * 1000 + atli;
}
