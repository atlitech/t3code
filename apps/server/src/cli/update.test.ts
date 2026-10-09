import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestConsole from "effect/testing/TestConsole";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import * as BootService from "../cloud/bootService.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLauncher, resolveLauncherPath, runUpdate } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      // Another install's versions tree: same shape, different home.
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "./bin/t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: "" }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcessInvokedAs, "t3"),
        Effect.provideService(HostProcessEnvironment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcessWorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcessPlatform, "linux")),
  );
});

const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveSha256 = Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes)).pipe(
  Effect.map((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  ),
);
const processOutput = (stdout: string, code = 0) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/**
 * Runs `t3 update <version>` against a fake release (ADMISSION.json served
 * only when `admission` is given) and a fake staged runtime that answers
 * `--version` and the update preflight. No background service is installed.
 */
const runFakeUpdate = Effect.fn("test.run_fake_update")(function* (options: {
  readonly version: string;
  readonly admission?: { readonly archiveSha256: string } | undefined;
  /** "unknown" is a release from before the update preflight existed. */
  readonly preflight?: "ready" | "blocked" | "unknown";
  readonly allowUnadmitted?: boolean;
  readonly allowDowngrade?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-run-" });
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  const requests: string[] = [];
  const commands: string[][] = [];
  const warnings: unknown[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push([input.command, ...input.args]);
        if (input.command === "tar") {
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return processOutput("");
        }
        if (input.args.includes("--version")) return processOutput(`t3 v${options.version}\n`);
        if (options.preflight === "unknown") return processOutput("", 1);
        return processOutput(
          JSON.stringify(
            options.preflight === "blocked"
              ? { status: "blocked", version: options.version, reason: "migration failed" }
              : {
                  status: "ready",
                  version: options.version,
                  launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                },
          ),
        );
      }),
  });
  const sha256 = yield* archiveSha256;
  const httpClient = HttpClient.make((request) => {
    requests.push(request.url);
    if (request.url.endsWith("/SHA256SUMS")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(`${sha256}  t3-${options.version}-linux-x64.tar.gz\n`),
        ),
      );
    }
    if (request.url.endsWith("/ADMISSION.json")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          options.admission === undefined
            ? new Response("Not Found", { status: 404 })
            : new Response(
                JSON.stringify({
                  version: options.version,
                  archive: `t3-${options.version}-linux-x64.tar.gz`,
                  archiveSha256: options.admission.archiveSha256,
                }),
              ),
        ),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(archiveBytes)));
  });
  const bootService = BootService.BootService.of({
    install: () => Effect.die("no service is installed"),
    restart: Effect.die("no service is installed"),
    uninstall: Effect.die("no service is installed"),
    status: Effect.succeed({
      supported: false,
      installed: false,
      current: false,
      unitPath: "",
      logPath: "",
    }),
  });
  const exit = yield* runUpdate({
    baseDir,
    logsDir: path.join(baseDir, "logs"),
    serverRuntimeStatePath: path.join(baseDir, "server-runtime.json"),
    dbPath,
    channel: undefined,
    requestedVersion: options.version,
    allowDowngrade: options.allowDowngrade ?? false,
    allowUnadmitted: options.allowUnadmitted ?? false,
    assumeYes: true,
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(BootService.BootService, bootService),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(HostProcessEnvironment, {
      T3CODE_RELEASE_BASE_URL: "https://releases.example/download",
    }),
    Effect.provide(
      Logger.layer(
        [Logger.make((entry) => (entry.logLevel === "Warn" ? warnings.push(entry.message) : 0))],
        { mergeWithExisting: false },
      ),
    ),
    Effect.exit,
  );
  const versionsDir = path.join(baseDir, "runtime", "versions");
  const published = (yield* fs.exists(versionsDir))
    ? (yield* fs.readDirectory(versionsDir)).filter((entry) => !entry.startsWith("."))
    : [];
  return { exit, requests, commands, warnings, published, dbPath };
});

const failureReason = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" ? String(exit.cause) : "";

it.layer(NodeServices.layer)("t3 update admission and preflight", (it) => {
  it.effect("installs an official version without asking for an admission record", () =>
    Effect.gen(function* () {
      const run = yield* runFakeUpdate({ version: "0.0.47" });
      assert.equal(run.exit._tag, "Success");
      assert.isFalse(run.requests.some((url) => url.endsWith("/ADMISSION.json")));
      assert.deepEqual(run.published, ["0.0.47"]);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("installs an admitted fork version after migrating a copy of the database", () =>
    Effect.gen(function* () {
      const run = yield* runFakeUpdate({
        version: "0.0.47-atli.1",
        admission: { archiveSha256: yield* archiveSha256 },
      });
      assert.equal(run.exit._tag, "Success");
      assert.deepEqual(run.published, ["0.0.47-atli.1"]);
      assert.isTrue(
        run.commands.some(
          (command) =>
            command.includes("__service-preflight") &&
            command[command.indexOf("--database-path") + 1] === run.dbPath,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    ["no admission record", undefined, "has no admission record"],
    [
      "a record for another digest",
      "0".repeat(64),
      "is not the archive its admission record admitted",
    ],
  ] as const)(
    "refuses an unadmitted fork version with %s and changes nothing",
    ([, digest, reason]) =>
      Effect.gen(function* () {
        const run = yield* runFakeUpdate({
          version: "0.0.47-atli.1",
          admission: digest === undefined ? undefined : { archiveSha256: digest },
          // Not a pre-admission version, so the owner override does not apply.
          allowUnadmitted: true,
        });
        assert.equal(run.exit._tag, "Failure");
        assert.include(failureReason(run.exit), reason);
        assert.include(failureReason(run.exit), "--allow-unadmitted applies only to");
        assert.deepEqual(run.commands, []);
        assert.deepEqual(run.published, []);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("refuses a pre-admission version without the owner override", () =>
    Effect.gen(function* () {
      const run = yield* runFakeUpdate({ version: "0.0.46-atli.2" });
      assert.include(failureReason(run.exit), "Pass --allow-unadmitted");
      assert.deepEqual(run.published, []);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("installs a pre-admission version on the owner override and logs it", () =>
    Effect.gen(function* () {
      const run = yield* runFakeUpdate({ version: "0.0.46-atli.2", allowUnadmitted: true });
      assert.equal(run.exit._tag, "Success");
      assert.deepEqual(run.published, ["0.0.46-atli.2"]);
      assert.isTrue(
        run.warnings.some((message) => String(message).includes("unadmitted pre-admission")),
      );
      assert.isTrue(
        (yield* TestConsole.logLines).some((line) =>
          String(line).includes("t3@0.0.46-atli.2 without admission (--allow-unadmitted)"),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("refuses a version whose preflight cannot migrate the database", () =>
    Effect.gen(function* () {
      const run = yield* runFakeUpdate({ version: "0.0.47", preflight: "blocked" });
      assert.include(failureReason(run.exit), "Not switching to t3@0.0.47: migration failed");
      assert.deepEqual(run.published, []);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("tolerates a missing preflight only when rolling back to an older release", () =>
    Effect.gen(function* () {
      const rollback = yield* runFakeUpdate({
        version: "0.0.44",
        preflight: "unknown",
        allowDowngrade: true,
      });
      assert.equal(rollback.exit._tag, "Success");
      assert.deepEqual(rollback.published, ["0.0.44"]);
      assert.isTrue(
        rollback.warnings.some((message) => String(message).includes("no update preflight")),
      );

      const upgrade = yield* runFakeUpdate({ version: "0.0.47", preflight: "unknown" });
      assert.equal(upgrade.exit._tag, "Failure");
      assert.deepEqual(upgrade.published, []);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
});
