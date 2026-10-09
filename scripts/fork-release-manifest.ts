#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes the SHA256SUMS and manifest.json that
// fork-server-release.yml publishes next to the assets its build jobs made:
// the Linux server archive, the Mac desktop DMG, and the personal Android APK.
// Runbook: docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

export const SHA256SUMS_FILE = "SHA256SUMS";
export const MANIFEST_FILE = "manifest.json";

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

const ReleaseManifest = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
  assets: Schema.Array(ReleaseManifestAsset),
});
export type ReleaseManifest = typeof ReleaseManifest.Type;

const encodeManifestJson = Schema.encodeEffect(
  Schema.fromJsonString(ReleaseManifest, { space: 2 }),
);

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

export const buildReleaseManifest = (input: {
  readonly commit: string;
  readonly version: string;
  readonly files: ReadonlyArray<ReleaseAssetFile>;
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
    const manifest: ReleaseManifest = { commit: input.commit, version: input.version, assets };
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

export const writeReleaseManifest = Effect.fn("writeReleaseManifest")(function* (options: {
  readonly dir: string;
  readonly commit: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const names = (yield* fs.readDirectory(options.dir))
    .filter((name) => name !== SHA256SUMS_FILE && name !== MANIFEST_FILE)
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
  },
  (options) => writeReleaseManifest(options),
).pipe(Command.withDescription("Write SHA256SUMS and manifest.json for a fork release."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
