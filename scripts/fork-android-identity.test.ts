// @effect-diagnostics nodeBuiltinImport:off - Reads committed aapt and apksigner fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  checkAndroidIdentity,
  parseBadging,
  parseSignerSha256,
  readRecordedSha256,
} from "./fork-android-identity.ts";
import { androidVersionCode } from "./lib/android-version-code.ts";

// Fixtures are captured from the owner's local personal build
// (apps/mobile/android/app/build/outputs/apk/release/app-release.apk, built by
// the personal Android skill's script): `aapt dump badging` and `apksigner
// verify --print-certs` from build-tools 36.0.0. That build is unversioned, so
// it carries versionCode 1; the passing case rewrites it to a release's code.
const fixture = (name: string): string =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "fixtures", "fork-android-identity", name),
    "utf8",
  );

const recordedSha256 = "8be8ce453295854ea7d25ace67081dd59a924ec1ae8ae111721e8c2446b37e8e";
const version = "0.0.46-atli.4";
const capturedBadging = fixture("badging.txt");
const badging = capturedBadging.replace(
  "versionCode='1'",
  `versionCode='${androidVersionCode(version)}'`,
);
const certs = fixture("certs.txt");
const skill = NodeFS.readFileSync(
  NodePath.join(
    import.meta.dirname,
    "..",
    ".agents",
    "skills",
    "develop-t3-personal-android",
    "SKILL.md",
  ),
  "utf8",
);

it("reads the package line, the signer digests, and the recorded fingerprint", () => {
  assert.deepStrictEqual(parseBadging(capturedBadging), {
    packageName: "com.elvis.t3code",
    versionCode: "1",
    versionName: "2.0.0",
  });
  assert.deepStrictEqual(parseSignerSha256(certs), [recordedSha256]);
  assert.strictEqual(readRecordedSha256(skill), recordedSha256);
  assert.strictEqual(readRecordedSha256("SHA-256: 8B:E8\n"), "8be8");
  assert.strictEqual(readRecordedSha256("no fingerprint here\n"), undefined);
});

it.effect("accepts the recorded personal identity", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* checkAndroidIdentity({ badging, certs, version, skill }), {
      packageName: "com.elvis.t3code",
      versionCode: "46006",
      version,
    });
  }),
);

it.effect("refuses a wrong package, certificate, signer count, or versionCode", () =>
  Effect.gen(function* () {
    const refused = [
      { badging: badging.replace("name='com.elvis.t3code'", "name='com.t3tools.t3code'"), certs },
      { badging, certs: certs.replace(recordedSha256, "0".repeat(64)) },
      {
        badging,
        certs: `${certs}Signer #2 certificate SHA-256 digest: ${recordedSha256}\n`,
      },
      { badging: capturedBadging, certs },
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(checkAndroidIdentity({ ...input, version, skill }));
      assert.strictEqual(error._tag, "AndroidIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    const otherRelease = yield* Effect.flip(
      checkAndroidIdentity({ badging, certs, version: "0.0.46-atli.5", skill }),
    );
    assert.strictEqual(otherRelease.problems.length, 1, otherRelease.message);
    const malformed = yield* Effect.flip(
      checkAndroidIdentity({ badging, certs, version: "0.0.46", skill }),
    );
    assert.strictEqual(malformed.problems.length, 1, malformed.message);
  }),
);
