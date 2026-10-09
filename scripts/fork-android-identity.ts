#!/usr/bin/env node

// Fork-only (atlitech/t3code). Checks the personal Android APK that
// fork-server-release.yml builds before the workflow uploads it: the package is
// the personal app's, the versionCode is the one the release version derives,
// and one certificate signs it whose SHA-256 is the fingerprint recorded in the
// personal Android skill, so the APK installs over the owner's existing app.
// The workflow hands over the output of `aapt dump badging <apk>` and
// `apksigner verify --print-certs <apk>`. Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { androidVersionCode } from "./lib/android-version-code.ts";

export const PERSONAL_ANDROID_PACKAGE = "com.elvis.t3code";

// The skill sits at a fixed place relative to this script in the repository.
const DEFAULT_SKILL = `${import.meta.dirname}/../.agents/skills/develop-t3-personal-android/SKILL.md`;

export interface AndroidBadging {
  readonly packageName: string | undefined;
  readonly versionCode: string | undefined;
  readonly versionName: string | undefined;
}

/** Reads the `package:` line of `aapt dump badging` output. */
export const parseBadging = (output: string): AndroidBadging => {
  const line = /^package: (.*)$/m.exec(output)?.[1] ?? "";
  const attribute = (name: string) => new RegExp(`(?:^| )${name}='([^']*)'`).exec(line)?.[1];
  return {
    packageName: attribute("name"),
    versionCode: attribute("versionCode"),
    versionName: attribute("versionName"),
  };
};

/** Lowercase hex without colons or whitespace, so differently printed digests compare. */
export const normalizeSha256 = (fingerprint: string): string =>
  fingerprint.replace(/[\s:]/g, "").toLowerCase();

/** Each signer's certificate SHA-256 from `apksigner verify --print-certs` output. */
export const parseSignerSha256 = (output: string): ReadonlyArray<string> =>
  Array.from(
    output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9A-Fa-f:]+)\s*$/gm),
    (match) => normalizeSha256(match[1]!),
  );

/** The `SHA-256:` fingerprint the personal Android skill records for the signing key. */
export const readRecordedSha256 = (skill: string): string | undefined => {
  const recorded = Array.from(skill.matchAll(/^SHA-256: ([0-9A-Fa-f:]+)\s*$/gm), (match) =>
    normalizeSha256(match[1]!),
  );
  return recorded.length === 1 ? recorded[0] : undefined;
};

export class AndroidIdentityError extends Schema.TaggedError<AndroidIdentityError>()(
  "AndroidIdentityError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The APK is not the release's personal Android app: ${this.problems.join(" ")}`;
  }
}

const checkSigner = (certs: string, skill: string): string | undefined => {
  const recorded = readRecordedSha256(skill);
  if (recorded === undefined) {
    return "the personal Android skill does not record exactly one SHA-256 fingerprint.";
  }
  const signers = parseSignerSha256(certs);
  if (signers.length !== 1) return `apksigner reports ${signers.length} signers, not one.`;
  if (signers[0] !== recorded) {
    return `the signing certificate SHA-256 is ${signers[0]}, not the recorded ${recorded}.`;
  }
  return undefined;
};

const checkVersionCode = (versionCode: string | undefined, version: string) => {
  let expected: string;
  try {
    expected = String(androidVersionCode(version));
  } catch (error) {
    return { expected: undefined, problem: (error as Error).message };
  }
  return {
    expected,
    problem:
      versionCode === expected
        ? undefined
        : `versionCode is '${versionCode ?? "missing"}', not '${expected}' for ${version}.`,
  };
};

export const checkAndroidIdentity = (input: {
  readonly badging: string;
  readonly certs: string;
  readonly version: string;
  readonly skill: string;
}) =>
  Effect.gen(function* () {
    const badging = parseBadging(input.badging);
    const versionCode = checkVersionCode(badging.versionCode, input.version);
    const problems = [
      badging.packageName === PERSONAL_ANDROID_PACKAGE
        ? undefined
        : `the package is '${badging.packageName ?? "missing"}', not '${PERSONAL_ANDROID_PACKAGE}'.`,
      versionCode.problem,
      checkSigner(input.certs, input.skill),
    ].filter((problem): problem is string => problem !== undefined);
    if (problems.length > 0 || versionCode.expected === undefined) {
      return yield* new AndroidIdentityError({ problems });
    }
    return {
      packageName: PERSONAL_ANDROID_PACKAGE,
      versionCode: versionCode.expected,
      version: input.version,
    } as const;
  });

const command = Command.make(
  "fork-android-identity",
  {
    badging: Flag.String("badging").pipe(
      Flag.withDescription("Output of `aapt dump badging <apk>`."),
    ),
    certs: Flag.String("certs").pipe(
      Flag.withDescription("Output of `apksigner verify --print-certs <apk>`."),
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
    skill: Flag.String("skill").pipe(
      Flag.withDescription("The personal Android skill that records the signing fingerprint."),
      Flag.withDefault(DEFAULT_SKILL),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const identity = yield* checkAndroidIdentity({
        badging: yield* fs.readFileString(options.badging),
        certs: yield* fs.readFileString(options.certs),
        version: options.version,
        skill: yield* fs.readFileString(options.skill),
      });
      yield* Effect.log(
        `${identity.packageName} ${identity.version} (versionCode ${identity.versionCode}), signed by the recorded personal key: the release's APK.`,
      );
    }),
).pipe(
  Command.withDescription(
    "Check the fork personal Android APK's package, versionCode and signing certificate.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
