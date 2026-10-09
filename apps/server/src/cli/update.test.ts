// @effect-diagnostics nodeBuiltinImport:off - tests seed a real SQLite database and read it back.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLauncher, resolveLauncherPath, runUpdate } from "./update.ts";

afterEach(() => vi.restoreAllMocks());

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
const processOutput = (stdout: string, code = 0, stderr = "") => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// What a t3 CLI that has no `__service-preflight` prints, exit code 1: its
// root command reads the unknown name as its optional `cwd` argument and
// rejects the preflight flags (as captured from this repository's CLI).
const unknownPreflightStderr =
  "\n\u001b[1m\u001b[31mERROR\u001b[0m\n  Unrecognized flag: --database-path in command t3\u001b[0m\n  Unrecognized flag: --launcher-protocol in command t3\u001b[0m\n";
// The same CLI if its root took no argument: the framework names the command.
const unknownSubcommandStderr = '\nERROR\n  Unknown subcommand "__service-preflight" for "t3"\n';
const preflightFailures = {
  unknown: unknownPreflightStderr,
  "unknown-subcommand": unknownSubcommandStderr,
  // A release that knows the command but crashes running it.
  failed: "\nERROR\n  Error: SQLITE_CORRUPT: database disk image is malformed\n",
} as const;

/**
 * Runs `t3 update <version>` against a fake release (ADMISSION.json served
 * only when `admission` is given) and a fake staged runtime that answers
 * `--version` and the update preflight. No background service is installed
 * unless `service` names the version one serving this home runs.
 */
const runFakeUpdate = Effect.fn("test.run_fake_update")(function* (options: {
  readonly version: string;
  readonly admission?: { readonly archiveSha256: string } | undefined;
  /**
   * "unknown" and "unknown-subcommand" are releases from before the update
   * preflight existed; "failed" is one whose preflight exits non-zero.
   */
  readonly preflight?: "ready" | "blocked" | keyof typeof preflightFailures;
  /**
   * Seeds a complete runtime for the version before updating, recording this
   * archive digest, or none when null.
   */
  readonly cachedDigest?: string | null;
  readonly allowUnadmitted?: boolean;
  readonly allowDowngrade?: boolean;
  /** An existing T3 home to update; a fresh one without a database by default. */
  readonly baseDir?: string;
  /** A background service serving this home on this version. */
  readonly service?: {
    readonly version: string;
    readonly problems?: BootService.BootServiceStatus["problems"];
  };
  /** Contents served for these paths instead of the disk, such as a `/proc` file. */
  readonly files?: Readonly<Record<string, string>>;
  /** Runs `t3` as an executable started through this launcher symlink. */
  readonly launcherPath?: string;
  /** Called before every rename the update makes, so a test can observe or fail one. */
  readonly onRename?: (
    from: string,
    to: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-run-" }));
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  const versionDir = path.join(baseDir, "runtime", "versions", options.version);
  if (options.cachedDigest !== undefined) {
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(path.join(versionDir, "t3"), "cached\n");
    yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${options.version}\n`);
    if (options.cachedDigest !== null) {
      yield* fs.writeFileString(
        path.join(versionDir, ".archive-sha256"),
        `${options.cachedDigest}\n`,
      );
    }
  }
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
        if (
          options.preflight !== undefined &&
          options.preflight !== "ready" &&
          options.preflight !== "blocked"
        ) {
          return processOutput("", 1, preflightFailures[options.preflight]);
        }
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
  // The service switch builds its own BootService for the target version.
  const serviceCalls: string[] = [];
  const bootService = BootService.BootService.of({
    install: (installOptions) =>
      Effect.sync(() => {
        serviceCalls.push(`install start=${installOptions?.start}`);
        return { program: [], baseDir, logPath: "", unitPath: "" };
      }),
    restart: Effect.die("unexpected service restart"),
    stop: Effect.die("unexpected service stop"),
    uninstall: Effect.die("unexpected service uninstall"),
    status: Effect.succeed(
      options.service === undefined
        ? { supported: false, installed: false, current: false, unitPath: "", logPath: "" }
        : {
            supported: true,
            installed: true,
            current: false,
            installedVersion: options.service.version,
            installedBaseDir: baseDir,
            problems: options.service.problems ?? [],
            unitPath: "",
            logPath: "",
          },
    ),
  });
  vi.spyOn(BootService, "layer").mockReturnValue(
    Layer.succeed(BootService.BootService, bootService),
  );
  const onRename = options.onRename;
  const files = options.files ?? {};
  const updateFs: FileSystem.FileSystem = {
    ...fs,
    readFileString: (filePath, encoding) =>
      files[filePath] === undefined
        ? fs.readFileString(filePath, encoding)
        : Effect.succeed(files[filePath]),
    rename: (from, to) =>
      onRename === undefined
        ? fs.rename(from, to)
        : onRename(from, to).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.andThen(fs.rename(from, to)),
          ),
  };
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
    Effect.provideService(FileSystem.FileSystem, updateFs),
    Effect.provideService(HostProcessIsExecutable, options.launcherPath !== undefined),
    Effect.provideService(HostProcessInvokedAs, options.launcherPath ?? "t3"),
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
  const recordedDigest = yield* fs
    .readFileString(path.join(versionDir, ".archive-sha256"))
    .pipe(Effect.option);
  const entry = yield* fs.readFileString(path.join(versionDir, "t3")).pipe(Effect.option);
  return {
    exit,
    requests,
    commands,
    warnings,
    published,
    baseDir,
    dbPath,
    recordedDigest,
    entry,
    serviceCalls,
  };
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

  it.effect.each(["unknown", "unknown-subcommand"] as const)(
    "tolerates a rollback target that does not know the preflight (%s), and logs it",
    (preflight) =>
      Effect.gen(function* () {
        const rollback = yield* runFakeUpdate({
          version: "0.0.44",
          preflight,
          allowDowngrade: true,
        });
        assert.equal(rollback.exit._tag, "Success");
        assert.deepEqual(rollback.published, ["0.0.44"]);
        assert.isTrue(
          rollback.warnings.some((message) => String(message).includes("no update preflight")),
        );
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("refuses a rollback whose preflight fails for any other reason", () =>
    Effect.gen(function* () {
      for (const preflight of ["failed", "blocked"] as const) {
        const rollback = yield* runFakeUpdate({
          version: "0.0.44",
          preflight,
          allowDowngrade: true,
        });
        assert.equal(rollback.exit._tag, "Failure", preflight);
        assert.deepEqual(rollback.published, [], preflight);
        assert.deepEqual(rollback.warnings, [], preflight);
      }
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each(["unknown", "unknown-subcommand", "failed"] as const)(
    "refuses an upgrade whose preflight does not answer (%s)",
    (preflight) =>
      Effect.gen(function* () {
        const upgrade = yield* runFakeUpdate({ version: "0.0.47", preflight });
        assert.equal(upgrade.exit._tag, "Failure");
        assert.deepEqual(upgrade.published, []);
        assert.deepEqual(upgrade.warnings, []);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("switches to a cached fork runtime that records the admitted digest", () =>
    Effect.gen(function* () {
      const digest = yield* archiveSha256;
      const run = yield* runFakeUpdate({
        version: "0.0.47-atli.1",
        admission: { archiveSha256: digest },
        cachedDigest: digest,
      });
      assert.equal(run.exit._tag, "Success");
      assert.isFalse(run.requests.some((url) => url.endsWith(".tar.gz")));
      assert.isFalse(run.commands.some(([command]) => command === "tar"));
      assert.deepEqual(Option.getOrUndefined(run.entry), "cached\n");
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    ["no digest", null],
    ["another digest", "0".repeat(64)],
  ] as const)(
    "reinstalls a cached fork runtime that records %s from the admitted archive",
    ([, cachedDigest]) =>
      Effect.gen(function* () {
        const digest = yield* archiveSha256;
        const run = yield* runFakeUpdate({
          version: "0.0.47-atli.1",
          admission: { archiveSha256: digest },
          cachedDigest,
        });
        assert.equal(run.exit._tag, "Success");
        assert.isTrue(run.requests.some((url) => url.endsWith("/SHA256SUMS")));
        assert.isTrue(run.requests.some((url) => url.endsWith(".tar.gz")));
        assert.deepEqual(Option.getOrUndefined(run.entry), "#!/bin/sh\n");
        assert.deepEqual(Option.getOrUndefined(run.recordedDigest), `${digest}\n`);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
});

const fileSha256 = (filePath: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
const SERVICE_VERSION = "0.0.46";
const SERVICE_ARCHIVE_SHA256 = "ab".repeat(32);
const DISPLACED_FILE = "recovery/displaced/19700101T000000000Z-earlier/statev2.sqlite";

/**
 * A T3 home with a database (or bytes that are not one), the runtime it runs
 * now behind a launcher symlink, and a database an earlier recover set aside.
 */
const makeHomeWithDatabase = Effect.fn("test.make_update_home_with_database")(function* (options: {
  readonly fromVersion: string;
  readonly fromArchiveSha256?: string | undefined;
  readonly database?: "sqlite" | "garbage";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-home-" });
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  if (options.database === "garbage") {
    yield* fs.writeFileString(dbPath, "this is not a SQLite database\n".repeat(64));
  } else {
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database.exec("create table notes (value text); insert into notes values ('kept');");
    database.close();
  }
  const fromRuntime = path.join(baseDir, "runtime", "versions", options.fromVersion);
  yield* fs.makeDirectory(fromRuntime, { recursive: true });
  yield* fs.writeFileString(path.join(fromRuntime, "t3"), "#!/bin/sh\n");
  if (options.fromArchiveSha256 !== undefined) {
    yield* fs.writeFileString(
      path.join(fromRuntime, ".archive-sha256"),
      `${options.fromArchiveSha256}\n`,
    );
  }
  const launcherPath = path.join(baseDir, "bin", "t3");
  yield* fs.makeDirectory(path.dirname(launcherPath), { recursive: true });
  yield* fs.symlink(path.join(fromRuntime, "t3"), launcherPath);
  const displacedPath = path.join(baseDir, DISPLACED_FILE);
  yield* fs.makeDirectory(path.dirname(displacedPath), { recursive: true });
  yield* fs.writeFileString(displacedPath, "an earlier database\n");
  return { baseDir, dbPath, fromRuntime, launcherPath, displacedPath };
});

const pointsDirOf = (path: Path.Path, baseDir: string) => path.join(baseDir, "recovery", "points");

it.layer(NodeServices.layer)("t3 update recovery point", (it) => {
  it.effect.each([
    ["the version the service serving this home runs", true],
    ["the running version when no service serves this home", false],
  ] as const)("keeps one recovery point from %s before publishing", ([, withService]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fromVersion = withService ? SERVICE_VERSION : packageJson.version;
      const fromArchiveSha256 = withService ? SERVICE_ARCHIVE_SHA256 : undefined;
      const home = yield* makeHomeWithDatabase({ fromVersion, fromArchiveSha256 });
      const targetDir = path.join(home.baseDir, "runtime", "versions", "0.0.47");
      const pointsAtPublish: string[][] = [];

      const run = yield* runFakeUpdate({
        version: "0.0.47",
        baseDir: home.baseDir,
        launcherPath: home.launcherPath,
        ...(withService ? { service: { version: SERVICE_VERSION } } : {}),
        onRename: (_from, to) =>
          to === targetDir
            ? fs
                .readDirectory(pointsDirOf(path, home.baseDir))
                .pipe(Effect.map((names) => void pointsAtPublish.push(names)))
            : Effect.void,
      });

      assert.equal(run.exit._tag, "Success");
      const points = yield* fs.readDirectory(pointsDirOf(path, home.baseDir));
      assert.lengthOf(points, 1);
      const [id] = points;
      assert.match(id ?? "", new RegExp(`^19700101T000000000Z-${fromVersion}-to-0\\.0\\.47$`));
      // The point was already in place when the new runtime was published.
      assert.deepEqual(pointsAtPublish, [points]);
      const pointDir = path.join(pointsDirOf(path, home.baseDir), id ?? "");
      assert.deepEqual((yield* fs.readDirectory(pointDir)).toSorted(), [
        "recovery.json",
        "statev2.sqlite",
      ]);
      const record: unknown = JSON.parse(
        yield* fs.readFileString(path.join(pointDir, "recovery.json")),
      );
      const snapshotPath = path.join(pointDir, "statev2.sqlite");
      assert.deepEqual(record, {
        id,
        createdAt: "1970-01-01T00:00:00.000Z",
        from: {
          version: fromVersion,
          runtimePath: home.fromRuntime,
          archiveSha256: fromArchiveSha256 ?? null,
        },
        to: { version: "0.0.47" },
        snapshot: {
          size: NodeFS.statSync(snapshotPath).size,
          sha256: fileSha256(snapshotPath),
        },
        actions: [],
      });
      const snapshot = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true });
      try {
        assert.deepEqual(
          snapshot
            .prepare("select value from notes")
            .all()
            .map((row) => row["value"]),
          ["kept"],
        );
      } finally {
        snapshot.close();
      }
      assert.isTrue(
        (yield* TestConsole.logLines).some((line) =>
          String(line).includes(`Kept recovery point ${id} (${pointDir})`),
        ),
      );
      assert.equal(yield* fs.readLink(home.launcherPath), path.join(targetDir, "t3"));
      assert.deepEqual(run.serviceCalls, withService ? ["install start=true"] : []);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "keeps a point from the live server's version while a deferred restart already names the target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // An earlier update moved t3 and the service's state to this build and
        // declined the restart, so the service still runs the version before.
        const runningVersion = "0.0.44";
        const home = yield* makeHomeWithDatabase({
          fromVersion: runningVersion,
          fromArchiveSha256: SERVICE_ARCHIVE_SHA256,
        });
        yield* fs.writeFileString(
          path.join(home.baseDir, "server-runtime.json"),
          JSON.stringify({
            version: 1,
            // A pid that is certainly alive: this test's own process.
            pid: process.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "1970-01-01T00:00:00.000Z",
            serviceManaged: true,
          }),
        );

        const run = yield* runFakeUpdate({
          version: packageJson.version,
          baseDir: home.baseDir,
          service: { version: packageJson.version, problems: ["restart-pending"] },
          files: {
            [`/proc/${process.pid}/cmdline`]: `${path.join(home.fromRuntime, "t3")}\0serve\0`,
          },
        });

        assert.equal(run.exit._tag, "Success", failureReason(run.exit));
        const points = yield* fs.readDirectory(pointsDirOf(path, home.baseDir));
        assert.deepEqual(points, [
          `19700101T000000000Z-${runningVersion}-to-${packageJson.version}`,
        ]);
        const record: { readonly from: unknown } = JSON.parse(
          yield* fs.readFileString(
            path.join(pointsDirOf(path, home.baseDir), points[0] ?? "", "recovery.json"),
          ),
        );
        assert.deepEqual(record.from, {
          version: runningVersion,
          runtimePath: home.fromRuntime,
          archiveSha256: SERVICE_ARCHIVE_SHA256,
        });
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("keeps a single point when a concurrent publish makes validation run twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ fromVersion: packageJson.version });
      const targetDir = path.join(home.baseDir, "runtime", "versions", "0.0.47");

      const run = yield* runFakeUpdate({
        version: "0.0.47",
        baseDir: home.baseDir,
        // Another update publishes the same version first, so this one
        // validates the published runtime again instead of its own.
        onRename: (from, to) =>
          to === targetDir
            ? Effect.gen(function* () {
                yield* fs.makeDirectory(targetDir, { recursive: true });
                yield* fs.writeFileString(path.join(targetDir, "t3"), "#!/bin/sh\n");
                yield* fs.writeFileString(path.join(targetDir, ".install-complete"), "0.0.47\n");
                return yield* PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: from,
                });
              })
            : Effect.void,
      });

      assert.equal(run.exit._tag, "Success");
      assert.lengthOf(
        run.commands.filter((command) => command.includes("__service-preflight")),
        2,
      );
      assert.lengthOf(yield* fs.readDirectory(pointsDirOf(path, home.baseDir)), 1);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("keeps a point when switching to a cached runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ fromVersion: packageJson.version });
      const digest = yield* archiveSha256;

      const run = yield* runFakeUpdate({
        version: "0.0.47-atli.1",
        admission: { archiveSha256: digest },
        cachedDigest: digest,
        baseDir: home.baseDir,
      });

      assert.equal(run.exit._tag, "Success");
      assert.isFalse(run.commands.some(([command]) => command === "tar"));
      assert.deepEqual(yield* fs.readDirectory(pointsDirOf(path, home.baseDir)), [
        `19700101T000000000Z-${packageJson.version}-to-0.0.47-atli.1`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("prunes only the oldest point on the fourth update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({ fromVersion: packageJson.version });
      const versions = ["0.0.47", "0.0.48", "0.0.49", "0.0.50"];
      for (const version of versions) {
        const run = yield* runFakeUpdate({ version, baseDir: home.baseDir });
        assert.equal(run.exit._tag, "Success", version);
        yield* TestClock.adjust(Duration.seconds(1));
      }

      assert.deepEqual((yield* fs.readDirectory(pointsDirOf(path, home.baseDir))).toSorted(), [
        `19700101T000001000Z-${packageJson.version}-to-0.0.48`,
        `19700101T000002000Z-${packageJson.version}-to-0.0.49`,
        `19700101T000003000Z-${packageJson.version}-to-0.0.50`,
      ]);
      assert.deepEqual(
        (yield* fs.readDirectory(path.join(home.baseDir, "runtime", "versions"))).toSorted(),
        [packageJson.version, ...versions].toSorted(),
      );
      assert.equal(yield* fs.readFileString(home.displacedPath), "an earlier database\n");
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    ["the backup fails", "garbage"],
    ["the recovery directory cannot be written", "points-file"],
  ] as const)("refuses the update and changes nothing when %s", ([, failure]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* makeHomeWithDatabase({
        fromVersion: SERVICE_VERSION,
        fromArchiveSha256: SERVICE_ARCHIVE_SHA256,
        database: failure === "garbage" ? "garbage" : "sqlite",
      });
      const pointsDir = pointsDirOf(path, home.baseDir);
      if (failure === "points-file") yield* fs.writeFileString(pointsDir, "not a directory\n");
      const databaseSha256 = fileSha256(home.dbPath);

      const run = yield* runFakeUpdate({
        version: "0.0.47",
        baseDir: home.baseDir,
        launcherPath: home.launcherPath,
        service: { version: SERVICE_VERSION },
      });

      assert.equal(run.exit._tag, "Failure");
      assert.include(
        failureReason(run.exit),
        "Not switching to t3@0.0.47: could not keep a recovery point of the database",
      );
      // The preflight ran, so the point was what refused the update.
      assert.isTrue(run.commands.some((command) => command.includes("__service-preflight")));
      assert.deepEqual(run.published, [SERVICE_VERSION]);
      assert.equal(yield* fs.readLink(home.launcherPath), path.join(home.fromRuntime, "t3"));
      assert.deepEqual(run.serviceCalls, []);
      assert.equal(fileSha256(home.dbPath), databaseSha256);
      assert.equal(yield* fs.readFileString(home.displacedPath), "an earlier database\n");
      if (failure === "points-file") {
        assert.equal(yield* fs.readFileString(pointsDir), "not a directory\n");
      } else {
        assert.deepEqual(yield* fs.readDirectory(pointsDir), []);
      }
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
});
