import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ADMITTED_ARCHIVE_MISMATCH_STEP,
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
} from "./pinnedRuntime.ts";

// Every install fetches the release archive, checks it against SHA256SUMS,
// and unpacks it with tar. The fake client serves both files; the fake runner
// stands in for tar and drops the executable where extraction would.
const version = "1.2.3";
const archiveName = `t3-${version}-linux-x64.tar.gz`;
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveHex = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const validChecksums = archiveHex(archiveBytes).pipe(
  Effect.map((hex) => `${hex}  ${archiveName}\n`),
);
const releaseHttpClient = (checksums: string, requests: string[] = []) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const body = request.url.endsWith("/SHA256SUMS") ? checksums : archiveBytes;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
const extractingRunner = (fs: FileSystem.FileSystem, path: Path.Path, commands: string[] = []) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        const targetIndex = input.args.indexOf("-C");
        const stagingDir = input.args[targetIndex + 1];
        if (input.command !== "tar" || stagingDir === undefined) {
          return yield* Effect.die(`unexpected command ${input.command}`);
        }
        yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

// The real filesystem with every rename recorded and routed through `onRename`
// first, so a test can fail or hold one specific move of a runtime swap.
const renameHookedFs = (
  fs: FileSystem.FileSystem,
  renames: Array<readonly [string, string]>,
  onRename: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError>,
): FileSystem.FileSystem => ({
  ...fs,
  rename: (from, to) =>
    Effect.sync(() => renames.push([from, to])).pipe(
      Effect.andThen(onRename(from, to)),
      Effect.andThen(fs.rename(from, to)),
    ),
});
const renameRefused = (from: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: from,
    }),
  );

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("installs the verified release archive as the runtime executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
      const requests: string[] = [];
      const commands: string[] = [];
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        releaseBaseUrl: "https://releases.example/download",
        runner: extractingRunner(fs, path, commands),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));
      assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
      assert.deepEqual(requests, [
        `https://releases.example/download/v${version}/SHA256SUMS`,
        `https://releases.example/download/v${version}/${archiveName}`,
      ]);
      assert.deepEqual(commands, ["tar"]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.equal(
        yield* fs.readFileString(path.join(paths.versionDir, ".archive-sha256")),
        `${yield* archiveHex(archiveBytes)}\n`,
      );
      assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
    }),
  );

  // A complete runtime already on disk, optionally recording the archive digest
  // it was unpacked from. Its executable is marked so a reinstall is visible.
  const seedCachedRuntime = (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    baseDir: string,
    recordedDigest: string | undefined,
  ) =>
    Effect.gen(function* () {
      const paths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "cached\n");
      yield* fs.writeFileString(paths.sentinelPath, `${version}\n`);
      if (recordedDigest !== undefined) {
        yield* fs.writeFileString(
          path.join(paths.versionDir, ".archive-sha256"),
          `${recordedDigest}\n`,
        );
      }
      return paths;
    });

  it.effect.each([
    ["the admitted digest", true],
    ["no digest, for an official version", false],
  ] as const)("reuses a cached runtime that records %s", ([, admitted]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-cached-" });
      const digest = yield* archiveHex(archiveBytes);
      const finalPaths = yield* seedCachedRuntime(
        fs,
        path,
        baseDir,
        admitted ? digest.toUpperCase() : undefined,
      );
      const requests: string[] = [];
      const progress: PinnedRuntimeProgress[] = [];
      const validated: string[] = [];

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        admittedArchiveSha256: admitted ? digest : undefined,
        runner: extractingRunner(fs, path),
        validate: (paths) => Effect.sync(() => validated.push(paths.versionDir)),
        onProgress: (event) => progress.push(event),
      });

      assert.deepEqual(installed, finalPaths);
      assert.deepEqual(requests, []);
      assert.deepEqual(progress, [{ stage: "cached" }]);
      assert.deepEqual(validated, [finalPaths.versionDir]);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "cached\n");
    }),
  );

  it.effect.each([
    ["records no digest", undefined],
    ["records another digest", "0".repeat(64)],
  ] as const)(
    "reinstalls from the admitted archive when the cached runtime %s",
    ([, recordedDigest]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-unadmitted-" });
        const digest = yield* archiveHex(archiveBytes);
        const finalPaths = yield* seedCachedRuntime(fs, path, baseDir, recordedDigest);
        const requests: string[] = [];
        const validated: string[] = [];
        const renames: Array<readonly [string, string]> = [];

        const installed = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs: renameHookedFs(fs, renames, () => Effect.void),
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums, requests),
          releaseBaseUrl: "https://releases.example/download",
          admittedArchiveSha256: digest,
          runner: extractingRunner(fs, path),
          validate: (paths) => Effect.sync(() => validated.push(paths.versionDir)),
        });

        assert.deepEqual(installed, finalPaths);
        assert.deepEqual(requests, [
          `https://releases.example/download/v${version}/SHA256SUMS`,
          `https://releases.example/download/v${version}/${archiveName}`,
        ]);
        // Only the freshly unpacked staging tree was validated, never the cache.
        assert.lengthOf(validated, 1);
        assert.notEqual(validated[0], finalPaths.versionDir);
        assert.equal(yield* fs.readFileString(finalPaths.entryPath), "#!/bin/sh\n");
        assert.equal(
          yield* fs.readFileString(path.join(finalPaths.versionDir, ".archive-sha256")),
          `${digest}\n`,
        );
        // The cached runtime was set aside and the staged one published in its
        // place; the set-aside tree is then removed, and no staging tree remains.
        const stagingDir = validated[0]!;
        assert.deepEqual(renames, [
          [finalPaths.versionDir, `${stagingDir}-replaced`],
          [stagingDir, finalPaths.versionDir],
        ]);
        assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), [version]);
      }),
  );

  // Reads every file of a runtime tree, so a test can prove it is untouched.
  const snapshotTree = (fs: FileSystem.FileSystem, path: Path.Path, dir: string) =>
    Effect.gen(function* () {
      const entries = (yield* fs.readDirectory(dir, { recursive: true })).toSorted();
      const files: Array<readonly [string, string]> = [];
      for (const entry of entries) {
        const info = yield* fs.stat(path.join(dir, entry));
        if (info.type === "File") {
          files.push([entry, yield* fs.readFileString(path.join(dir, entry))]);
        }
      }
      return files;
    });

  it.effect.each([
    ["records no digest", "the admitted digest mismatches", undefined, "mismatch"],
    ["records no digest", "validation fails", undefined, "validate"],
    ["records another digest", "the admitted digest mismatches", "0".repeat(64), "mismatch"],
    ["records another digest", "validation fails", "0".repeat(64), "validate"],
  ] as const)(
    "keeps a complete cached runtime that %s intact when its replacement fails because %s",
    ([, , recordedDigest, failure]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-keep-cached-" });
        const finalPaths = yield* seedCachedRuntime(fs, path, baseDir, recordedDigest);
        yield* fs.writeFileString(path.join(finalPaths.versionDir, "native.node"), "native\n");
        const before = yield* snapshotTree(fs, path, finalPaths.versionDir);
        const validated: string[] = [];

        const error = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums),
          admittedArchiveSha256:
            failure === "mismatch" ? "1".repeat(64) : yield* archiveHex(archiveBytes),
          runner: extractingRunner(fs, path),
          validate: (paths) =>
            Effect.sync(() => validated.push(paths.versionDir)).pipe(
              Effect.andThen(
                Effect.fail(new PinnedRuntimeInstallError({ step: "validating the runtime" })),
              ),
            ),
        }).pipe(Effect.flip);

        assert.instanceOf(error, PinnedRuntimeInstallError);
        if (failure === "mismatch") {
          assert.equal(error.step, ADMITTED_ARCHIVE_MISMATCH_STEP);
          assert.deepEqual(validated, []);
        } else {
          assert.equal(error.step, "validating the runtime");
          // Only the staged replacement was validated, never the cached runtime.
          assert.lengthOf(validated, 1);
          assert.notEqual(validated[0], finalPaths.versionDir);
        }
        assert.deepEqual(yield* snapshotTree(fs, path, finalPaths.versionDir), before);
        assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), [version]);
      }),
  );

  // The swap itself: a validated replacement for an unadmitted cached runtime
  // whose renames fail after (publish) or before (set aside) the cache moves.
  it.effect.each([
    ["publishing the replacement", "publish", "publishing the pinned runtime"],
    ["setting the cached runtime aside", "aside", "setting aside the unadmitted pinned runtime"],
  ] as const)(
    "restores the cached runtime when %s fails during the swap",
    ([, failing, expectedStep]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-swap-fail-" });
        const finalPaths = yield* seedCachedRuntime(fs, path, baseDir, undefined);
        yield* fs.writeFileString(path.join(finalPaths.versionDir, "native.node"), "native\n");
        const before = yield* snapshotTree(fs, path, finalPaths.versionDir);
        const validated: string[] = [];
        const renames: Array<readonly [string, string]> = [];
        const isPublish = (from: string, to: string) =>
          to === finalPaths.versionDir &&
          path.basename(from).startsWith(".staging-") &&
          !from.endsWith("-replaced");
        const isAside = (from: string, to: string) =>
          from === finalPaths.versionDir && to.endsWith("-replaced");

        const error = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs: renameHookedFs(fs, renames, (from, to) =>
            (failing === "publish" ? isPublish(from, to) : isAside(from, to))
              ? renameRefused(from)
              : Effect.void,
          ),
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums),
          admittedArchiveSha256: yield* archiveHex(archiveBytes),
          runner: extractingRunner(fs, path),
          validate: (paths) => Effect.sync(() => validated.push(paths.versionDir)),
        }).pipe(Effect.flip);

        assert.instanceOf(error, PinnedRuntimeInstallError);
        assert.equal(error.step, expectedStep);
        assert.lengthOf(validated, 1);
        const stagingDir = validated[0]!;
        const asideDir = `${stagingDir}-replaced`;
        assert.deepEqual(
          renames,
          failing === "publish"
            ? [
                [finalPaths.versionDir, asideDir],
                [stagingDir, finalPaths.versionDir],
                [asideDir, finalPaths.versionDir],
              ]
            : [[finalPaths.versionDir, asideDir]],
        );
        // The cached runtime is back in place byte for byte, and neither the
        // staged replacement nor a set-aside tree is left behind.
        assert.deepEqual(yield* snapshotTree(fs, path, finalPaths.versionDir), before);
        assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), [version]);
      }),
  );

  it.effect("finishes the swap it is interrupted in, leaving the complete replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-swap-interrupt-" });
      const finalPaths = yield* seedCachedRuntime(fs, path, baseDir, undefined);
      const digest = yield* archiveHex(archiveBytes);
      const publishing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const renames: Array<readonly [string, string]> = [];

      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs: renameHookedFs(fs, renames, (from, to) =>
          to === finalPaths.versionDir &&
          path.basename(from).startsWith(".staging-") &&
          !from.endsWith("-replaced")
            ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        admittedArchiveSha256: digest,
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      // The cached runtime is set aside and the publish is held; the interrupt
      // is requested (synchronously, by starting the interrupter immediately)
      // before the publish is allowed to finish.
      yield* Deferred.await(publishing);
      const interrupter = yield* Fiber.interrupt(install).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.await(install);
      yield* Fiber.join(interrupter);

      assert.isTrue(Exit.hasInterrupts(exit));
      // The swap ran to completion: the admitted runtime is in place, complete,
      // and the set-aside and staging trees are gone.
      assert.lengthOf(renames, 2);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "#!/bin/sh\n");
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
      assert.equal(
        yield* fs.readFileString(path.join(finalPaths.versionDir, ".archive-sha256")),
        `${digest}\n`,
      );
      assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), [version]);
    }),
  );

  it.effect(
    "refuses, and does not switch to, a cached runtime the admitted archive does not match",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-unadmitted-" });
        yield* seedCachedRuntime(fs, path, baseDir, yield* archiveHex(archiveBytes));

        const error = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums),
          admittedArchiveSha256: "1".repeat(64),
          runner: extractingRunner(fs, path),
          validate: () => Effect.die("must not validate an unadmitted runtime"),
        }).pipe(Effect.flip);

        assert.instanceOf(error, PinnedRuntimeInstallError);
        assert.equal(error.step, ADMITTED_ARCHIVE_MISMATCH_STEP);
      }),
  );

  it.effect.each([true, false])(
    "reports bytes before completion, then verifies and extracts (known size: %s)",
    (knownSize) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-" });
        const firstChunk = yield* Deferred.make<void>();
        let archiveController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const checksums = yield* validChecksums;
        const progress: PinnedRuntimeProgress[] = [];
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/SHA256SUMS")
                ? new Response(checksums)
                : new Response(
                    new ReadableStream({
                      start(controller) {
                        archiveController = controller;
                        controller.enqueue(archiveBytes.slice(0, 4));
                      },
                    }),
                    { headers: knownSize ? { "content-length": String(archiveBytes.length) } : {} },
                  ),
            ),
          ),
        );
        const install = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
          onProgress: (event) => {
            progress.push(event);
            if (event.stage === "download" && event.received === 4) {
              Deferred.doneUnsafe(firstChunk, Effect.void);
            }
          },
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstChunk);
        assert.deepEqual(progress.at(-1), {
          stage: "download",
          received: 4,
          total: knownSize ? archiveBytes.length : undefined,
        });
        assert.isFalse(progress.some((event) => event.stage === "extract"));
        assert.isDefined(archiveController);
        archiveController!.enqueue(archiveBytes.slice(4));
        archiveController!.close();
        const installed = yield* Fiber.join(install);
        assert.deepEqual(progress.slice(-4), [
          { stage: "download", received: archiveBytes.length, total: archiveBytes.length },
          { stage: "verify" },
          { stage: "extract" },
          { stage: "validate" },
        ]);
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
      }),
  );

  it.effect("cleans up an interrupted download without reporting verification or extraction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-failed-" });
      const checksums = yield* validChecksums;
      const progress: PinnedRuntimeProgress[] = [];
      let cancelled = false;
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/SHA256SUMS")
              ? new Response(checksums)
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(archiveBytes.slice(0, 4));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
          ),
        ),
      );
      const firstChunk = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: client,
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate an interrupted archive"),
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "download" && event.received === 4)
            Deferred.doneUnsafe(firstChunk, Effect.void);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(install);
      assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
      assert.isTrue(progress.every((event) => event.stage === "download"));
      assert.isTrue(cancelled);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("refuses an archive whose checksum does not match the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-bad-" });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(`${"0".repeat(64)}  ${archiveName}\n`),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unverified archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, "verifying the t3 release archive checksum");
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("refuses a release-verified archive that is not the admitted one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-pinned-archive-unadmitted-",
      });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        admittedArchiveSha256: "0".repeat(64),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unadmitted archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, ADMITTED_ARCHIVE_MISMATCH_STEP);
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);

      let validations = 0;
      const requests: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        runner: extractingRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.deepEqual(requests, []);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});
