import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildReleaseManifest, type ReleaseManifest } from "./fork-release-manifest.ts";
import { buildReleaseNotes } from "./fork-release-notes.ts";
import { REQUIRED_CHECKS, type AdmissionRecord } from "./linux-admission/admission-record.ts";

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

const manifest = Effect.map(
  buildReleaseManifest({ commit, version, files: [linux, dmg, apk], admission }),
  (release) => release.manifest,
);

const withEntry = (
  release: ReleaseManifest,
  platform: string,
  edit: (
    entry: ReleaseManifest["verificationScope"]["entries"][number],
  ) => ReleaseManifest["verificationScope"]["entries"][number],
): ReleaseManifest => ({
  ...release,
  verificationScope: {
    ...release.verificationScope,
    entries: release.verificationScope.entries.map((entry) =>
      entry.platform === platform ? edit(entry) : entry,
    ),
  },
});

const lineFor = (notes: string, label: string): string => {
  const lines = notes.split("\n").filter((line) => line.startsWith(`- ${label}`));
  assert.strictEqual(lines.length, 1, label);
  return lines[0]!;
};

it.effect("says Linux is runtime-verified and Mac and Android are build-checked only", () =>
  Effect.gen(function* () {
    const notes = yield* buildReleaseNotes(yield* manifest);

    const linuxLine = lineFor(notes, "Linux x64 server");
    assert.include(linuxLine, linux.file);
    assert.include(linuxLine, ": runtime-verified.");
    assert.include(linuxLine, `sha256 \`${linux.sha256}\``);
    assert.include(linuxLine, `version ${version}`);

    for (const [label, file] of [
      ["Mac arm64 desktop app", dmg.file],
      ["Android arm64-v8a APK", apk.file],
    ] as const) {
      const line = lineFor(notes, label);
      assert.include(line, file, label);
      assert.include(line, "build-checked but runtime-unverified", label);
      assert.notMatch(line, /runtime-verified/, label);
    }
    assert.include(lineFor(notes, "Android arm64-v8a APK"), '"Check APK identity"');
    assert.include(
      lineFor(notes, "Mac arm64 desktop app"),
      '"Check the app\'s bundle identifier, version, and signature"',
    );
    assert.include(notes, "owner decision of 2026-10-06");
    assert.include(notes, commit);
  }),
);

it.effect("fails when a Mac or Android line would say runtime-verified", () =>
  Effect.gen(function* () {
    const release = yield* manifest;
    for (const platform of ["darwin", "android"]) {
      for (const edit of [
        (entry: ReleaseManifest["verificationScope"]["entries"][number]) => ({
          ...entry,
          runtimeVerified: true,
        }),
        (entry: ReleaseManifest["verificationScope"]["entries"][number]) => ({
          ...entry,
          status: "runtime-verified" as const,
        }),
        (entry: ReleaseManifest["verificationScope"]["entries"][number]) => ({
          ...entry,
          checks: [{ job: "build-mac", step: "Runtime-verified on a real device" }],
        }),
      ]) {
        const error = yield* Effect.flip(buildReleaseNotes(withEntry(release, platform, edit)));
        assert.strictEqual(error._tag, "ReleaseNotesError", platform);
      }
    }
  }),
);

it.effect("fails when Linux is not runtime-verified by an admission", () =>
  Effect.gen(function* () {
    const release = yield* manifest;
    const edited = withEntry(release, "linux", ({ admission: _admission, ...entry }) => ({
      ...entry,
      status: "build-checked",
      runtimeVerified: false,
    }));
    const error = yield* Effect.flip(buildReleaseNotes(edited));
    assert.strictEqual(error._tag, "ReleaseNotesError");
  }),
);
