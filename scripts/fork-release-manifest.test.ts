import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildReleaseManifest, parseAssetName } from "./fork-release-manifest.ts";

const commit = "0447af610f0447af610f0447af610f0447af610f";
const version = "0.0.46-atli.1";
const linux = {
  file: "t3-0.0.46-atli.1-linux-x64.tar.gz",
  size: 1234,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};
const mac = {
  file: "t3-0.0.46-atli.1-darwin-arm64.tar.gz",
  size: 5678,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};
const dmg = {
  file: "T3-Code-0.0.46-atli.1-arm64.dmg",
  size: 91011,
  sha256: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
};
const apk = {
  file: "T3-Code-0.0.46-atli.1-android-arm64-v8a.apk",
  size: 121314,
  sha256: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
};

const parseSha256Sums = (text: string) =>
  new Map(
    text
      .trimEnd()
      .split("\n")
      .map((line) => {
        const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
        assert.isNotNull(match, line);
        return [match![2]!, match![1]!] as const;
      }),
  );

it.effect("names the commit, version and every asset, agreeing with SHA256SUMS", () =>
  Effect.gen(function* () {
    const release = yield* buildReleaseManifest({ commit, version, files: [linux, mac] });

    assert.deepStrictEqual(release.manifest, {
      commit,
      version,
      assets: [
        { platform: "darwin", arch: "arm64", ...mac },
        { platform: "linux", arch: "x64", ...linux },
      ],
    });
    assert.deepStrictEqual(JSON.parse(release.manifestJson), release.manifest);

    const sums = parseSha256Sums(release.sha256sums);
    assert.strictEqual(sums.size, release.manifest.assets.length);
    for (const asset of release.manifest.assets) {
      assert.strictEqual(sums.get(asset.file), asset.sha256, asset.file);
    }
  }),
);

it.effect("records the Mac desktop DMG as darwin arm64, next to the server archive", () =>
  Effect.gen(function* () {
    const release = yield* buildReleaseManifest({ commit, version, files: [dmg, linux] });

    assert.deepStrictEqual(release.manifest.assets, [
      { platform: "linux", arch: "x64", ...linux },
      { platform: "darwin", arch: "arm64", ...dmg },
    ]);
    assert.strictEqual(parseSha256Sums(release.sha256sums).get(dmg.file), dmg.sha256);
  }),
);

it.effect("records the personal Android APK as android arm64-v8a", () =>
  Effect.gen(function* () {
    const release = yield* buildReleaseManifest({ commit, version, files: [apk] });

    assert.deepStrictEqual(release.manifest.assets, [
      { platform: "android", arch: "arm64-v8a", ...apk },
    ]);
    assert.strictEqual(release.sha256sums, `${apk.sha256}  ${apk.file}\n`);
  }),
);

it.effect("lists the server archive, the DMG, and the APK of one release", () =>
  Effect.gen(function* () {
    const release = yield* buildReleaseManifest({ commit, version, files: [linux, dmg, apk] });

    assert.deepStrictEqual(release.manifest.assets, [
      { platform: "linux", arch: "x64", ...linux },
      { platform: "android", arch: "arm64-v8a", ...apk },
      { platform: "darwin", arch: "arm64", ...dmg },
    ]);
    const sums = parseSha256Sums(release.sha256sums);
    assert.strictEqual(sums.size, 3);
    for (const asset of [linux, dmg, apk]) {
      assert.strictEqual(sums.get(asset.file), asset.sha256, asset.file);
    }
  }),
);

it("reads platform and arch from the archive name", () => {
  assert.deepStrictEqual(parseAssetName(version, linux.file), { platform: "linux", arch: "x64" });
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.2-linux-x64.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux-x64-musl.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux-x64.zip"));
});

it("reads the Mac desktop DMG only under its exact name", () => {
  assert.deepStrictEqual(parseAssetName(version, dmg.file), { platform: "darwin", arch: "arm64" });
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.2-arm64.dmg"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-x64.dmg"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-arm64.dmg.blockmap"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-arm64.zip"));
  assert.isUndefined(parseAssetName(version, "t3-code-0.0.46-atli.1-arm64.dmg"));
});

it("reads the personal Android APK only under its exact name", () => {
  assert.deepStrictEqual(parseAssetName(version, apk.file), {
    platform: "android",
    arch: "arm64-v8a",
  });
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.2-android-arm64-v8a.apk"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-android-x86_64.apk"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-android-arm64.apk"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-android-arm64-v8a.apk.idsig"));
  assert.isUndefined(parseAssetName(version, "T3-Code-0.0.46-atli.1-android-arm64-v8a.aab"));
  assert.isUndefined(parseAssetName(version, "t3-code-0.0.46-atli.1-android-arm64-v8a.apk"));
  assert.isUndefined(parseAssetName(version, "app-release.apk"));
});

it.effect("refuses files a release must not carry", () =>
  Effect.gen(function* () {
    const refused = [
      { commit: "0447af610f", files: [linux] },
      { commit, files: [] },
      { commit, files: [{ ...linux, file: "notes.txt" }] },
      { commit, files: [{ ...linux, sha256: "abc" }] },
      { commit, files: [{ ...linux, size: 0 }] },
      { commit, files: [linux, { ...linux, sha256: mac.sha256 }] },
      { commit, files: [mac, dmg] },
      { commit, files: [{ ...dmg, file: "T3-Code-0.0.46-atli.1-arm64.dmg.blockmap" }] },
      { commit, files: [{ ...apk, file: "T3-Code-0.0.46-atli.1-android-arm64-v8a.apk.idsig" }] },
      { commit, files: [apk, { ...apk, sha256: dmg.sha256 }] },
      { commit, files: [{ ...apk, size: 0 }] },
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(buildReleaseManifest({ version, ...input }));
      assert.strictEqual(error._tag, "ReleaseManifestError", JSON.stringify(input));
    }
  }),
);
