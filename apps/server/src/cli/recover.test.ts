// @effect-diagnostics nodeBuiltinImport:off - tests build real SQLite databases.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import { createRecoveryPoint } from "../cloud/recoveryPoint.ts";
import * as ProcessRunner from "../processRunner.ts";
import { runRecover } from "./recover.ts";

const START = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T10:11:12.123Z"));
const POINT_ID = "20261009T101112123Z-1.2.3-to-1.2.4";
const FROM_DIGEST = "abcdef0123";

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

/**
 * A T3 home that was updated from 1.2.3 to 1.2.4: a recovery point taken
 * from the database before the update, later work written to the live
 * database with its -wal and -shm, and a launcher that points at 1.2.4.
 */
const makeUpdatedHome = Effect.fn("test.make_updated_home")(function* (options?: {
  readonly fromDigest?: string | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recover-test-" });
  const baseDir = path.join(root, "home");
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(dbPath);
  database.exec("create table notes (value text); insert into notes values ('before');");
  database.close();
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

  const later = new NodeSqlite.DatabaseSync(dbPath);
  later.exec("insert into notes values ('after');");
  later.close();
  yield* fs.writeFileString(`${dbPath}-wal`, "wal");
  yield* fs.writeFileString(`${dbPath}-shm`, "shm");
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
  },
) {
  const events: string[] = [];
  const unexpected = (name: string) => Effect.die(`unexpected ${name}`);
  const service = BootService.BootService.of({
    install: () => unexpected("install on the running version's service"),
    restart: unexpected("restart on the running version's service"),
    stop: Effect.gen(function* () {
      events.push(
        `stop (database in place: ${yield* home.fs.exists(home.dbPath).pipe(Effect.orDie)})`,
      );
      return yield* options.stop ?? Effect.succeed(true);
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
  const exit = yield* runRecover({
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
    Effect.exit,
  );
  return { exit, events };
});

const failureReason = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" ? String(exit.cause) : "";

const readRecord = (home: Home) =>
  home.fs
    .readFileString(home.path.join(home.point.dir, "recovery.json"))
    .pipe(Effect.map((text): Record<string, unknown> => JSON.parse(text)));

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
        const { exit, events } = yield* recover(home, { service: "serves-this-home" });

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
          { at, action: `pointed the launcher ${home.launcher} at t3@1.2.3` },
          { at, action: "pointed the background service at t3@1.2.3" },
          { at, action: "restarted the background service on t3@1.2.3" },
        ]);
        assert.isUndefined(record["allowUnverifiedRuntime"]);
        const lines = yield* TestConsole.logLines;
        assert.include(lines, "  stopped the background service");
        assert.include(lines, "  restarted the background service on t3@1.2.3");
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
});
