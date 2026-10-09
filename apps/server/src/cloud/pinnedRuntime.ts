import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";

/**
 * A pinned runtime is an exact t3 release archive unpacked into
 * <baseDir>/runtime/versions/<version>: the self-contained executable, the
 * web client, and the native packages beside it. The boot service points its
 * unit or launch agent at the executable, and server self-update installs the
 * target version here before switching over. The runtime never depends on a
 * Node or npm on the machine; the only npm involvement in T3 Code is the `t3`
 * package for people who prefer `npx t3` or `npm install -g t3`, and even a
 * CLI installed that way pins an archive when it sets up the service.
 */
const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// The sha256 of the verified archive a runtime was unpacked from, written
// beside the sentinel so an admitted install can prove which archive it is.
const PINNED_RUNTIME_ARCHIVE_DIGEST_FILE = ".archive-sha256";
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  /** The executable. Its existence is what marks a runtime as present. */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

/** The exact command that runs a pinned runtime. */
export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

export function pinnedRuntimeVersionsDir(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir), version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The install step that refuses an archive its admission record did not admit. */
export const ADMITTED_ARCHIVE_MISMATCH_STEP =
  "verifying the t3 release archive against its admission record";

export type PinnedRuntimeProgress =
  | { readonly stage: "download"; readonly received: number; readonly total: number | undefined }
  | { readonly stage: "verify" | "extract" | "validate" | "cached" };

/**
 * Installs the t3 release archive for `version` into the pinned runtime
 * directory unless a complete install is already there, and returns its
 * paths. The sentinel is written only after extraction and validation
 * succeed; checking the entry file alone is not enough, since tar writes the
 * executable before the last native package and a killed install leaves a
 * plausible-looking but broken tree behind. With an admitted archive digest, a
 * cached install also has to record that digest, or it is installed afresh.
 */

interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
  /**
   * The sha256 a release admission record names for this archive. When set, a
   * downloaded archive with any other digest is refused before it is unpacked.
   */
  readonly admittedArchiveSha256?: string | undefined;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

const fetchReleaseAsset = Effect.fn("cloud.pinned_runtime.fetch_release_asset")(function* (
  httpClient: HttpClient.HttpClient,
  url: string,
  step: string,
  onProgress?: (progress: PinnedRuntimeProgress) => void,
) {
  // The install lock is held for the whole transaction, so a stalled download
  // must fail rather than block every other caller.
  return yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(
      Effect.fn(function* (response) {
        if (onProgress === undefined) return new Uint8Array(yield* response.arrayBuffer);
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        let received = 0;
        onProgress({ stage: "download", received, total });
        const chunks = yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              received += chunk.byteLength;
              onProgress({ stage: "download", received, total });
            }),
          ),
          Stream.runCollect,
        );
        // A completed chunked response finally gives us its total size.
        if (total === undefined && received > 0) {
          onProgress({ stage: "download", received, total: received });
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }),
    ),
    Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })),
    Effect.timeoutOrElse({
      duration: PINNED_RUNTIME_INSTALL_TIMEOUT,
      orElse: () => Effect.fail(new PinnedRuntimeInstallError({ step: `${step} (timed out)` })),
    }),
  );
});

/**
 * Downloads the release archive for this platform, verifies it against the
 * release's checksum file, and unpacks it so the executable sits directly in
 * the staging directory. Only `tar` is required on the host; every supported
 * OS ships one that reads gzip and zip.
 */
const installFromArchive = Effect.fn("cloud.pinned_runtime.install_archive")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
) {
  const { fs, path } = input;
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  if (platformKey === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
    });
  }
  const httpClient = input.httpClient;
  const baseUrl = cliReleaseDownloadBaseUrl(input.version, input.releaseBaseUrl);
  const fileName = cliArchiveFileName(input.version, platformKey);

  input.onProgress?.({ stage: "download", received: 0, total: undefined });
  const checksums = parseChecksums(
    new TextDecoder().decode(
      yield* fetchReleaseAsset(
        httpClient,
        `${baseUrl}/${CLI_RELEASE_CHECKSUMS_FILE}`,
        "downloading the t3 release checksums",
      ),
    ),
  );
  const expected = checksums.get(fileName);
  if (expected === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `finding ${fileName} in the t3 release checksums`,
    });
  }
  const archive = yield* fetchReleaseAsset(
    httpClient,
    `${baseUrl}/${fileName}`,
    "downloading the t3 release archive",
    input.onProgress,
  );
  input.onProgress?.({ stage: "verify" });
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", archive),
    catch: (cause) =>
      new PinnedRuntimeInstallError({ step: "verifying the t3 release archive", cause }),
  });
  const archiveSha256 = Hex.encode(new Uint8Array(digest));
  if (archiveSha256 !== expected) {
    return yield* new PinnedRuntimeInstallError({
      step: "verifying the t3 release archive checksum",
    });
  }
  if (
    input.admittedArchiveSha256 !== undefined &&
    archiveSha256 !== input.admittedArchiveSha256.toLowerCase()
  ) {
    return yield* new PinnedRuntimeInstallError({
      step: ADMITTED_ARCHIVE_MISMATCH_STEP,
    });
  }

  const archivePath = path.join(stagingDir, PINNED_RUNTIME_ARCHIVE_FILE);
  yield* fs
    .writeFile(archivePath, archive)
    .pipe(
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "writing the t3 release archive", cause }),
      ),
    );
  input.onProgress?.({ stage: "extract" });
  const extractStep = "extracting the t3 release archive";
  // The archive wraps everything in one directory named after its stem;
  // strip it so the executable lands at <versionDir>/t3.
  yield* input.runner
    .run({
      command: cliArchiveTarCommand(input.platform, process.env),
      args: ["-xf", archivePath, "-C", stagingDir, "--strip-components=1"],
      timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
    })
    .pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: extractStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: extractStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );
  yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
  return archiveSha256;
});

/**
 * Whether `paths` holds a complete install of `version`. With an admitted
 * digest it must also record that it was unpacked from exactly that archive;
 * a runtime installed before admission, or from any other archive, is not the
 * admitted one however complete it looks.
 */
const isCompleteInstall = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly paths: PinnedRuntimePaths;
  readonly version: string;
  readonly admittedArchiveSha256?: string | undefined;
}) =>
  Effect.all([
    input.fs.exists(input.paths.entryPath),
    input.fs.readFileString(input.paths.sentinelPath).pipe(Effect.option),
    input.admittedArchiveSha256 === undefined
      ? Effect.succeed(Option.none<string>())
      : input.fs
          .readFileString(
            input.path.join(input.paths.versionDir, PINNED_RUNTIME_ARCHIVE_DIGEST_FILE),
          )
          .pipe(Effect.option),
  ]).pipe(
    Effect.map(
      ([entryExists, sentinel, recordedDigest]) =>
        entryExists &&
        Option.isSome(sentinel) &&
        sentinel.value.trim() === input.version &&
        (input.admittedArchiveSha256 === undefined ||
          (Option.isSome(recordedDigest) &&
            recordedDigest.value.trim().toLowerCase() ===
              input.admittedArchiveSha256.toLowerCase())),
    ),
  );

/**
 * Whether `version` is already installed and needs no download. Reading
 * nothing counts as not installed.
 */
export const isPinnedRuntimeInstalled = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly baseDir: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly admittedArchiveSha256?: string | undefined;
}): Effect.Effect<boolean> =>
  isCompleteInstall({
    ...input,
    paths: pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform),
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Swaps a validated staging tree in for a complete but unadmitted cached
 * runtime: the cached tree is moved aside, the staging tree is published, and
 * only then is the aside tree removed. If publishing fails, the cached tree is
 * moved back, so a failed replacement leaves it where it was. The swap is
 * uninterruptible so it never stops halfway with no runtime in place.
 */
const replaceCachedRuntime = (
  input: PinnedRuntimeInstallInput,
  versionDir: string,
  asideDir: string,
  publishStaging: Effect.Effect<boolean, PinnedRuntimeInstallError>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const { fs } = input;
      yield* fs.rename(versionDir, asideDir).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "setting aside the unadmitted pinned runtime",
              cause,
            }),
        ),
      );
      const published = yield* publishStaging.pipe(
        Effect.tapError(() => fs.rename(asideDir, versionDir).pipe(Effect.ignore)),
      );
      yield* fs.remove(asideDir, { recursive: true, force: true }).pipe(Effect.ignore);
      return published;
    }),
  );

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs } = input;
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform);
  const checkError = (cause: unknown) =>
    new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause });
  const [versionDirExists, alreadyPinned] = yield* Effect.all([
    fs.exists(paths.versionDir),
    isCompleteInstall({ ...input, paths }),
  ]).pipe(Effect.mapError(checkError));
  if (alreadyPinned) {
    input.onProgress?.({ stage: "cached" });
    yield* input.validate(paths);
    return paths;
  }
  // A complete runtime that cannot show it came from the admitted archive is
  // never switched to, but it stays in place until the admitted replacement
  // has been installed and validated, so a failed replacement loses nothing.
  // Only a genuinely incomplete tree is removed up front.
  const keepCached =
    versionDirExists &&
    input.admittedArchiveSha256 !== undefined &&
    (yield* isCompleteInstall({ ...input, paths, admittedArchiveSha256: undefined }).pipe(
      Effect.mapError(checkError),
    ));
  if (versionDirExists && !keepCached) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const archiveSha256 = yield* installFromArchive(input, stagingDir);

    input.onProgress?.({ stage: "validate" });
    yield* input.validate(stagingPaths);
    // Recorded before the sentinel, so a sentinel always has its digest beside it.
    yield* fs
      .writeFileString(
        input.path.join(stagingDir, PINNED_RUNTIME_ARCHIVE_DIGEST_FILE),
        `${archiveSha256}\n`,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the installed archive", cause }),
        ),
      );
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const publishStaging = fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        isCompleteInstall({ ...input, paths }).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap((publishedComplete) =>
            publishedComplete
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    const published = keepCached
      ? yield* replaceCachedRuntime(
          input,
          paths.versionDir,
          `${stagingDir}-replaced`,
          publishStaging,
        )
      : yield* publishStaging;
    if (!published) yield* input.validate(paths);
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));
