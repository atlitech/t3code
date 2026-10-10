// @effect-diagnostics nodeBuiltinImport:off - Hashes the stand-in assets the test writes.
import * as NodeCrypto from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildReleaseManifest,
  FORK_SCOPE_DECISION,
  FORK_VERIFICATION_SCOPE,
  MANIFEST_FILE,
  parseAssetName,
  SHA256SUMS_FILE,
  writeReleaseManifest,
} from "./fork-release-manifest.ts";
import { REQUIRED_CHECKS, type AdmissionRecord } from "./linux-admission/admission-record.ts";
import { ADMISSION_FILE } from "./linux-admission/prior-release.ts";

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

const admission: AdmissionRecord = {
  version,
  archive: linux.file,
  archiveSha256: linux.sha256,
  priorVersion: "0.0.46-atli.0",
  priorSource: "bootstrap",
  verifierCommit: commit,
  checks: REQUIRED_CHECKS.map((name) => ({ name, passed: true, detail: "ok" })),
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
    const release = yield* buildReleaseManifest({
      commit,
      version,
      files: [linux, dmg, apk],
      admission,
    });

    assert.strictEqual(release.manifest.commit, commit);
    assert.strictEqual(release.manifest.version, version);
    assert.deepStrictEqual(release.manifest.assets, [
      { platform: "linux", arch: "x64", ...linux },
      { platform: "android", arch: "arm64-v8a", ...apk },
      { platform: "darwin", arch: "arm64", ...dmg },
    ]);
    assert.deepStrictEqual(JSON.parse(release.manifestJson), release.manifest);

    const sums = parseSha256Sums(release.sha256sums);
    assert.strictEqual(sums.size, 3);
    for (const asset of [linux, dmg, apk]) {
      assert.strictEqual(sums.get(asset.file), asset.sha256, asset.file);
    }
  }),
);

it.effect(
  "scopes Linux as runtime-verified by its admission, and Mac and Android as build-checked",
  () =>
    Effect.gen(function* () {
      const release = yield* buildReleaseManifest({
        commit,
        version,
        files: [linux, dmg, apk],
        admission,
      });
      const scope = release.manifest.verificationScope;

      assert.deepStrictEqual(scope.decision, {
        by: "owner",
        date: "2026-10-06",
        text: FORK_SCOPE_DECISION.text,
        runbook: "docs/operations/fork-server.md#verification-scope",
      });
      assert.deepStrictEqual(scope.entries, [
        {
          platform: "linux",
          arch: "x64",
          file: linux.file,
          checks: [
            { job: "admission", step: "Upgrade from the prior release and check the candidate" },
          ],
          status: "runtime-verified",
          runtimeVerified: true,
          admission: { record: ADMISSION_FILE, version, archiveSha256: linux.sha256 },
        },
        {
          platform: "android",
          arch: "arm64-v8a",
          file: apk.file,
          checks: [
            { job: "build-android", step: "Check public config" },
            { job: "build-android", step: "Check APK identity" },
          ],
          status: "build-checked",
          runtimeVerified: false,
        },
        {
          platform: "darwin",
          arch: "arm64",
          file: dmg.file,
          checks: [
            {
              job: "build-mac",
              step: "Check the app's bundle identifier, version, and signature",
            },
          ],
          status: "build-checked",
          runtimeVerified: false,
        },
      ]);
      assert.deepStrictEqual(JSON.parse(release.manifestJson).verificationScope, scope);
    }),
);

it.effect("refuses a scope table marking Mac or Android runtime-verified", () =>
  Effect.gen(function* () {
    for (const platform of ["darwin", "android"]) {
      const scope = FORK_VERIFICATION_SCOPE.map((entry) =>
        entry.platform === platform ? { ...entry, runtimeVerified: true } : entry,
      );
      const error = yield* Effect.flip(
        buildReleaseManifest({ commit, version, files: [linux, dmg, apk], admission, scope }),
      );
      assert.strictEqual(error._tag, "ReleaseManifestError", platform);
      assert.include(error.detail, "runtime-verified", platform);
    }
  }),
);

it.effect("refuses a release without a matching admission", () =>
  Effect.gen(function* () {
    const refused: ReadonlyArray<AdmissionRecord | undefined> = [
      undefined,
      { ...admission, version: "0.0.46-atli.2" },
      { ...admission, archive: "t3-0.0.46-atli.1-linux-arm64.tar.gz" },
      { ...admission, archiveSha256: dmg.sha256 },
      { ...admission, checks: admission.checks.slice(1) },
      {
        ...admission,
        checks: admission.checks.map((check, index) =>
          index === 0 ? { ...check, passed: false } : check,
        ),
      },
    ];
    for (const record of refused) {
      const error = yield* Effect.flip(
        buildReleaseManifest({ commit, version, files: [linux, dmg, apk], admission: record }),
      );
      assert.strictEqual(error._tag, "ReleaseManifestError", JSON.stringify(record));
    }
  }),
);

it.effect("refuses a scope that marks the admitted Linux archive build-checked", () =>
  Effect.gen(function* () {
    const scope = FORK_VERIFICATION_SCOPE.map((entry) =>
      entry.platform === "linux" ? { ...entry, runtimeVerified: false } : entry,
    );
    const error = yield* Effect.flip(
      buildReleaseManifest({ commit, version, files: [linux, dmg, apk], admission, scope }),
    );
    assert.strictEqual(error._tag, "ReleaseManifestError");
  }),
);

it.effect("refuses a release missing a scoped platform, or carrying an unscoped one", () =>
  Effect.gen(function* () {
    for (const files of [
      [linux, dmg],
      [linux, apk],
      [linux, dmg, apk, { ...linux, file: "t3-0.0.46-atli.1-linux-arm64.tar.gz" }],
    ]) {
      const error = yield* Effect.flip(buildReleaseManifest({ commit, version, files, admission }));
      assert.strictEqual(error._tag, "ReleaseManifestError", JSON.stringify(files));
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
      { commit: "0447af610f", files: [linux, dmg, apk] },
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
      const error = yield* Effect.flip(buildReleaseManifest({ version, admission, ...input }));
      assert.strictEqual(error._tag, "ReleaseManifestError", JSON.stringify(input));
    }
  }),
);

// Writes a release directory, runs the CLI's program on it, and reports what
// it left behind.
const writeRelease = (admissionJson: (record: AdmissionRecord) => string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-release-manifest-" });
    const files: Array<{ readonly file: string; readonly size: number; readonly sha256: string }> =
      [];
    for (const [file, contents] of [
      [linux.file, "linux archive"],
      [dmg.file, "mac dmg"],
      [apk.file, "android apk"],
    ] as const) {
      yield* fs.writeFileString(path.join(dir, file), contents);
      const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
      files.push({ file, size: contents.length, sha256 });
    }
    const record = admissionJson({ ...admission, archiveSha256: files[0]!.sha256 });
    if (record !== undefined) {
      yield* fs.writeFileString(path.join(dir, ADMISSION_FILE), record);
    }
    const exit = yield* Effect.exit(
      writeReleaseManifest({
        dir,
        commit,
        version,
        admission: path.join(dir, ADMISSION_FILE),
      }),
    );
    const written = (yield* fs.readDirectory(dir)).toSorted();
    const contents = new Map<string, string>();
    for (const file of [SHA256SUMS_FILE, MANIFEST_FILE].filter((name) => written.includes(name))) {
      contents.set(file, yield* fs.readFileString(path.join(dir, file)));
    }
    return {
      exit,
      written,
      sha256sums: contents.get(SHA256SUMS_FILE),
      manifest: contents.get(MANIFEST_FILE),
    };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("writing a release directory", (it) => {
  it.effect("leaves ADMISSION.json out of the assets and SHA256SUMS", () =>
    Effect.gen(function* () {
      const result = yield* writeRelease((record) => JSON.stringify(record));
      assert.strictEqual(result.exit._tag, "Success");
      assert.include(result.written, MANIFEST_FILE);
      assert.include(result.written, SHA256SUMS_FILE);
      assert.notInclude(result.sha256sums!, ADMISSION_FILE);
      const manifest = JSON.parse(result.manifest!);
      assert.deepStrictEqual(
        manifest.assets.map((asset: { file: string }) => asset.file),
        [linux.file, apk.file, dmg.file],
      );
      assert.strictEqual(manifest.verificationScope.entries[0].runtimeVerified, true);
    }),
  );

  it.effect("writes neither file without a matching admission", () =>
    Effect.gen(function* () {
      const refused: ReadonlyArray<[string, (record: AdmissionRecord) => string | undefined]> = [
        ["no ADMISSION.json", () => undefined],
        ["not an admission record", () => "{}"],
        ["another version", (record) => JSON.stringify({ ...record, version: "0.0.46-atli.2" })],
        ["another file", (record) => JSON.stringify({ ...record, archive: apk.file })],
        ["another sha256", (record) => JSON.stringify({ ...record, archiveSha256: dmg.sha256 })],
      ];
      for (const [name, admissionJson] of refused) {
        const result = yield* writeRelease(admissionJson);
        assert.strictEqual(result.exit._tag, "Failure", name);
        assert.notInclude(result.written, MANIFEST_FILE, name);
        assert.notInclude(result.written, SHA256SUMS_FILE, name);
      }
    }),
  );
});
