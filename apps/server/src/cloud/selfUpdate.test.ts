// @effect-diagnostics nodeBuiltinImport:off - tests seed a real SQLite database and read it back.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ThreadId } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_RESTART_PENDING_FILE } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  /** The version the staged runtime reports; the update target in each test. */
  readonly version?: string;
  /** ADMISSION.json per release version; a missing entry is a 404. */
  readonly admission?: Readonly<Record<string, string>>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  /** An existing T3 home to update; a fresh one without a database by default. */
  readonly baseDir?: string;
  /** Called before every rename the update makes, so a test can observe or fail one. */
  readonly onRename?: (
    from: string,
    to: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

// The staged runtime is a release archive: the fake client serves SHA256SUMS,
// ADMISSION.json, and the tarball, and the fake runner stands in for tar
// before it answers the staged preflight.
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveSha256 = Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes)).pipe(
  Effect.map((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  ),
);
const admissionRecord = (version: string, sha256: string) =>
  JSON.stringify(
    { version, archive: `t3-${version}-linux-x64.tar.gz`, archiveSha256: sha256, checks: [] },
    null,
    2,
  );
const releaseHttpClient = (order: string[], admission: Readonly<Record<string, string>> = {}) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const version = /\/v([^/]+)\/[^/]+$/.exec(request.url)?.[1] ?? "";
      if (request.url.endsWith("/SHA256SUMS")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${yield* archiveSha256}  t3-${version}-linux-x64.tar.gz\n`),
        );
      }
      if (request.url.endsWith("/ADMISSION.json")) {
        order.push("admission");
        const record = admission[version];
        return HttpClientResponse.fromWeb(
          request,
          record === undefined ? new Response("Not Found", { status: 404 }) : new Response(record),
        );
      }
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" }));
  const order: string[] = [];
  const onRename = options.onRename;
  const updateFs: FileSystem.FileSystem =
    onRename === undefined
      ? fs
      : {
          ...fs,
          rename: (from, to) =>
            onRename(from, to).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.andThen(fs.rename(from, to)),
            ),
        };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
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
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? {
                status: "blocked",
                version: options.version ?? "1.1.0",
                reason: "local update required",
              }
            : {
                status: "ready",
                version: options.version ?? "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          stdout: JSON.stringify(result),
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
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, releaseHttpClient(order, options.admission)),
    Effect.provideService(FileSystem.FileSystem, updateFs),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return { selfUpdate, order, baseDir, dbPath: config.dbPath };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("reports a failed continuation-marker cleanup", () =>
    Effect.gen(function* () {
      const updateError = new ServerSelfUpdateError({ reason: "update failed" });
      const clearError = new ServerSelfUpdateError({ reason: "marker cleanup failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(Effect.andThen(Effect.fail(updateError))),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.succeed([ThreadId.make("thread-cleanup-failure")]),
        clear: () => Effect.fail(clearError),
      });

      expect(
        yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: true })
          .pipe(Effect.flip),
      ).toBe(clearError);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("keeps continuation markers after the desktop handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "accepted-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(Effect.andThen(Effect.interrupt)),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-desktop-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate
        .commitDesktopUpdate("accepted-desktop-token")
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("installs a fork version whose admission record names the archive", () =>
    Effect.gen(function* () {
      const version = "0.0.47-atli.1";
      const { selfUpdate, order } = yield* makeHarness({
        version,
        admission: { [version]: admissionRecord(version, yield* archiveSha256) },
      });
      expect((yield* selfUpdate.update({ targetVersion: version })).targetVersion).toBe(version);
      expect(order).toEqual(["admission", "download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect.each([
    ["no admission record", "0.0.47-atli.1", undefined, "has no admission record"],
    // The owner override is `t3 update`'s alone; in-app updates never skip admission.
    ["a pre-admission version", "0.0.46-atli.2", undefined, "has no admission record"],
    [
      "a record for another archive digest",
      "0.0.47-atli.1",
      "0".repeat(64),
      "is not the archive its admission record admitted",
    ],
  ] as const)("refuses a fork version with %s before downloading it", ([, version, sha, reason]) =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        version,
        admission: sha === undefined ? {} : { [version]: admissionRecord(version, sha) },
      });
      const error = yield* selfUpdate.update({ targetVersion: version }).pipe(Effect.flip);
      expect(error.reason).toContain(reason);
      expect(order).toEqual(["admission"]);
    }),
  );

  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      // The launcher staging path must not run on the desktop path.
      expect(order).toEqual([]);
    }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "local update required",
      );
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );
});

const fileSha256 = (filePath: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
// The in-app update runs inside the service's server, so the running version is this build's.
const SERVICE_VERSION = packageJson.version;
const SERVICE_ARCHIVE_SHA256 = "cd".repeat(32);
const SERVICE_STATE = `${JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: SERVICE_VERSION })}\n`;

/**
 * A T3 home with a database (or bytes that are not one), the runtime it runs
 * now, the service state naming it when `serviceState` is set, and a
 * database an earlier recover set aside. `restartPendingVersion` models a
 * `t3 update` that installed that version with its restart deferred: the
 * service state already names it while the server keeps running the old one.
 */
const makeHomeWithDatabase = Effect.fn("test.make_self_update_home")(function* (options: {
  readonly serviceState: boolean;
  readonly database?: "sqlite" | "garbage";
  readonly restartPendingVersion?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-home-" });
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  if (options.database === "garbage") {
    yield* fs.writeFileString(dbPath, "this is not a SQLite database\n".repeat(64));
  } else {
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database.exec("create table notes (value text); insert into notes values ('kept');");
    database.close();
  }
  const fromVersion = SERVICE_VERSION;
  const fromRuntime = path.join(baseDir, "runtime", "versions", fromVersion);
  yield* fs.makeDirectory(fromRuntime, { recursive: true });
  yield* fs.writeFileString(path.join(fromRuntime, "t3"), "#!/bin/sh\n");
  const serviceStatePath = path.join(baseDir, "runtime", "service-state.json");
  if (options.serviceState) {
    yield* fs.writeFileString(
      path.join(fromRuntime, ".archive-sha256"),
      `${SERVICE_ARCHIVE_SHA256}\n`,
    );
    yield* fs.writeFileString(
      serviceStatePath,
      options.restartPendingVersion === undefined
        ? SERVICE_STATE
        : `${JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: options.restartPendingVersion })}\n`,
    );
    if (options.restartPendingVersion !== undefined) {
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE),
        `${options.restartPendingVersion}\n`,
      );
    }
  }
  const displacedPath = path.join(
    baseDir,
    "recovery/displaced/19700101T000000000Z-earlier/statev2.sqlite",
  );
  yield* fs.makeDirectory(path.dirname(displacedPath), { recursive: true });
  yield* fs.writeFileString(displacedPath, "an earlier database\n");
  return {
    baseDir,
    dbPath,
    fromVersion,
    fromRuntime,
    serviceStatePath,
    displacedPath,
    pointsDir: path.join(baseDir, "recovery", "points"),
  };
});

it.layer(NodeServices.layer)("server self update recovery point", (it) => {
  it.effect.each([
    ["the running version with a service state", true],
    ["the running version without a service state", false],
  ] as const)("keeps one recovery point from %s before publishing", ([, serviceState]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ serviceState });
      const targetDir = path.join(home.baseDir, "runtime", "versions", "1.1.0");
      const pointsAtPublish: string[][] = [];
      const { selfUpdate, order, dbPath } = yield* makeHarness({
        baseDir: home.baseDir,
        onRename: (_from, to) =>
          to === targetDir
            ? fs
                .readDirectory(home.pointsDir)
                .pipe(Effect.map((names) => void pointsAtPublish.push(names)))
            : Effect.void,
      });
      expect(dbPath).toBe(home.dbPath);

      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      const points = yield* fs.readDirectory(home.pointsDir);
      expect(points).toEqual([`19700101T000000000Z-${home.fromVersion}-to-1.1.0`]);
      // The point was already in place when the new runtime was published.
      expect(pointsAtPublish).toEqual([points]);
      const pointDir = path.join(home.pointsDir, points[0] ?? "");
      expect((yield* fs.readDirectory(pointDir)).toSorted()).toEqual([
        "recovery.json",
        "statev2.sqlite",
      ]);
      const snapshotPath = path.join(pointDir, "statev2.sqlite");
      const record: unknown = JSON.parse(
        yield* fs.readFileString(path.join(pointDir, "recovery.json")),
      );
      expect(record).toEqual({
        id: points[0],
        createdAt: "1970-01-01T00:00:00.000Z",
        from: {
          version: home.fromVersion,
          runtimePath: home.fromRuntime,
          archiveSha256: serviceState ? SERVICE_ARCHIVE_SHA256 : null,
        },
        to: { version: "1.1.0" },
        snapshot: { size: NodeFS.statSync(snapshotPath).size, sha256: fileSha256(snapshotPath) },
        actions: [],
      });
    }),
  );

  it.effect(
    "keeps a point from the running version while a deferred restart already names the target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHomeWithDatabase({
          serviceState: true,
          restartPendingVersion: "1.1.0",
        });
        const { selfUpdate } = yield* makeHarness({ baseDir: home.baseDir });

        yield* selfUpdate.update({ targetVersion: "1.1.0" });
        const points = yield* fs.readDirectory(home.pointsDir);
        expect(points).toEqual([`19700101T000000000Z-${SERVICE_VERSION}-to-1.1.0`]);
        const record: { readonly from: unknown } = JSON.parse(
          yield* fs.readFileString(path.join(home.pointsDir, points[0] ?? "", "recovery.json")),
        );
        expect(record.from).toEqual({
          version: SERVICE_VERSION,
          runtimePath: home.fromRuntime,
          archiveSha256: SERVICE_ARCHIVE_SHA256,
        });
      }),
  );

  it.effect("keeps a single point when a concurrent publish makes validation run twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ serviceState: true });
      const targetDir = path.join(home.baseDir, "runtime", "versions", "1.1.0");
      const { selfUpdate, order } = yield* makeHarness({
        baseDir: home.baseDir,
        // Another update publishes the same version first, so this one
        // validates the published runtime again instead of its own.
        onRename: (from, to) =>
          to === targetDir
            ? Effect.gen(function* () {
                yield* fs.makeDirectory(targetDir, { recursive: true });
                yield* fs.writeFileString(path.join(targetDir, "t3"), "#!/bin/sh\n");
                yield* fs.writeFileString(path.join(targetDir, ".install-complete"), "1.1.0\n");
                return yield* PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: from,
                });
              })
            : Effect.void,
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0" });
      expect(order).toEqual(["download", "extract", "preflight", "preflight", "accept"]);
      expect(yield* fs.readDirectory(home.pointsDir)).toHaveLength(1);
    }),
  );

  it.effect("prunes only the oldest point on the fourth update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ serviceState: true });
      const versions = ["1.1.0", "1.1.1", "1.1.2", "1.1.3"];
      for (const version of versions) {
        // A prepared update hands the server over, so each one is a fresh server.
        const { selfUpdate } = yield* makeHarness({ baseDir: home.baseDir, version });
        yield* selfUpdate.update({ targetVersion: version });
        yield* TestClock.adjust(Duration.seconds(1));
      }

      expect((yield* fs.readDirectory(home.pointsDir)).toSorted()).toEqual([
        `19700101T000001000Z-${SERVICE_VERSION}-to-1.1.1`,
        `19700101T000002000Z-${SERVICE_VERSION}-to-1.1.2`,
        `19700101T000003000Z-${SERVICE_VERSION}-to-1.1.3`,
      ]);
      expect(
        (yield* fs.readDirectory(path.join(home.baseDir, "runtime", "versions"))).toSorted(),
      ).toEqual([SERVICE_VERSION, ...versions]);
      expect(yield* fs.readFileString(home.displacedPath)).toBe("an earlier database\n");
    }),
  );

  it.effect.each([
    ["the backup fails", "garbage"],
    ["the recovery directory cannot be written", "points-file"],
  ] as const)("refuses the update and changes nothing when %s", ([, failure]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({
        serviceState: true,
        database: failure === "garbage" ? "garbage" : "sqlite",
      });
      if (failure === "points-file") yield* fs.writeFileString(home.pointsDir, "not a directory\n");
      const databaseSha256 = fileSha256(home.dbPath);
      const { selfUpdate, order } = yield* makeHarness({ baseDir: home.baseDir });

      const error = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);

      expect(error.reason).toBe(
        "Not switching to t3@1.1.0: could not keep a recovery point of the database.",
      );
      // The preflight ran and the launcher was never asked to switch.
      expect(order).toEqual(["download", "extract", "preflight"]);
      expect(yield* fs.readDirectory(path.join(home.baseDir, "runtime", "versions"))).toEqual([
        SERVICE_VERSION,
      ]);
      expect(yield* fs.readFileString(home.serviceStatePath)).toBe(SERVICE_STATE);
      expect(fileSha256(home.dbPath)).toBe(databaseSha256);
      expect(yield* fs.readFileString(home.displacedPath)).toBe("an earlier database\n");
      if (failure === "points-file") {
        expect(yield* fs.readFileString(home.pointsDir)).toBe("not a directory\n");
      } else {
        expect(yield* fs.readDirectory(home.pointsDir)).toEqual([]);
      }
    }),
  );
});
