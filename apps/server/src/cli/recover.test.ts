// @effect-diagnostics nodeBuiltinImport:off - tests build real SQLite databases.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import * as TestConsole from "effect/testing/TestConsole";
import {
  HostProcessEnvironment,
  HostProcessInvokedAs,
  HostProcessIsExecutable,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";

import * as BootService from "../cloud/bootService.ts";
import { createRecoveryPoint, verifySnapshot } from "../cloud/recoveryPoint.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { runRecover } from "./recover.ts";

const START = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T10:11:12.123Z"));
const POINT_ID = "20261009T101112123Z-1.2.3-to-1.2.4";
const FROM_DIGEST = "abcdef0123";

const NOTHING_CARRIED = "carried 0 revocations and 0 used pairing links from the current database";

const readRows = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("select value from notes order by value").all();
  } finally {
    database.close();
  }
};

const writeRuntime = Effect.fn("test.write_runtime")(function* (
  baseDir: string,
  version: string,
  digest: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionDir = path.join(baseDir, "runtime", "versions", version);
  yield* fs.makeDirectory(versionDir, { recursive: true });
  yield* fs.writeFileString(path.join(versionDir, "t3"), "#!/bin/sh\n");
  yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${version}\n`);
  if (digest !== null) {
    yield* fs.writeFileString(path.join(versionDir, ".archive-sha256"), `${digest}\n`);
  }
  return path.join(versionDir, "t3");
});

const execSql = (databasePath: string, statements: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(statements);
  } finally {
    database.close();
  }
};

const sessionRow = (id: string) =>
  `insert into auth_sessions (session_id, subject, scopes, method, issued_at, expires_at) values ('${id}', 'owner', '[]', 'browser-session-cookie', '2026-10-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z');`;

const readSessions = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare("select session_id, revoked_at from auth_sessions order by session_id")
      .all();
  } finally {
    database.close();
  }
};

/**
 * A T3 home that was updated from 1.2.3 to 1.2.4: a recovery point taken
 * from the database before the update, later work written to the live
 * database with its -wal and -shm, and a launcher that points at 1.2.4.
 * With `auth`, the database has the server's real schema, `auth.before`
 * runs before the point is kept and `auth.after` after it, and the live
 * database keeps only its own journal.
 */
const makeUpdatedHome = Effect.fn("test.make_updated_home")(function* (options?: {
  readonly fromDigest?: string | null;
  readonly auth?: { readonly before: string; readonly after: string };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recover-test-" });
  const baseDir = path.join(root, "home");
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  if (options?.auth !== undefined) {
    yield* Layer.build(SqlitePersistence.layerFromPath(dbPath)).pipe(Effect.scoped);
  }
  execSql(
    dbPath,
    `create table notes (value text); insert into notes values ('before'); ${options?.auth?.before ?? ""}`,
  );
  const fromEntry = yield* writeRuntime(
    baseDir,
    "1.2.3",
    options?.fromDigest === undefined ? FROM_DIGEST : options.fromDigest,
  );
  const toEntry = yield* writeRuntime(baseDir, "1.2.4", "fedcba9876");

  yield* TestClock.setTime(START);
  const point = Option.getOrThrow(
    yield* createRecoveryPoint({ baseDir, dbPath, fromVersion: "1.2.3", toVersion: "1.2.4" }),
  );

  execSql(dbPath, `insert into notes values ('after'); ${options?.auth?.after ?? ""}`);
  if (options?.auth === undefined) {
    yield* fs.writeFileString(`${dbPath}-wal`, "wal");
    yield* fs.writeFileString(`${dbPath}-shm`, "shm");
  }
  // Compared by bytes from here on: opening the database would rewrite its -shm.
  const liveBytes = yield* fs.readFile(dbPath);

  const launcher = path.join(root, "bin", "t3");
  yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
  yield* fs.symlink(toEntry, launcher);
  yield* TestClock.adjust(Duration.minutes(1));
  return { fs, path, root, baseDir, dbPath, liveBytes, point, fromEntry, toEntry, launcher };
});

type Home = Effect.Success<ReturnType<typeof makeUpdatedHome>>;

const homeStatus = (
  home: Home,
  service: "serves-this-home" | "serves-another-home" | "none",
): BootService.BootServiceStatus => ({
  supported: true,
  installed: service !== "none",
  current: true,
  ...(service === "none"
    ? {}
    : {
        installedBaseDir:
          service === "serves-this-home" ? home.baseDir : home.path.join(home.root, "other"),
      }),
  unitPath: "",
  logPath: "",
});

/**
 * Runs `t3 recover` against `home` with a recording service. `events` keeps
 * what the service was asked to do, in order; the stop records whether the
 * live database was still in place when the service stopped.
 */
const recover = Effect.fn("test.recover")(function* (
  home: Home,
  options: {
    readonly service: "serves-this-home" | "serves-another-home" | "none";
    readonly id?: string | undefined;
    readonly list?: boolean;
    readonly allowUnverifiedRuntime?: boolean;
    readonly stop?: Effect.Effect<boolean, BootService.BootServiceError>;
    /** Wraps the file system recover runs on, to make one write fail. */
    readonly fs?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
    /** Interrupts recover as soon as the service has stopped. */
    readonly interruptAfterStop?: boolean;
  },
) {
  const events: string[] = [];
  const stopped = yield* Deferred.make<void>();
  // The console's lines outlive one test, so only this run's are returned.
  const logsBefore = (yield* TestConsole.logLines).length;
  const errorsBefore = (yield* TestConsole.errorLines).length;
  const unexpected = (name: string) => Effect.die(`unexpected ${name}`);
  const service = BootService.BootService.of({
    install: () => unexpected("install on the running version's service"),
    restart: unexpected("restart on the running version's service"),
    stop: Effect.gen(function* () {
      events.push(
        `stop (database in place: ${yield* home.fs.exists(home.dbPath).pipe(Effect.orDie)})`,
      );
      const result = yield* options.stop ?? Effect.succeed(true);
      yield* Deferred.succeed(stopped, undefined);
      return result;
    }),
    uninstall: unexpected("uninstall"),
    status: Effect.succeed(homeStatus(home, options.service)),
  });
  const fromService = BootService.BootService.of({
    install: (installOptions) =>
      Effect.sync(() => {
        events.push(
          `install (allowDowngrade: ${installOptions?.allowDowngrade}, start: ${installOptions?.start})`,
        );
        return { program: [home.fromEntry], baseDir: home.baseDir, unitPath: "", logPath: "" };
      }),
    restart: Effect.sync(() => {
      events.push("restart");
      return true;
    }),
    stop: unexpected("stop on the prior version's service"),
    uninstall: unexpected("uninstall"),
    status: unexpected("status on the prior version's service"),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: () => Effect.die("recover runs no processes here"),
  });
  const program = runRecover({
    baseDir: home.baseDir,
    serverRuntimeStatePath: home.path.join(home.baseDir, "server-runtime.json"),
    dbPath: home.dbPath,
    list: options.list ?? false,
    id: "id" in options ? options.id : POINT_ID,
    allowUnverifiedRuntime: options.allowUnverifiedRuntime ?? false,
    serviceForVersion: (cliVersion) => {
      events.push(`service for ${cliVersion}`);
      return Layer.succeed(BootService.BootService, fromService);
    },
  }).pipe(
    Effect.provideService(BootService.BootService, service),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(FileSystem.FileSystem, options.fs?.(home.fs) ?? home.fs),
    // The prior version's service is stubbed, so nothing downloads.
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("recover downloads nothing here")),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessIsExecutable, true),
    Effect.provideService(HostProcessInvokedAs, home.launcher),
    Effect.provideService(HostProcessWorkingDirectory, home.root),
    Effect.provideService(HostProcessEnvironment, { PATH: "" }),
  );
  const exit = options.interruptAfterStop
    ? yield* Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program);
        yield* Deferred.await(stopped);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      })
    : yield* Effect.exit(program);
  const logs = (yield* TestConsole.logLines).slice(logsBefore);
  const errors = (yield* TestConsole.errorLines).slice(errorsBefore);
  return { exit, events, logs, errors };
});

const refusedBy = (method: string, pathOrDescriptor: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor,
    }),
  );

const failureReason = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" ? String(exit.cause) : "";

const readRecord = (home: Home) =>
  home.fs
    .readFileString(home.path.join(home.point.dir, "recovery.json"))
    .pipe(Effect.map((text): Record<string, unknown> => JSON.parse(text)));

// The restored database recover prepares beside the live one.
const preparedPath = (home: Home) =>
  home.path.join(home.path.dirname(home.dbPath), `.statev2.sqlite.recover-${POINT_ID}`);

const displacedDir = (home: Home) =>
  home.path.join(home.baseDir, "recovery", "displaced", `20261009T101212123Z-${POINT_ID}`);

/** The snapshot is in place at the database path and the live database is kept aside. */
const assertSwapped = Effect.fn("test.assert_swapped")(function* (home: Home) {
  const { fs, path } = home;
  assert.deepEqual(yield* fs.readFile(home.dbPath), yield* fs.readFile(home.point.snapshotPath));
  assert.deepEqual(readRows(home.dbPath), [{ value: "before" }]);
  assert.isFalse(yield* fs.exists(`${home.dbPath}-wal`));
  assert.isFalse(yield* fs.exists(`${home.dbPath}-shm`));
  const displaced = displacedDir(home);
  assert.deepEqual((yield* fs.readDirectory(displaced)).toSorted(), [
    "statev2.sqlite",
    "statev2.sqlite-shm",
    "statev2.sqlite-wal",
  ]);
  assert.deepEqual(yield* fs.readFile(path.join(displaced, "statev2.sqlite")), home.liveBytes);
  assert.equal(yield* fs.readFileString(path.join(displaced, "statev2.sqlite-wal")), "wal");
  assert.equal(yield* fs.readFileString(path.join(displaced, "statev2.sqlite-shm")), "shm");
  assert.equal(yield* fs.readLink(home.launcher), home.fromEntry);
});

/** Nothing moved: the live database, its journal, and the launcher are as the update left them. */
const assertUntouched = Effect.fn("test.assert_untouched")(function* (home: Home) {
  const { fs, path } = home;
  assert.deepEqual(yield* fs.readFile(home.dbPath), home.liveBytes);
  assert.equal(yield* fs.readFileString(`${home.dbPath}-wal`), "wal");
  assert.equal(yield* fs.readFileString(`${home.dbPath}-shm`), "shm");
  assert.isFalse(yield* fs.exists(path.join(home.baseDir, "recovery", "displaced")));
  assert.equal(yield* fs.readLink(home.launcher), home.toEntry);
});

it.layer(NodeServices.layer)("t3 recover", (it) => {
  it.effect("lists the recovery points newest first", () =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      // A later update's point, taken from its own copy so the live database is not opened.
      const copy = home.path.join(home.root, "copy.sqlite");
      yield* home.fs.copyFile(home.point.snapshotPath, copy);
      yield* createRecoveryPoint({
        baseDir: home.baseDir,
        dbPath: copy,
        fromVersion: "1.2.4",
        toVersion: "1.2.5",
      });
      const { exit, events } = yield* recover(home, {
        service: "serves-this-home",
        list: true,
        id: undefined,
      });
      assert.equal(exit._tag, "Success", failureReason(exit));
      assert.deepEqual(events, []);
      assert.deepEqual(yield* TestConsole.logLines, [
        "20261009T101212123Z-1.2.4-to-1.2.5  2026-10-09T10:12:12.123Z  1.2.4 -> 1.2.5  runtime digest recorded",
        `${POINT_ID}  2026-10-09T10:11:12.123Z  1.2.3 -> 1.2.4  runtime digest recorded`,
      ]);
      yield* assertUntouched(home);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("refuses without a recovery point id", () =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      const { exit, events } = yield* recover(home, {
        service: "serves-this-home",
        id: undefined,
      });
      assert.equal(exit._tag, "Failure");
      assert.include(failureReason(exit), "t3 recover --list");
      assert.deepEqual(events, []);
      yield* assertUntouched(home);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "stops this home's service before the swap, then points it at and restarts it on the prior runtime",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        const { exit, events, errors } = yield* recover(home, { service: "serves-this-home" });

        assert.equal(exit._tag, "Success", failureReason(exit));
        assert.deepEqual(events, [
          "stop (database in place: true)",
          "service for 1.2.3",
          "install (allowDowngrade: true, start: false)",
          "restart",
        ]);
        yield* assertSwapped(home);
        const record = yield* readRecord(home);
        const at = "2026-10-09T10:12:12.123Z";
        assert.deepEqual(record["actions"], [
          { at, action: "stopped the background service" },
          { at, action: `moved the current database to ${displacedDir(home)}` },
          { at, action: `restored the database from recovery point ${POINT_ID}` },
          { at, action: NOTHING_CARRIED },
          { at, action: `pointed the launcher ${home.launcher} at t3@1.2.3` },
          { at, action: "pointed the background service at t3@1.2.3" },
          { at, action: "restarted the background service on t3@1.2.3" },
        ]);
        assert.isUndefined(record["allowUnverifiedRuntime"]);
        const lines = yield* TestConsole.logLines;
        assert.include(lines, "  stopped the background service");
        assert.include(lines, "  restarted the background service on t3@1.2.3");
        assert.deepEqual(errors, []);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    {
      name: "a pending remote update",
      stop: Effect.fail(new BootService.BootServiceUpdatePendingError()),
      reason: "remote server update is still pending",
    },
    {
      name: "a service that stopped nothing",
      stop: Effect.succeed(false),
      reason: "could not be stopped",
    },
  ])("refuses when the service stop is refused by $name", ({ stop, reason }) =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      const { exit, events } = yield* recover(home, { service: "serves-this-home", stop });

      assert.equal(exit._tag, "Failure");
      assert.include(failureReason(exit), reason);
      assert.deepEqual(events, ["stop (database in place: true)"]);
      yield* assertUntouched(home);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("refuses before any move when a server is still alive after the service stop", () =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      yield* home.fs.writeFileString(
        home.path.join(home.baseDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          // A pid that is certainly alive: this test's own process.
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-09T10:00:00.000Z",
          serviceManaged: true,
        }),
      );
      const { exit, events } = yield* recover(home, { service: "serves-this-home" });

      assert.equal(exit._tag, "Failure");
      assert.include(failureReason(exit), `still running on this T3 home (pid ${process.pid})`);
      assert.deepEqual(events, ["stop (database in place: true)"]);
      yield* assertUntouched(home);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    { name: "no service installed", service: "none" },
    { name: "a service serving another home", service: "serves-another-home" },
  ] as const)("swaps the database and launcher only with $name", ({ service }) =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      const { exit, events } = yield* recover(home, { service });

      assert.equal(exit._tag, "Success", failureReason(exit));
      assert.deepEqual(events, []);
      yield* assertSwapped(home);
      const record = yield* readRecord(home);
      assert.deepEqual(
        (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
          (entry) => entry.action,
        ),
        [
          `moved the current database to ${displacedDir(home)}`,
          `restored the database from recovery point ${POINT_ID}`,
          NOTHING_CARRIED,
          `pointed the launcher ${home.launcher} at t3@1.2.3`,
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    { name: "a server started by hand", serviceManaged: false, reason: "started by hand" },
    {
      name: "a service-managed server with no unit for this home",
      serviceManaged: true,
      reason: "no background service for this home can stop it",
    },
  ])("refuses before any move while $name serves the home", ({ serviceManaged, reason }) =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      yield* home.fs.writeFileString(
        home.path.join(home.baseDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          // A pid that is certainly alive: this test's own process.
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-09T10:00:00.000Z",
          ...(serviceManaged ? { serviceManaged: true } : {}),
        }),
      );
      const { exit, events } = yield* recover(home, { service: "none" });

      assert.equal(exit._tag, "Failure");
      assert.include(failureReason(exit), reason);
      assert.deepEqual(events, []);
      yield* assertUntouched(home);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    { name: "a tampered snapshot", tamper: "snapshot", reason: "does not match the sha256" },
    { name: "a missing prior runtime", tamper: "missing-runtime", reason: "is missing from" },
    {
      name: "a prior runtime from another archive",
      tamper: "other-digest",
      reason: "archive sha256 differs",
    },
    {
      name: "an unverified prior runtime without the flag",
      tamper: "null-digest",
      reason: "--allow-unverified-runtime",
    },
    { name: "an unsafe id", tamper: "unsafe-id", reason: "is not a recovery point id" },
  ] as const)("refuses $name before any stop or move", ({ tamper, reason }) =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome({
        fromDigest: tamper === "null-digest" ? null : FROM_DIGEST,
      });
      const { fs, path } = home;
      const fromRuntime = path.dirname(home.fromEntry);
      if (tamper === "snapshot") {
        yield* fs.writeFileString(home.point.snapshotPath, "not the snapshot");
      } else if (tamper === "missing-runtime") {
        yield* fs.remove(fromRuntime, { recursive: true });
      } else if (tamper === "other-digest") {
        yield* fs.writeFileString(path.join(fromRuntime, ".archive-sha256"), "0123456789\n");
      }
      const recordBefore = yield* readRecord(home);
      const { exit, events } = yield* recover(home, {
        service: "serves-this-home",
        ...(tamper === "unsafe-id" ? { id: "../points" } : {}),
      });

      assert.equal(exit._tag, "Failure");
      assert.include(failureReason(exit), reason);
      assert.deepEqual(events, []);
      yield* assertUntouched(home);
      assert.deepEqual(yield* readRecord(home), recordBefore);
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("restores an unverified prior runtime with the flag and records it", () =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome({ fromDigest: null });
      const { exit, events } = yield* recover(home, {
        service: "serves-this-home",
        allowUnverifiedRuntime: true,
      });

      assert.equal(exit._tag, "Success", failureReason(exit));
      assert.equal(events[0], "stop (database in place: true)");
      yield* assertSwapped(home);
      const record = yield* readRecord(home);
      assert.isTrue(record["allowUnverifiedRuntime"]);
      const actions = record["actions"] as ReadonlyArray<{ readonly action: string }>;
      assert.equal(
        actions[0]?.action,
        "allowed the unverified runtime t3@1.2.3 (--allow-unverified-runtime)",
      );
      assert.include(
        yield* TestConsole.logLines,
        "  allowed the unverified runtime t3@1.2.3 (--allow-unverified-runtime)",
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "keeps a completed swap and finishes when recovery.json cannot be written after it",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        // Writes to recovery.json fail only once the snapshot is renamed into
        // place, so the record before the swap still lands.
        let swapped = false;
        const { exit, events, errors } = yield* recover(home, {
          service: "serves-this-home",
          fs: (fs) => ({
            ...fs,
            rename: (from, to) =>
              fs.rename(from, to).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (to === home.dbPath) swapped = true;
                  }),
                ),
              ),
            writeFileString: (filePath, data, writeOptions) =>
              swapped && home.path.basename(filePath) === ".recovery.json.tmp"
                ? refusedBy("writeFileString", filePath)
                : fs.writeFileString(filePath, data, writeOptions),
          }),
        });

        assert.equal(exit._tag, "Success", failureReason(exit));
        assert.isTrue(swapped);
        assert.deepEqual(events, [
          "stop (database in place: true)",
          "service for 1.2.3",
          "install (allowDowngrade: true, start: false)",
          "restart",
        ]);
        yield* assertSwapped(home);
        const record = yield* readRecord(home);
        assert.deepEqual(
          (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
            (entry) => entry.action,
          ),
          ["stopped the background service"],
        );
        const lines = yield* TestConsole.logLines;
        assert.include(lines, `  restored the database from recovery point ${POINT_ID}`);
        assert.include(lines, "Recovered to t3@1.2.3.");
        assert.lengthOf(errors, 6);
        for (const warning of errors) {
          assert.include(
            String(warning),
            `Warning: could not record this action in ${home.path.join(home.point.dir, "recovery.json")}`,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "moves the current database back and refuses when the snapshot cannot be restored",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        const { exit, events } = yield* recover(home, {
          service: "serves-this-home",
          fs: (fs) => ({
            ...fs,
            rename: (from, to) =>
              from === preparedPath(home) ? refusedBy("rename", from) : fs.rename(from, to),
          }),
        });

        assert.equal(exit._tag, "Failure");
        const reason = failureReason(exit);
        assert.include(reason, "Could not restore the recovery point's snapshot.");
        assert.include(reason, `The current database was moved back to ${home.dbPath}`);
        assert.include(reason, "run `t3 service restart` to start it again");
        assert.deepEqual(events, ["stop (database in place: true)"]);
        // The live database and its journal are back; the displaced directory
        // is left empty and the snapshot's temporary copy is gone.
        assert.deepEqual(yield* home.fs.readFile(home.dbPath), home.liveBytes);
        assert.equal(yield* home.fs.readFileString(`${home.dbPath}-wal`), "wal");
        assert.equal(yield* home.fs.readFileString(`${home.dbPath}-shm`), "shm");
        assert.deepEqual(yield* home.fs.readDirectory(displacedDir(home)), []);
        assert.deepEqual(
          (yield* home.fs.readDirectory(home.path.dirname(home.dbPath))).toSorted(),
          ["statev2.sqlite", "statev2.sqlite-shm", "statev2.sqlite-wal"],
        );
        assert.equal(yield* home.fs.readLink(home.launcher), home.toEntry);
        const record = yield* readRecord(home);
        assert.deepEqual(
          (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
            (entry) => entry.action,
          ),
          ["stopped the background service"],
        );
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "still points the service at and restarts it on the prior runtime when the launcher cannot be repointed",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        // The launcher is repointed through a temporary symlink next to it.
        const { exit, events, logs, errors } = yield* recover(home, {
          service: "serves-this-home",
          fs: (fs) => ({
            ...fs,
            symlink: (target, linkPath) =>
              linkPath.startsWith(`${home.launcher}.`)
                ? refusedBy("symlink", linkPath)
                : fs.symlink(target, linkPath),
          }),
        });

        assert.equal(exit._tag, "Failure");
        const reason = failureReason(exit);
        assert.include(reason, "The database and the background service are on t3@1.2.3");
        assert.include(reason, `Could not repoint the t3 launcher at ${home.launcher}.`);
        assert.include(reason, `Run ${home.fromEntry} to start t3@1.2.3.`);
        assert.deepEqual(events, [
          "stop (database in place: true)",
          "service for 1.2.3",
          "install (allowDowngrade: true, start: false)",
          "restart",
        ]);
        // The swap stands; only the launcher still names the newer runtime.
        assert.deepEqual(
          yield* home.fs.readFile(home.dbPath),
          yield* home.fs.readFile(home.point.snapshotPath),
        );
        assert.deepEqual(readRows(home.dbPath), [{ value: "before" }]);
        assert.isFalse(yield* home.fs.exists(`${home.dbPath}-wal`));
        assert.equal(yield* home.fs.readLink(home.launcher), home.toEntry);
        const record = yield* readRecord(home);
        assert.deepEqual(
          (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
            (entry) => entry.action,
          ),
          [
            "stopped the background service",
            `moved the current database to ${displacedDir(home)}`,
            `restored the database from recovery point ${POINT_ID}`,
            NOTHING_CARRIED,
            "pointed the background service at t3@1.2.3",
            "restarted the background service on t3@1.2.3",
          ],
        );
        assert.isTrue(
          errors.some((warning) =>
            String(warning).startsWith("  Warning: the launcher was not pointed at t3@1.2.3"),
          ),
        );
        assert.notInclude(logs, "Recovered to t3@1.2.3.");
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "names the files to move back and suggests no restart when the database cannot be moved aside or back",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        const stranded = home.path.join(displacedDir(home), "statev2.sqlite");
        // The database moves aside, its -wal cannot, and the database cannot move back.
        const { exit, events, errors } = yield* recover(home, {
          service: "serves-this-home",
          fs: (fs) => ({
            ...fs,
            rename: (from, to) =>
              from === `${home.dbPath}-wal` || from === stranded
                ? refusedBy("rename", from)
                : fs.rename(from, to),
          }),
        });

        assert.equal(exit._tag, "Failure");
        const reason = failureReason(exit);
        assert.include(reason, `Still in ${displacedDir(home)}: ${stranded}.`);
        assert.include(
          reason,
          `Move statev2.sqlite from ${displacedDir(home)} back to ${home.path.dirname(home.dbPath)} before starting any server.`,
        );
        assert.notInclude(reason, "t3 service restart");
        assert.deepEqual(events, ["stop (database in place: true)"]);
        assert.deepEqual(yield* home.fs.readFile(stranded), home.liveBytes);
        assert.isFalse(yield* home.fs.exists(home.dbPath));
        assert.equal(yield* home.fs.readFileString(`${home.dbPath}-wal`), "wal");
        assert.equal(yield* home.fs.readLink(home.launcher), home.toEntry);
        assert.deepEqual(errors, []);
        // The prepared restore is removed, so nothing stray is beside the database.
        assert.deepEqual(
          (yield* home.fs.readDirectory(home.path.dirname(home.dbPath))).toSorted(),
          ["statev2.sqlite-shm", "statev2.sqlite-wal"],
        );
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("keeps every revocation made after the point revoked in the restored database", () =>
    Effect.gen(function* () {
      const later = "2026-10-09T12:00:00.000Z";
      const home = yield* makeUpdatedHome({
        auth: {
          before: [sessionRow("active"), sessionRow("revoked-later")].join(" "),
          after: [
            `update auth_sessions set revoked_at = '${later}' where session_id = 'revoked-later';`,
            sessionRow("created-later"),
          ].join(" "),
        },
      });
      const { exit, events } = yield* recover(home, { service: "serves-this-home" });

      assert.equal(exit._tag, "Success", failureReason(exit));
      assert.deepEqual(events, [
        "stop (database in place: true)",
        "service for 1.2.3",
        "install (allowDowngrade: true, start: false)",
        "restart",
      ]);
      // Revoked after the point stays revoked, active in both stays active,
      // and one created after the point is not in the restored database.
      assert.deepEqual(readSessions(home.dbPath), [
        { session_id: "active", revoked_at: null },
        { session_id: "revoked-later", revoked_at: later },
      ]);
      assert.deepEqual(readRows(home.dbPath), [{ value: "before" }]);
      // The replaced database keeps the later work, and the point is unchanged.
      const displaced = home.path.join(displacedDir(home), "statev2.sqlite");
      assert.deepEqual(yield* home.fs.readFile(displaced), home.liveBytes);
      assert.lengthOf(readSessions(displaced), 3);
      assert.isTrue(yield* verifySnapshot(home.point));
      const record = yield* readRecord(home);
      assert.include(
        (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
          (entry) => entry.action,
        ),
        "carried 1 revocation and 0 used pairing links from the current database",
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect.each([
    { name: "has no auth_sessions table", damage: "drop-table" },
    { name: "is not a readable database", damage: "corrupt" },
  ] as const)(
    "refuses before any move when the current database $name, so no revocation is lost",
    ({ damage }) =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome({
          auth: {
            before: sessionRow("revoked-later"),
            after: damage === "drop-table" ? "drop table auth_sessions;" : "",
          },
        });
        if (damage === "corrupt") {
          yield* home.fs.writeFileString(
            home.dbPath,
            "not a database, and long enough for a header",
          );
        }
        const liveBytes = yield* home.fs.readFile(home.dbPath);
        const { exit, events } = yield* recover(home, { service: "serves-this-home" });

        assert.equal(exit._tag, "Failure");
        const reason = failureReason(exit);
        assert.include(
          reason,
          "Not recovering: Could not carry the current database's revocations into the restored database: ",
        );
        if (damage === "drop-table") {
          assert.include(reason, "the current database has no auth_sessions table");
        }
        assert.include(reason, "The database was not moved.");
        assert.include(reason, "run `t3 service restart` to start it again");
        assert.deepEqual(events, ["stop (database in place: true)"]);
        assert.deepEqual(yield* home.fs.readFile(home.dbPath), liveBytes);
        assert.isFalse(
          yield* home.fs.exists(home.path.join(home.baseDir, "recovery", "displaced")),
        );
        assert.isFalse(yield* home.fs.exists(preparedPath(home)));
        assert.equal(yield* home.fs.readLink(home.launcher), home.toEntry);
        assert.isTrue(yield* verifySnapshot(home.point));
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect("finishes every step once the service has stopped, even when interrupted", () =>
    Effect.gen(function* () {
      const home = yield* makeUpdatedHome();
      const { events } = yield* recover(home, {
        service: "serves-this-home",
        interruptAfterStop: true,
      });

      assert.deepEqual(events, [
        "stop (database in place: true)",
        "service for 1.2.3",
        "install (allowDowngrade: true, start: false)",
        "restart",
      ]);
      yield* assertSwapped(home);
      const record = yield* readRecord(home);
      assert.include(
        (record["actions"] as ReadonlyArray<{ readonly action: string }>).map(
          (entry) => entry.action,
        ),
        "restarted the background service on t3@1.2.3",
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );

  it.effect(
    "names where each file is and suggests no restart when the database cannot be moved back",
    () =>
      Effect.gen(function* () {
        const home = yield* makeUpdatedHome();
        const displaced = (suffix: string) =>
          home.path.join(displacedDir(home), `statev2.sqlite${suffix}`);
        // The restore fails, the database moves back, its -wal cannot, and the
        // database cannot move aside again.
        let restoreFailed = false;
        const { exit, events } = yield* recover(home, {
          service: "serves-this-home",
          fs: (fs) => ({
            ...fs,
            rename: (from, to) => {
              if (from === preparedPath(home)) {
                restoreFailed = true;
                return refusedBy("rename", from);
              }
              return from === displaced("-wal") || (restoreFailed && from === home.dbPath)
                ? refusedBy("rename", from)
                : fs.rename(from, to);
            },
          }),
        });

        assert.equal(exit._tag, "Failure");
        const reason = failureReason(exit);
        assert.include(reason, "Could not restore the recovery point's snapshot.");
        assert.include(reason, `At ${home.path.dirname(home.dbPath)}: ${home.dbPath}.`);
        assert.include(
          reason,
          `Move statev2.sqlite-wal, statev2.sqlite-shm from ${displacedDir(home)} back to ${home.path.dirname(home.dbPath)}, where statev2.sqlite already is, before starting any server.`,
        );
        assert.include(reason, "leave it stopped until then");
        assert.notInclude(reason, "t3 service restart");
        assert.deepEqual(events, ["stop (database in place: true)"]);
        assert.deepEqual(yield* home.fs.readFile(home.dbPath), home.liveBytes);
        assert.equal(yield* home.fs.readFileString(displaced("-wal")), "wal");
        assert.equal(yield* home.fs.readFileString(displaced("-shm")), "shm");
        assert.isFalse(yield* home.fs.exists(preparedPath(home)));
        assert.equal(yield* home.fs.readLink(home.launcher), home.toEntry);
      }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
});
