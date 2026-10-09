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

it("reads platform and arch from the archive name", () => {
  assert.deepStrictEqual(parseAssetName(version, linux.file), { platform: "linux", arch: "x64" });
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.2-linux-x64.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux-x64-musl.tar.gz"));
  assert.isUndefined(parseAssetName(version, "t3-0.0.46-atli.1-linux-x64.zip"));
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
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(buildReleaseManifest({ version, ...input }));
      assert.strictEqual(error._tag, "ReleaseManifestError", JSON.stringify(input));
    }
  }),
);
