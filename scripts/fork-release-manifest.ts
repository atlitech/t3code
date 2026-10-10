#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes the SHA256SUMS and manifest.json that
// fork-server-release.yml publishes next to the assets its build jobs made:
// the Linux server archive, the Mac desktop DMG, and the personal Android APK.
// manifest.json's verificationScope says how far each asset was checked: the
// Linux archive is runtime-verified by the ADMISSION.json that admitted it,
// and the Mac and Android packages are build-checked but runtime-unverified.
// Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { REQUIRED_CHECKS, type AdmissionRecord } from "./linux-admission/admission-record.ts";
import { ADMISSION_FILE } from "./linux-admission/prior-release.ts";

export const SHA256SUMS_FILE = "SHA256SUMS";
export const MANIFEST_FILE = "manifest.json";

/** The owner decision that bounds what a fork release checks by running it. */
export const FORK_SCOPE_DECISION = {
  by: "owner",
  date: "2026-10-06",
  text: "Fork releases run only the Linux x64 server, in its admission; the Mac arm64 app and the Android arm64-v8a APK are checked as built and are not run.",
  runbook: "docs/operations/fork-server.md#verification-scope",
} as const;

/** A check a release job runs: the job id and step name in fork-server-release.yml. */
export interface ScopeCheck {
  readonly job: string;
  readonly step: string;
}

export interface PlatformScope {
  readonly platform: string;
  readonly arch: string;
  readonly runtimeVerified: boolean;
  readonly checks: ReadonlyArray<ScopeCheck>;
}

/**
 * Each platform's verification scope under FORK_SCOPE_DECISION. Linux x64 is
 * runtime-verified, and only the archive ADMISSION.json admits can be; the
 * Mac and Android packages are build-checked: their jobs inspect them but
 * never run them.
 */
export const FORK_VERIFICATION_SCOPE: ReadonlyArray<PlatformScope> = [
  {
    platform: "linux",
    arch: "x64",
    runtimeVerified: true,
    checks: [{ job: "admission", step: "Upgrade from the prior release and check the candidate" }],
  },
  {
    platform: "darwin",
    arch: "arm64",
    runtimeVerified: false,
    checks: [
      { job: "build-mac", step: "Check the app's bundle identifier, version, and signature" },
    ],
  },
  {
    platform: "android",
    arch: "arm64-v8a",
    runtimeVerified: false,
    checks: [
      { job: "build-android", step: "Check public config" },
      { job: "build-android", step: "Check APK identity" },
    ],
  },
];

export interface ReleaseAssetFile {
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
}

const ReleaseManifestAsset = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  file: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
});
export type ReleaseManifestAsset = typeof ReleaseManifestAsset.Type;

const VerificationScopeEntry = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  file: Schema.String,
  status: Schema.Literals(["runtime-verified", "build-checked"]),
  runtimeVerified: Schema.Boolean,
  checks: Schema.Array(Schema.Struct({ job: Schema.String, step: Schema.String })),
  // Only on the runtime-verified entry: the admission that verified it.
  admission: Schema.optionalKey(
    Schema.Struct({ record: Schema.String, version: Schema.String, archiveSha256: Schema.String }),
  ),
});
export type VerificationScopeEntry = typeof VerificationScopeEntry.Type;

const VerificationScope = Schema.Struct({
  decision: Schema.Struct({
    by: Schema.String,
    date: Schema.String,
    text: Schema.String,
    runbook: Schema.String,
  }),
  entries: Schema.Array(VerificationScopeEntry),
});
export type VerificationScope = typeof VerificationScope.Type;

const ReleaseManifest = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
  assets: Schema.Array(ReleaseManifestAsset),
  verificationScope: VerificationScope,
});
export type ReleaseManifest = typeof ReleaseManifest.Type;

const ReleaseManifestJson = Schema.fromJsonString(ReleaseManifest, { space: 2 });
const encodeManifestJson = Schema.encodeEffect(ReleaseManifestJson);
/** Decodes a published manifest.json; fails when verificationScope is missing. */
export const decodeReleaseManifestJson = Schema.decodeEffect(ReleaseManifestJson);

// admission-record.ts keeps its schema private. This decodes the same record,
// and the return type below stops compiling if the two drift apart.
const AdmissionRecordJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    archive: Schema.String,
    archiveSha256: Schema.String,
    priorVersion: Schema.String,
    priorSource: Schema.Literals(["admitted", "bootstrap"]),
    verifierCommit: Schema.String,
    checks: Schema.Array(
      Schema.Struct({ name: Schema.String, passed: Schema.Boolean, detail: Schema.String }),
    ),
  }),
);
const decodeAdmission = Schema.decodeEffect(AdmissionRecordJson);

export class ReleaseManifestError extends Schema.TaggedError<ReleaseManifestError>()(
  "ReleaseManifestError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot build the release manifest: ${this.detail}`;
  }
}

/** Decodes ADMISSION.json as admission-record.ts writes it. */
export const decodeAdmissionJson = (
  text: string,
): Effect.Effect<AdmissionRecord, ReleaseManifestError> =>
  decodeAdmission(text).pipe(
    Effect.mapError(
      (error) =>
        new ReleaseManifestError({
          detail: `${ADMISSION_FILE} is not an admission record: ${error.message}`,
        }),
    ),
  );

/**
 * Why `admission` does not admit `asset` as the archive of `version`, or
 * undefined when it does: same version, same file, same sha256, and every
 * required check recorded as passed.
 */
export const admissionMismatch = (
  admission: AdmissionRecord,
  version: string,
  asset: { readonly file: string; readonly sha256: string },
): string | undefined => {
  if (admission.version !== version) {
    return `${ADMISSION_FILE} is for version ${admission.version}, not ${version}.`;
  }
  if (admission.archive !== asset.file) {
    return `${ADMISSION_FILE} admits ${admission.archive}, not ${asset.file}.`;
  }
  if (admission.archiveSha256 !== asset.sha256) {
    return `${ADMISSION_FILE} admits ${asset.file} with sha256 ${admission.archiveSha256}, not ${asset.sha256}.`;
  }
  const unpassed = [
    ...REQUIRED_CHECKS.filter((name) => !admission.checks.some((check) => check.name === name)),
    ...admission.checks.filter((check) => !check.passed).map((check) => check.name),
  ];
  if (unpassed.length > 0) {
    return `${ADMISSION_FILE} does not record these checks as passed: ${unpassed.join(", ")}.`;
  }
  return undefined;
};

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PART_PATTERN = /^[a-z0-9_]+$/;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Reads platform and arch from a release asset's name. Only three shapes are
 * assets: the server archive `t3-<version>-<platform>-<arch>.tar.gz`, the Mac
 * desktop DMG `T3-Code-<version>-arm64.dmg`, and the personal Android APK
 * `T3-Code-<version>-android-arm64-v8a.apk`.
 */
export const parseAssetName = (
  version: string,
  file: string,
): { readonly platform: string; readonly arch: string } | undefined => {
  if (file === `T3-Code-${version}-arm64.dmg`) return { platform: "darwin", arch: "arm64" };
  if (file === `T3-Code-${version}-android-arm64-v8a.apk`) {
    return { platform: "android", arch: "arm64-v8a" };
  }
  const prefix = `t3-${version}-`;
  const suffix = ".tar.gz";
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) return undefined;
  const parts = file.slice(prefix.length, -suffix.length).split("-");
  if (parts.length !== 2) return undefined;
  const [platform, arch] = parts as [string, string];
  if (!PART_PATTERN.test(platform) || !PART_PATTERN.test(arch)) return undefined;
  return { platform, arch };
};

/**
 * Builds manifest.json and SHA256SUMS, refusing a release whose evidence does
 * not support its scope: every platform in `scope` needs exactly one asset,
 * and a platform is runtime-verified exactly when `admission` admits its
 * asset. `scope` is the committed FORK_VERIFICATION_SCOPE unless a test hands
 * in another.
 */
export const buildReleaseManifest = (input: {
  readonly commit: string;
  readonly version: string;
  readonly files: ReadonlyArray<ReleaseAssetFile>;
  readonly admission: AdmissionRecord | undefined;
  readonly scope?: ReadonlyArray<PlatformScope>;
}) =>
  Effect.gen(function* () {
    if (!COMMIT_PATTERN.test(input.commit)) {
      return yield* new ReleaseManifestError({
        detail: `commit must be a full SHA; got '${input.commit}'.`,
      });
    }
    if (input.files.length === 0) {
      return yield* new ReleaseManifestError({ detail: "there are no release assets." });
    }
    const assets: Array<ReleaseManifestAsset> = [];
    for (const asset of input.files.toSorted((left, right) =>
      left.file.localeCompare(right.file),
    )) {
      const parsed = parseAssetName(input.version, asset.file);
      if (!parsed) {
        return yield* new ReleaseManifestError({
          detail: `'${asset.file}' is not named t3-${input.version}-<platform>-<arch>.tar.gz, T3-Code-${input.version}-arm64.dmg, or T3-Code-${input.version}-android-arm64-v8a.apk.`,
        });
      }
      if (!SHA256_PATTERN.test(asset.sha256)) {
        return yield* new ReleaseManifestError({
          detail: `'${asset.file}' has a malformed sha256.`,
        });
      }
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
        return yield* new ReleaseManifestError({ detail: `'${asset.file}' is empty.` });
      }
      if (
        assets.some(
          (existing) => existing.platform === parsed.platform && existing.arch === parsed.arch,
        )
      ) {
        return yield* new ReleaseManifestError({
          detail: `more than one asset for ${parsed.platform}-${parsed.arch}.`,
        });
      }
      assets.push({ ...parsed, file: asset.file, size: asset.size, sha256: asset.sha256 });
    }
    const verificationScope = yield* buildVerificationScope({
      version: input.version,
      assets,
      admission: input.admission,
      scope: input.scope ?? FORK_VERIFICATION_SCOPE,
    });
    const manifest: ReleaseManifest = {
      commit: input.commit,
      version: input.version,
      assets,
      verificationScope,
    };
    const manifestJson = yield* encodeManifestJson(manifest).pipe(
      Effect.mapError(() => new ReleaseManifestError({ detail: "the manifest does not encode." })),
    );
    return {
      manifest,
      manifestJson: `${manifestJson}\n`,
      // sha256sum's text-mode format, so `sha256sum -c SHA256SUMS` verifies it.
      sha256sums: assets.map((asset) => `${asset.sha256}  ${asset.file}\n`).join(""),
    };
  });

const buildVerificationScope = (input: {
  readonly version: string;
  readonly assets: ReadonlyArray<ReleaseManifestAsset>;
  readonly admission: AdmissionRecord | undefined;
  readonly scope: ReadonlyArray<PlatformScope>;
}) =>
  Effect.gen(function* () {
    const refuse = (detail: string) => Effect.fail(new ReleaseManifestError({ detail }));
    const { admission } = input;
    if (admission === undefined) {
      return yield* refuse(
        `there is no ${ADMISSION_FILE}; without it no asset is runtime-verified.`,
      );
    }
    if (!input.assets.some((asset) => asset.file === admission.archive)) {
      return yield* refuse(
        `${ADMISSION_FILE} admits ${admission.archive}, which is not a release asset.`,
      );
    }
    for (const platform of input.scope) {
      if (
        !input.assets.some(
          (asset) => asset.platform === platform.platform && asset.arch === platform.arch,
        )
      ) {
        return yield* refuse(`the release has no ${platform.platform} ${platform.arch} asset.`);
      }
    }
    const entries: Array<VerificationScopeEntry> = [];
    for (const asset of input.assets) {
      const scope = input.scope.find(
        (platform) => platform.platform === asset.platform && platform.arch === asset.arch,
      );
      if (!scope) {
        return yield* refuse(`${asset.platform} ${asset.arch} has no verification scope.`);
      }
      if (scope.checks.length === 0) {
        return yield* refuse(`the ${asset.platform} ${asset.arch} scope names no check.`);
      }
      const base = {
        platform: asset.platform,
        arch: asset.arch,
        file: asset.file,
        checks: scope.checks.map(({ job, step }) => ({ job, step })),
      };
      if (!scope.runtimeVerified) {
        if (asset.file === admission.archive) {
          return yield* refuse(
            `${ADMISSION_FILE} admits ${asset.file}, but its ${asset.platform} ${asset.arch} scope says build-checked.`,
          );
        }
        entries.push({ ...base, status: "build-checked", runtimeVerified: false });
        continue;
      }
      const mismatch = admissionMismatch(admission, input.version, asset);
      if (mismatch !== undefined) {
        return yield* refuse(
          `${asset.platform} ${asset.arch} is marked runtime-verified, but ${mismatch}`,
        );
      }
      entries.push({
        ...base,
        status: "runtime-verified",
        runtimeVerified: true,
        admission: {
          record: ADMISSION_FILE,
          version: admission.version,
          archiveSha256: admission.archiveSha256,
        },
      });
    }
    return { decision: { ...FORK_SCOPE_DECISION }, entries } satisfies VerificationScope;
  });

export const writeReleaseManifest = Effect.fn("writeReleaseManifest")(function* (options: {
  readonly dir: string;
  readonly commit: string;
  readonly version: string;
  readonly admission: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const admission = yield* fs.readFileString(options.admission).pipe(
    Effect.mapError(
      () => new ReleaseManifestError({ detail: `cannot read ${options.admission}.` }),
    ),
    Effect.flatMap(decodeAdmissionJson),
  );
  // ADMISSION.json is published beside the assets, but it is evidence about
  // them, not an asset: SHA256SUMS and the manifest's assets never list it.
  const names = (yield* fs.readDirectory(options.dir))
    .filter((name) => name !== SHA256SUMS_FILE && name !== MANIFEST_FILE && name !== ADMISSION_FILE)
    .toSorted();
  const files = yield* Effect.forEach(names, (file) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(path.join(options.dir, file));
      const digest = yield* crypto.digest("SHA-256", bytes);
      return { file, size: bytes.length, sha256: toHex(digest) };
    }),
  );

  const release = yield* buildReleaseManifest({
    commit: options.commit,
    version: options.version,
    files,
    admission,
  });
  yield* fs.writeFileString(path.join(options.dir, SHA256SUMS_FILE), release.sha256sums);
  yield* fs.writeFileString(path.join(options.dir, MANIFEST_FILE), release.manifestJson);
  yield* Effect.log(release.sha256sums.trimEnd());
});

const command = Command.make(
  "fork-release-manifest",
  {
    dir: Flag.String("dir").pipe(Flag.withDescription("Directory holding the release assets.")),
    commit: Flag.String("commit").pipe(Flag.withDescription("Commit the assets were built from.")),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
    admission: Flag.String("admission").pipe(
      Flag.withDescription("The ADMISSION.json that admitted the Linux x64 archive."),
    ),
  },
  (options) => writeReleaseManifest(options),
).pipe(Command.withDescription("Write SHA256SUMS and manifest.json for a fork release."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
