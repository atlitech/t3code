import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildReleaseManifest } from "./fork-release-manifest.ts";
import { readReleaseScope } from "./fork-release-scope.ts";
import { REQUIRED_CHECKS, type AdmissionRecord } from "./linux-admission/admission-record.ts";

// An independent reader checks a published release's manifest.json against
// its ADMISSION.json, never trusting the run that published them.
const commit = "0447af610f0447af610f0447af610f0447af610f";
const version = "0.0.46-atli.4";
const linux = {
  file: "t3-0.0.46-atli.4-linux-x64.tar.gz",
  size: 1234,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};
const dmg = {
  file: "T3-Code-0.0.46-atli.4-arm64.dmg",
  size: 91011,
  sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
};
const apk = {
  file: "T3-Code-0.0.46-atli.4-android-arm64-v8a.apk",
  size: 121314,
  sha256: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
};
const admission: AdmissionRecord = {
  version,
  archive: linux.file,
  archiveSha256: linux.sha256,
  priorVersion: "0.0.46-atli.3",
  priorSource: "admitted",
  verifierCommit: commit,
  checks: REQUIRED_CHECKS.map((name) => ({ name, passed: true, detail: "ok" })),
};

const published = Effect.map(
  buildReleaseManifest({ commit, version, files: [linux, dmg, apk], admission }),
  (release) => JSON.parse(release.manifestJson),
);

const read = (manifest: unknown, record: unknown = admission) =>
  readReleaseScope({
    manifestJson: JSON.stringify(manifest),
    admissionJson: JSON.stringify(record),
  });

// The manifest with the entry for `platform` replaced by `edit(entry)`.
const editEntry = (
  manifest: { verificationScope: { entries: ReadonlyArray<{ platform: string }> } },
  platform: string,
  edit: (entry: Record<string, unknown>) => Record<string, unknown>,
) => ({
  ...manifest,
  verificationScope: {
    ...manifest.verificationScope,
    entries: manifest.verificationScope.entries.map((entry) =>
      entry.platform === platform ? edit(entry) : entry,
    ),
  },
});

it.effect("prints each platform's scope for a matching pair", () =>
  Effect.gen(function* () {
    const lines = yield* read(yield* published);

    assert.deepStrictEqual(lines, [
      `linux x64 ${linux.file}: runtime-verified by ADMISSION.json (version ${version}, sha256 ${linux.sha256}); checks: admission "Upgrade from the prior release and check the candidate"`,
      `android arm64-v8a ${apk.file}: build-checked, runtime-unverified (owner decision 2026-10-06); checks: build-android "Check public config", build-android "Check APK identity"`,
      `darwin arm64 ${dmg.file}: build-checked, runtime-unverified (owner decision 2026-10-06); checks: build-mac "Check the app's bundle identifier, version, and signature"`,
    ]);
  }),
);

it.effect("fails when ADMISSION.json names another version, file, or sha256", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    for (const record of [
      { ...admission, version: "0.0.46-atli.5" },
      { ...admission, archive: "t3-0.0.46-atli.4-linux-arm64.tar.gz" },
      { ...admission, archive: dmg.file },
      { ...admission, archiveSha256: dmg.sha256 },
      { ...admission, checks: admission.checks.slice(1) },
      { checks: [] },
    ]) {
      const error = yield* Effect.flip(read(manifest, record));
      assert.strictEqual(error._tag, "ReleaseScopeError", JSON.stringify(record));
    }
  }),
);

it.effect("fails when the manifest's Linux asset is not the admitted archive", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const edited = {
      ...manifest,
      assets: manifest.assets.map((asset: { platform: string }) =>
        asset.platform === "linux" ? { ...asset, sha256: dmg.sha256 } : asset,
      ),
    };
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
    assert.include(error.detail, "sha256");
  }),
);

it.effect("fails when the manifest has no verificationScope", () =>
  Effect.gen(function* () {
    const { verificationScope: _scope, ...manifest } = yield* published;
    const error = yield* Effect.flip(read(manifest));
    assert.strictEqual(error._tag, "ReleaseScopeError");
    assert.include(error.detail, "verificationScope");
  }),
);

it.effect("fails on a hand-edited manifest marking Mac or Android runtime-verified", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    for (const platform of ["darwin", "android"]) {
      for (const edit of [
        (entry: Record<string, unknown>) => ({
          ...entry,
          status: "runtime-verified",
          runtimeVerified: true,
          admission: { record: "ADMISSION.json", version, archiveSha256: linux.sha256 },
        }),
        (entry: Record<string, unknown>) => ({ ...entry, runtimeVerified: true }),
        (entry: Record<string, unknown>) => ({ ...entry, status: "runtime-verified" }),
      ]) {
        const error = yield* Effect.flip(read(editEntry(manifest, platform, edit)));
        assert.strictEqual(error._tag, "ReleaseScopeError", platform);
      }
    }
  }),
);

it.effect("fails when the admitted Linux archive is not stated runtime-verified", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const edited = editEntry(manifest, "linux", ({ admission: _admission, ...entry }) => ({
      ...entry,
      status: "build-checked",
      runtimeVerified: false,
    }));
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
  }),
);

it.effect("fails when an asset has no scope entry", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const edited = {
      ...manifest,
      verificationScope: {
        ...manifest.verificationScope,
        entries: manifest.verificationScope.entries.filter(
          (entry: { platform: string }) => entry.platform !== "android",
        ),
      },
    };
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
  }),
);

// The manifest with the asset and scope entry for `file` given new labels.
const relabel = (
  manifest: {
    assets: ReadonlyArray<{ file: string }>;
    verificationScope: { entries: ReadonlyArray<{ file: string }> };
  },
  file: string,
  labels: Record<string, unknown>,
) => ({
  ...manifest,
  assets: manifest.assets.map((asset) => (asset.file === file ? { ...asset, ...labels } : asset)),
  verificationScope: {
    ...manifest.verificationScope,
    entries: manifest.verificationScope.entries.map((entry) =>
      entry.file === file ? { ...entry, ...labels } : entry,
    ),
  },
});

it.effect("fails when the Linux archive and its entry are relabeled Mac runtime-verified", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    // Drop the real Mac asset so the relabeled archive is the only darwin one.
    const withoutMac = {
      ...manifest,
      assets: manifest.assets.filter((asset: { file: string }) => asset.file !== dmg.file),
      verificationScope: {
        ...manifest.verificationScope,
        entries: manifest.verificationScope.entries.filter(
          (entry: { file: string }) => entry.file !== dmg.file,
        ),
      },
    };
    for (const edited of [
      relabel(withoutMac, linux.file, { platform: "darwin", arch: "arm64" }),
      relabel(manifest, linux.file, { platform: "darwin", arch: "arm64" }),
    ]) {
      const error = yield* Effect.flip(read(edited));
      assert.strictEqual(error._tag, "ReleaseScopeError");
    }
  }),
);

it.effect("fails when an asset's platform or arch disagrees with its file name", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const error = yield* Effect.flip(
      read(relabel(manifest, apk.file, { platform: "android", arch: "x86_64" })),
    );
    assert.strictEqual(error._tag, "ReleaseScopeError");
    assert.include(error.detail, "its name says android arm64-v8a");
  }),
);

it.effect("fails when an asset is outside the committed verification scope", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const arm = {
      platform: "linux",
      arch: "arm64",
      file: "t3-0.0.46-atli.4-linux-arm64.tar.gz",
      size: 1,
      sha256: dmg.sha256,
    };
    const edited = {
      ...manifest,
      assets: [...manifest.assets, arm],
      verificationScope: {
        ...manifest.verificationScope,
        entries: [
          ...manifest.verificationScope.entries,
          {
            platform: arm.platform,
            arch: arm.arch,
            file: arm.file,
            status: "build-checked",
            runtimeVerified: false,
            checks: [{ job: "build-linux", step: "Build and smoke-test CLI archive" }],
          },
        ],
      },
    };
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
    assert.include(error.detail, "no committed verification scope");
  }),
);

it.effect("fails when an entry claims checks the committed scope does not name", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const edited = editEntry(manifest, "darwin", (entry) => ({
      ...entry,
      checks: [{ job: "build-mac", step: "Build desktop DMG" }],
    }));
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
  }),
);

it.effect("fails when one check's step embeds quotes to read like the two committed checks", () =>
  Effect.gen(function* () {
    const manifest = yield* published;
    const forged = {
      job: "build-android",
      step: 'Check public config", build-android "Check APK identity',
    };
    // Rendered for a message, the forged check matches the committed pair.
    assert.strictEqual(
      `${forged.job} "${forged.step}"`,
      'build-android "Check public config", build-android "Check APK identity"',
    );
    const edited = editEntry(manifest, "android", (entry) => ({ ...entry, checks: [forged] }));
    const error = yield* Effect.flip(read(edited));
    assert.strictEqual(error._tag, "ReleaseScopeError");
    assert.include(error.detail, "not the committed");
  }),
);
