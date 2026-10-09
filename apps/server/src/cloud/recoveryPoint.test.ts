// @effect-diagnostics nodeBuiltinImport:off - tests read files and modes directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  appendRecoveryAction,
  createRecoveryPoint,
  displaceDatabase,
  listRecoveryPoints,
  loadRecoveryPoint,
  RECOVERY_POINT_STEP,
  RecoveryPointError,
  restoreSnapshot,
  verifySnapshot,
} from "./recoveryPoint.ts";

const START = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-09T10:11:12.123Z"));

const fileSha256 = (filePath: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
const fileMode = (filePath: string) => NodeFS.statSync(filePath).mode & 0o777;

const readRows = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("select value from notes order by value").all();
  } finally {
    database.close();
  }
};

// A T3 home with a database and the from runtime it was served by.
const makeHome = Effect.fn("test.make_recovery_home")(function* (options?: {
  readonly archiveSha256?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recovery-point-test-" });
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(dbPath);
  database.exec("create table notes (value text); insert into notes values ('kept');");
  database.close();
  yield* fs.writeFileString(path.join(baseDir, "userdata", "secrets"), "do-not-copy");
  const fromRuntime = path.join(baseDir, "runtime", "versions", "1.2.3");
  yield* fs.makeDirectory(fromRuntime, { recursive: true });
  yield* fs.writeFileString(path.join(fromRuntime, "t3"), "#!/bin/sh\n");
  if (options?.archiveSha256 !== undefined) {
    yield* fs.writeFileString(path.join(fromRuntime, ".archive-sha256"), options.archiveSha256);
  }
  yield* TestClock.setTime(START);
  return { fs, path, baseDir, dbPath, fromRuntime };
});

const pointsDirOf = (path: Path.Path, baseDir: string) => path.join(baseDir, "recovery", "points");

const createPoint = (baseDir: string, dbPath: string, fromVersion = "1.2.3", toVersion = "1.2.4") =>
  createRecoveryPoint({ baseDir, dbPath, fromVersion, toVersion });

it.layer(NodeServices.layer)("recovery point", (it) => {
  it.effect("keeps only an online backup and its record before an update", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath, fromRuntime } = yield* makeHome({
        archiveSha256: "  ABCDEF0123\n",
      });

      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));

      const id = "20261009T101112123Z-1.2.3-to-1.2.4";
      expect(point.id).toBe(id);
      expect(point.dir).toBe(path.join(pointsDirOf(path, baseDir), id));
      expect((yield* fs.readDirectory(point.dir)).toSorted()).toEqual([
        "recovery.json",
        "statev2.sqlite",
      ]);
      expect(yield* fs.readDirectory(pointsDirOf(path, baseDir))).toEqual([id]);
      expect(readRows(point.snapshotPath)).toEqual([{ value: "kept" }]);
      const record: unknown = JSON.parse(
        yield* fs.readFileString(path.join(point.dir, "recovery.json")),
      );
      expect(record).toEqual({
        id,
        createdAt: "2026-10-09T10:11:12.123Z",
        from: { version: "1.2.3", runtimePath: fromRuntime, archiveSha256: "abcdef0123" },
        to: { version: "1.2.4" },
        snapshot: {
          size: NodeFS.statSync(point.snapshotPath).size,
          sha256: fileSha256(point.snapshotPath),
        },
        actions: [],
      });
      expect(point.record).toEqual(record);
      expect(fileMode(path.join(baseDir, "recovery"))).toBe(0o700);
      expect(fileMode(pointsDirOf(path, baseDir))).toBe(0o700);
      expect(fileMode(point.dir)).toBe(0o700);
      expect(fileMode(point.snapshotPath)).toBe(0o600);
    }),
  );

  it.effect("records a null archive digest when the from runtime has none", () =>
    Effect.gen(function* () {
      const { baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      expect(point.record.from.archiveSha256).toBeNull();
    }),
  );

  it.effect.each([
    { name: "a home without a database", removeDatabase: true, toVersion: "1.2.4" },
    { name: "an update to the same version", removeDatabase: false, toVersion: "1.2.3" },
  ])("keeps no point for $name", ({ removeDatabase, toVersion }) =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      if (removeDatabase) yield* fs.remove(dbPath);

      expect(Option.isNone(yield* createPoint(baseDir, dbPath, "1.2.3", toVersion))).toBe(true);
      expect(yield* fs.exists(path.join(baseDir, "recovery"))).toBe(false);
    }),
  );

  it.effect("a fourth point prunes only the oldest", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const displaced = path.join(baseDir, "recovery", "displaced", "20200101T000000000Z-old");
      yield* fs.makeDirectory(displaced, { recursive: true });
      yield* fs.writeFileString(path.join(displaced, "statev2.sqlite"), "displaced");
      const pointsDir = pointsDirOf(path, baseDir);
      // Neither a staging directory nor one without a valid record is a point.
      yield* fs.makeDirectory(path.join(pointsDir, ".staging-other"), { recursive: true });
      yield* fs.makeDirectory(path.join(pointsDir, "00000000T000000000Z-junk"), {
        recursive: true,
      });
      const runtimeBefore = yield* fs.readDirectory(path.join(baseDir, "runtime", "versions"));

      const ids: string[] = [];
      for (const toVersion of ["1.2.4", "1.2.5", "1.2.6", "1.2.7"]) {
        ids.push(Option.getOrThrow(yield* createPoint(baseDir, dbPath, "1.2.3", toVersion)).id);
        yield* TestClock.adjust(Duration.seconds(1));
      }

      expect((yield* listRecoveryPoints(baseDir)).map((point) => point.id)).toEqual(
        ids.slice(1).toReversed(),
      );
      expect((yield* fs.readDirectory(pointsDir)).toSorted()).toEqual(
        [".staging-other", "00000000T000000000Z-junk", ...ids.slice(1)].toSorted(),
      );
      expect(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions"))).toEqual(
        runtimeBefore,
      );
      expect(yield* fs.readFileString(path.join(displaced, "statev2.sqlite"))).toBe("displaced");
    }),
  );

  it.effect("fails and leaves nothing behind when the database cannot be backed up", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      yield* fs.writeFileString(
        dbPath,
        "this is not a SQLite database, just some bytes\n".repeat(50),
      );

      const error = yield* createPoint(baseDir, dbPath).pipe(Effect.flip);

      expect(error._tag).toBe("PinnedRuntimeInstallError");
      expect(error.step).toBe(RECOVERY_POINT_STEP);
      expect(yield* fs.readDirectory(pointsDirOf(path, baseDir))).toEqual([]);
    }),
  );

  it.effect("fails when the recovery directory cannot hold points", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      yield* fs.makeDirectory(path.join(baseDir, "recovery"), { recursive: true });
      yield* fs.writeFileString(pointsDirOf(path, baseDir), "a file, not a directory");

      const error = yield* createPoint(baseDir, dbPath).pipe(Effect.flip);

      expect(error.step).toBe(RECOVERY_POINT_STEP);
      expect(yield* fs.readFileString(pointsDirOf(path, baseDir))).toBe("a file, not a directory");
      expect(yield* fs.readDirectory(path.join(baseDir, "recovery"))).toEqual(["points"]);
    }),
  );

  it.effect.each(["", ".", "..", "../points", "a/b", ".staging-x", "a\\b"])(
    "load refuses the id %j",
    (id) =>
      Effect.gen(function* () {
        const { baseDir } = yield* makeHome();
        const error = yield* loadRecoveryPoint(baseDir, id).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RecoveryPointError);
      }),
  );

  it.effect("loads a point and refuses one that does not exist", () =>
    Effect.gen(function* () {
      const { baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));

      expect(yield* loadRecoveryPoint(baseDir, point.id)).toEqual(point);
      const error = yield* loadRecoveryPoint(baseDir, "20261009T101112123Z-9-to-10").pipe(
        Effect.flip,
      );
      expect(error.message).toContain("no recovery point");
    }),
  );

  it.effect("verifies the snapshot and detects tampering", () =>
    Effect.gen(function* () {
      const { fs, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      expect(yield* verifySnapshot(point)).toBe(true);

      const bytes = yield* fs.readFile(point.snapshotPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      yield* fs.writeFile(point.snapshotPath, bytes);
      expect(yield* verifySnapshot(point)).toBe(false);

      yield* fs.remove(point.snapshotPath);
      expect(yield* verifySnapshot(point)).toBe(false);
    }),
  );

  it.effect("appends actions with UTC times and records an unverified runtime", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));

      yield* TestClock.adjust(Duration.minutes(1));
      yield* appendRecoveryAction(baseDir, point.id, "stopped the service");
      yield* TestClock.adjust(Duration.seconds(1));
      const record = yield* appendRecoveryAction(baseDir, point.id, "moved the database aside", {
        allowUnverifiedRuntime: true,
      });

      expect(record.actions).toEqual([
        { at: "2026-10-09T10:12:12.123Z", action: "stopped the service" },
        { at: "2026-10-09T10:12:13.123Z", action: "moved the database aside" },
      ]);
      expect(record.allowUnverifiedRuntime).toBe(true);
      expect((yield* loadRecoveryPoint(baseDir, point.id)).record).toEqual(record);
      expect((yield* fs.readDirectory(point.dir)).toSorted()).toEqual([
        "recovery.json",
        "statev2.sqlite",
      ]);
      expect(fileMode(path.join(point.dir, "recovery.json"))).toBe(0o600);
    }),
  );

  it.effect("displaces the database with its journal and restores the snapshot", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      // Later work the restore must not discard.
      const database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec("insert into notes values ('later');");
      database.close();
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");

      const refused = yield* restoreSnapshot(baseDir, point.id, dbPath).pipe(Effect.flip);
      expect(refused.message).toContain("Refusing to restore");

      yield* TestClock.adjust(Duration.minutes(5));
      const displacedDir = yield* displaceDatabase(baseDir, dbPath, point.id);

      expect(displacedDir).toBe(
        path.join(baseDir, "recovery", "displaced", `20261009T101612123Z-${point.id}`),
      );
      expect((yield* fs.readDirectory(displacedDir)).toSorted()).toEqual([
        "statev2.sqlite",
        "statev2.sqlite-shm",
        "statev2.sqlite-wal",
      ]);
      expect(fileMode(displacedDir)).toBe(0o700);
      expect(yield* fs.readFileString(path.join(displacedDir, "statev2.sqlite-wal"))).toBe("wal");
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(yield* fs.exists(`${dbPath}${suffix}`)).toBe(false);
      }

      yield* restoreSnapshot(baseDir, point.id, dbPath);

      expect(fileSha256(dbPath)).toBe(point.record.snapshot.sha256);
      expect(fileMode(dbPath)).toBe(0o600);
      expect(readRows(dbPath)).toEqual([{ value: "kept" }]);
      expect(yield* fs.readDirectory(path.dirname(dbPath))).not.toContain(
        `.statev2.sqlite.recover-${point.id}`,
      );
      expect(yield* listRecoveryPoints(baseDir)).toEqual([point]);
    }),
  );
});
