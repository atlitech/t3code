// @effect-diagnostics nodeBuiltinImport:off - tests read files and modes directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  acquireRecoverLock,
  appendRecoveryAction,
  createRecoveryPoint,
  DatabaseDisplaceError,
  DatabaseReturnError,
  displaceDatabase,
  listRecoveryPoints,
  loadRecoveryPoint,
  prepareRestore,
  RECOVERY_POINT_STEP,
  RecoveryPointError,
  restoreSnapshot,
  returnDisplacedDatabase,
  verifySnapshot,
} from "./recoveryPoint.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

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

const isDatabaseDisplaceError = Schema.is(DatabaseDisplaceError);

const refusedBy = (method: string, pathOrDescriptor: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor,
    }),
  );

// Fails the rename of `failFrom` to anywhere, on the file system displaceDatabase runs on.
const withFailingRenames =
  (failFrom: ReadonlyArray<string>) =>
  (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...fs,
    rename: (from, to) =>
      failFrom.includes(from) ? refusedBy("rename", from) : fs.rename(from, to),
  });

const isDatabaseReturnError = Schema.is(DatabaseReturnError);

// Builds the server's real schema on the database at `dbPath`, as startup does.
const migrate = (dbPath: string) =>
  Layer.build(SqlitePersistence.layerFromPath(dbPath)).pipe(Effect.scoped, Effect.asVoid);

const execSql = (databasePath: string, statements: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(statements);
  } finally {
    database.close();
  }
};

const sessionRow = (id: string, revokedAt: string | null = null) =>
  `insert into auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at) values ('${id}', 'owner', '[]', 'browser-session-cookie', '2026-10-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z', ${revokedAt === null ? "null" : `'${revokedAt}'`});`;

const pairingLinkRow = (id: string) =>
  `insert into auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at) values ('${id}', 'credential-${id}', 'one-time-token', '[]', 'owner', '2026-10-09T10:00:00.000Z', '2026-11-09T10:00:00.000Z');`;

const readAuth = (databasePath: string) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      sessions: database
        .prepare("select session_id, revoked_at from auth_sessions order by session_id")
        .all(),
      pairingLinks: database
        .prepare("select id, consumed_at, revoked_at from auth_pairing_links order by id")
        .all(),
    };
  } finally {
    database.close();
  }
};

const LATER = "2026-10-09T12:00:00.000Z";

// Above every pid macOS and Linux hand out by default, so never running.
const DEAD_PID = 99999999;

// Records what the lock at `lockPath` names each time it is renamed or
// removed, on the file system a lock taker runs on.
const recordingLockMoves =
  (lockPath: string, moved: Array<string>) =>
  (fs: FileSystem.FileSystem): FileSystem.FileSystem => {
    const record = (filePath: string) =>
      filePath === lockPath
        ? fs.readFileString(filePath).pipe(
            Effect.tap((contents) => Effect.sync(() => moved.push(contents.trim()))),
            Effect.ignore,
          )
        : Effect.void;
    return {
      ...fs,
      rename: (from, to) => record(from).pipe(Effect.andThen(fs.rename(from, to))),
      remove: (filePath, options) =>
        record(filePath).pipe(Effect.andThen(fs.remove(filePath, options))),
    };
  };

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

      // A prepared restore is never renamed over a database, and is removed.
      const early = yield* prepareRestore(baseDir, point.id, dbPath);
      const refused = yield* restoreSnapshot(early, dbPath).pipe(Effect.flip);
      expect(refused.message).toContain("Refusing to restore");
      expect(yield* fs.exists(early.path)).toBe(false);

      // Each run prepares its own copy, so two runs never share one.
      const prepared = yield* prepareRestore(baseDir, point.id, dbPath);
      expect(path.dirname(prepared.path)).toBe(path.dirname(dbPath));
      expect(path.basename(prepared.path)).toMatch(
        new RegExp(
          `^\\.statev2\\.sqlite\\.recover-${point.id.replace(/\./g, "\\.")}\\.${process.pid}-`,
        ),
      );
      expect(prepared.path).not.toBe(early.path);
      expect(prepared.revocations).toBe(0);
      expect(fileMode(prepared.path)).toBe(0o600);

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

      yield* restoreSnapshot(prepared, dbPath);

      expect(fileSha256(dbPath)).toBe(point.record.snapshot.sha256);
      expect(fileMode(dbPath)).toBe(0o600);
      expect(readRows(dbPath)).toEqual([{ value: "kept" }]);
      expect(
        (yield* fs.readDirectory(path.dirname(dbPath))).filter((name) =>
          name.includes(".recover-"),
        ),
      ).toEqual([]);
      expect(yield* listRecoveryPoints(baseDir)).toEqual([point]);
    }),
  );

  it.effect("moves a displaced database back with its journal, never over another", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");
      const liveSha256 = fileSha256(dbPath);
      const displacedDir = yield* displaceDatabase(baseDir, dbPath, point.id);

      // A database back at the path is never overwritten, and nothing moves.
      yield* fs.writeFileString(`${dbPath}-shm`, "another");
      const refused = yield* returnDisplacedDatabase(displacedDir, dbPath).pipe(Effect.flip);
      expect(refused.message).toContain(`Refusing to move the database back over ${dbPath}-shm`);
      expect(yield* fs.readFileString(`${dbPath}-shm`)).toBe("another");
      expect(yield* fs.exists(dbPath)).toBe(false);
      expect((yield* fs.readDirectory(displacedDir)).toSorted()).toEqual([
        "statev2.sqlite",
        "statev2.sqlite-shm",
        "statev2.sqlite-wal",
      ]);
      yield* fs.remove(`${dbPath}-shm`);

      yield* returnDisplacedDatabase(displacedDir, dbPath);

      expect(fileSha256(dbPath)).toBe(liveSha256);
      expect(yield* fs.readFileString(`${dbPath}-wal`)).toBe("wal");
      expect(yield* fs.readFileString(`${dbPath}-shm`)).toBe("shm");
      expect(yield* fs.readDirectory(displacedDir)).toEqual([]);
      expect(path.dirname(displacedDir)).toBe(path.join(baseDir, "recovery", "displaced"));
    }),
  );

  it.effect("puts back what moved and says nothing was moved when a move fails", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");
      const liveSha256 = fileSha256(dbPath);

      // The database moves, then its -wal cannot.
      const error = yield* displaceDatabase(baseDir, dbPath, point.id).pipe(
        Effect.provideService(FileSystem.FileSystem, withFailingRenames([`${dbPath}-wal`])(fs)),
        Effect.flip,
      );

      if (!isDatabaseDisplaceError(error)) return expect.unreachable(error.message);
      const displaced = error;
      expect(displaced.message).toBe(
        "Could not move the current database aside; nothing was moved.",
      );
      expect(displaced.rolledBack).toBe(true);
      expect(displaced.leftDisplaced).toEqual([]);
      expect(displaced.atLivePath).toEqual([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
      expect(fileSha256(dbPath)).toBe(liveSha256);
      expect(yield* fs.readFileString(`${dbPath}-wal`)).toBe("wal");
      expect(yield* fs.readFileString(`${dbPath}-shm`)).toBe("shm");
      expect(yield* fs.readDirectory(displaced.displacedDir)).toEqual([]);
      expect(path.dirname(displaced.displacedDir)).toBe(
        path.join(baseDir, "recovery", "displaced"),
      );
    }),
  );

  it.effect("names the files left aside when moving them back fails too", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");
      const liveSha256 = fileSha256(dbPath);
      const targetDir = path.join(
        baseDir,
        "recovery",
        "displaced",
        `20261009T101112123Z-${point.id}`,
      );
      const strandedPath = path.join(targetDir, "statev2.sqlite");

      // The database moves, its -wal cannot, and the database cannot move back.
      const error = yield* displaceDatabase(baseDir, dbPath, point.id).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          withFailingRenames([`${dbPath}-wal`, strandedPath])(fs),
        ),
        Effect.flip,
      );

      if (!isDatabaseDisplaceError(error)) return expect.unreachable(error.message);
      const displaced = error;
      expect(displaced.rolledBack).toBe(false);
      expect(displaced.displacedDir).toBe(targetDir);
      expect(displaced.leftDisplaced).toEqual([strandedPath]);
      expect(displaced.atLivePath).toEqual([`${dbPath}-wal`, `${dbPath}-shm`]);
      expect(displaced.message).toContain(`Still in ${targetDir}: ${strandedPath}.`);
      expect(displaced.message).toContain(
        `At ${path.dirname(dbPath)}: ${dbPath}-wal, ${dbPath}-shm.`,
      );
      expect(displaced.message).not.toContain("nothing was moved");
      expect(fileSha256(strandedPath)).toBe(liveSha256);
      expect(yield* fs.exists(dbPath)).toBe(false);
      expect(yield* fs.readFileString(`${dbPath}-wal`)).toBe("wal");
    }),
  );

  it.effect(
    "carries revocations and pairing-link uses into the prepared copy, never the point's snapshot",
    () =>
      Effect.gen(function* () {
        const { fs, baseDir, dbPath } = yield* makeHome();
        yield* migrate(dbPath);
        execSql(
          dbPath,
          [
            sessionRow("active"),
            sessionRow("revoked-before", "2026-10-09T09:00:00.000Z"),
            sessionRow("revoked-later"),
            pairingLinkRow("link-open"),
            pairingLinkRow("link-revoked-later"),
            pairingLinkRow("link-used-later"),
          ].join("\n"),
        );
        const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));

        // After the point: revocations, a use, a new session, and a later
        // revocation of a session the snapshot already records as revoked.
        execSql(
          dbPath,
          [
            `update auth_sessions set revoked_at = '${LATER}' where session_id in ('revoked-later', 'revoked-before');`,
            `update auth_pairing_links set revoked_at = '${LATER}' where id = 'link-revoked-later';`,
            `update auth_pairing_links set consumed_at = '${LATER}' where id = 'link-used-later';`,
            sessionRow("created-later"),
          ].join("\n"),
        );
        const liveBytes = yield* fs.readFile(dbPath);

        const prepared = yield* prepareRestore(baseDir, point.id, dbPath);

        expect(prepared.revocations).toBe(2);
        expect(prepared.usedPairingLinks).toBe(1);
        // Every change is in the copy's main file, the only one renamed into place.
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          expect(yield* fs.exists(`${prepared.path}${suffix}`)).toBe(false);
        }
        expect(readAuth(prepared.path)).toEqual({
          sessions: [
            { session_id: "active", revoked_at: null },
            { session_id: "revoked-before", revoked_at: "2026-10-09T09:00:00.000Z" },
            { session_id: "revoked-later", revoked_at: LATER },
          ],
          pairingLinks: [
            { id: "link-open", consumed_at: null, revoked_at: null },
            { id: "link-revoked-later", consumed_at: null, revoked_at: LATER },
            { id: "link-used-later", consumed_at: LATER, revoked_at: null },
          ],
        });
        expect(readRows(prepared.path)).toEqual([{ value: "kept" }]);
        expect(yield* verifySnapshot(point)).toBe(true);
        expect(yield* fs.readFile(dbPath)).toEqual(liveBytes);
      }),
  );

  it.effect.each([
    {
      name: "a session whose row was deleted",
      change: "delete from auth_sessions where session_id = 'gone';",
      revokedMissing: 1,
    },
    {
      name: "a pairing link whose row was deleted",
      change: "delete from auth_pairing_links where id = 'link-gone';",
      revokedMissing: 1,
    },
    {
      // As migration 031_AuthAuthorizationScopes does.
      name: "every credential, when the auth tables were recreated empty",
      change: "recreate",
      revokedMissing: 5,
    },
    {
      name: "every credential, when there is no current database",
      change: "remove",
      revokedMissing: 5,
    },
  ])("revokes $name in the prepared copy, timestamped now", ({ change, revokedMissing }) =>
    Effect.gen(function* () {
      const { fs, baseDir, dbPath } = yield* makeHome();
      yield* migrate(dbPath);
      execSql(
        dbPath,
        [
          sessionRow("kept"),
          sessionRow("gone"),
          sessionRow("revoked-before", "2026-10-09T09:00:00.000Z"),
          pairingLinkRow("link-kept"),
          pairingLinkRow("link-gone"),
          pairingLinkRow("link-used-before"),
          "update auth_pairing_links set consumed_at = '2026-10-09T09:00:00.000Z' where id = 'link-used-before';",
        ].join("\n"),
      );
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      if (change === "remove") {
        yield* fs.remove(dbPath);
      } else if (change === "recreate") {
        const database = new NodeSqlite.DatabaseSync(dbPath);
        try {
          for (const table of ["auth_sessions", "auth_pairing_links"]) {
            const { sql } = database
              .prepare("select sql from sqlite_master where type = 'table' and name = ?")
              .get(table) as { readonly sql: string };
            database.exec(`drop table ${table}; ${sql};`);
          }
        } finally {
          database.close();
        }
      } else {
        execSql(dbPath, change);
      }
      yield* TestClock.adjust(Duration.hours(2));
      const now = "2026-10-09T12:11:12.123Z";

      const prepared = yield* prepareRestore(baseDir, point.id, dbPath);

      const missing = (id: string) =>
        change === "recreate" || change === "remove" || change.includes(`'${id}'`);
      expect(prepared.revokedMissing).toBe(revokedMissing);
      expect(prepared.revocations).toBe(0);
      expect(prepared.usedPairingLinks).toBe(0);
      expect(readAuth(prepared.path)).toEqual({
        sessions: [
          { session_id: "gone", revoked_at: missing("gone") ? now : null },
          { session_id: "kept", revoked_at: missing("kept") ? now : null },
          { session_id: "revoked-before", revoked_at: "2026-10-09T09:00:00.000Z" },
        ],
        pairingLinks: [
          { id: "link-gone", consumed_at: null, revoked_at: missing("link-gone") ? now : null },
          { id: "link-kept", consumed_at: null, revoked_at: missing("link-kept") ? now : null },
          {
            id: "link-used-before",
            consumed_at: "2026-10-09T09:00:00.000Z",
            revoked_at: missing("link-used-before") ? now : null,
          },
        ],
      });
      expect(yield* verifySnapshot(point)).toBe(true);
    }),
  );

  it.effect("skips an auth table the snapshot predates: it holds nothing to revoke", () =>
    Effect.gen(function* () {
      const { fs, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* migrate(dbPath);
      execSql(dbPath, sessionRow("revoked-later", LATER));

      const prepared = yield* prepareRestore(baseDir, point.id, dbPath);

      expect(prepared.revocations).toBe(0);
      expect(yield* fs.readFile(prepared.path)).toEqual(yield* fs.readFile(point.snapshotPath));
    }),
  );

  it.effect.each([
    {
      name: "a table the snapshot has",
      change: "drop table auth_sessions;",
      reason: "the current database has no auth_sessions table, which the snapshot has",
    },
    {
      name: "a column the snapshot has",
      change:
        "drop index idx_auth_pairing_links_active; alter table auth_pairing_links drop column consumed_at;",
      reason: "the current database's auth_pairing_links table has no consumed_at column",
    },
    { name: "a readable database", change: "corrupt", reason: "into the restored database: " },
  ])("refuses to prepare a restore when the current database lacks $name", ({ change, reason }) =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      yield* migrate(dbPath);
      execSql(dbPath, sessionRow("revoked-later"));
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      if (change === "corrupt") {
        yield* fs.writeFileString(dbPath, "not a database, and long enough to have a header");
      } else {
        execSql(dbPath, change);
      }
      const liveBytes = yield* fs.readFile(dbPath);

      const error = yield* prepareRestore(baseDir, point.id, dbPath).pipe(Effect.flip);

      expect(error.message).toContain(
        "Could not carry the current database's revocations into the restored database: ",
      );
      expect(error.message).toContain(reason);
      expect(yield* fs.readFile(dbPath)).toEqual(liveBytes);
      expect(
        (yield* fs.readDirectory(path.dirname(dbPath))).filter((name) =>
          name.includes(".recover-"),
        ),
      ).toEqual([]);
      expect(yield* verifySnapshot(point)).toBe(true);
    }),
  );

  it.effect("puts a database it cannot fully move back aside again, and says so", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");
      const liveSha256 = fileSha256(dbPath);
      const displacedDir = yield* displaceDatabase(baseDir, dbPath, point.id);
      const displaced = (suffix: string) => path.join(displacedDir, `statev2.sqlite${suffix}`);

      // The database moves back, then its -wal cannot.
      const error = yield* returnDisplacedDatabase(displacedDir, dbPath).pipe(
        Effect.provideService(FileSystem.FileSystem, withFailingRenames([displaced("-wal")])(fs)),
        Effect.flip,
      );

      if (!isDatabaseReturnError(error)) return expect.unreachable(error.message);
      expect(error.atLivePath).toEqual([]);
      expect(error.leftDisplaced).toEqual([displaced(""), displaced("-wal"), displaced("-shm")]);
      expect(error.message).toBe(
        `Could not move the database back into place; all of its files are still in ${displacedDir}: ${displaced("")}, ${displaced("-wal")}, ${displaced("-shm")}.`,
      );
      expect(fileSha256(displaced(""))).toBe(liveSha256);
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(yield* fs.exists(`${dbPath}${suffix}`)).toBe(false);
      }
    }),
  );

  it.effect("names where each file is when putting a partial return aside fails too", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir, dbPath } = yield* makeHome();
      const point = Option.getOrThrow(yield* createPoint(baseDir, dbPath));
      yield* fs.writeFileString(`${dbPath}-wal`, "wal");
      yield* fs.writeFileString(`${dbPath}-shm`, "shm");
      const liveSha256 = fileSha256(dbPath);
      const displacedDir = yield* displaceDatabase(baseDir, dbPath, point.id);
      const displaced = (suffix: string) => path.join(displacedDir, `statev2.sqlite${suffix}`);

      // The database moves back, its -wal cannot, and the database cannot move aside again.
      const error = yield* returnDisplacedDatabase(displacedDir, dbPath).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          withFailingRenames([displaced("-wal"), dbPath])(fs),
        ),
        Effect.flip,
      );

      if (!isDatabaseReturnError(error)) return expect.unreachable(error.message);
      expect(error.atLivePath).toEqual([dbPath]);
      expect(error.leftDisplaced).toEqual([displaced("-wal"), displaced("-shm")]);
      expect(error.message).toContain(`At ${path.dirname(dbPath)}: ${dbPath}.`);
      expect(error.message).toContain(
        `Still in ${displacedDir}: ${displaced("-wal")}, ${displaced("-shm")}.`,
      );
      expect(fileSha256(dbPath)).toBe(liveSha256);
      expect(yield* fs.readFileString(displaced("-wal"))).toBe("wal");
      expect(yield* fs.exists(`${dbPath}-wal`)).toBe(false);
    }),
  );
  it.effect("a taker that found the lock stale refuses and keeps the lock another run took", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir } = yield* makeHome();
      const lockPath = path.join(baseDir, "recovery", "recover.lock");
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fs.writeFileString(lockPath, `${DEAD_PID}\n`);
      const stale = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const moved: Array<string> = [];
      const taker = yield* Effect.forkChild(
        acquireRecoverLock(baseDir, {
          beforeTakeover: Deferred.succeed(stale, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
          ),
        }).pipe(
          Effect.scoped,
          Effect.exit,
          Effect.provideService(FileSystem.FileSystem, recordingLockMoves(lockPath, moved)(fs)),
        ),
      );
      yield* Deferred.await(stale);
      // Another run, a live process other than this one, takes the lock the
      // way a fresh acquirer does once the stale one is gone.
      yield* fs.remove(lockPath);
      yield* fs.writeFileString(lockPath, `${process.ppid}\n`, { flag: "wx" });
      yield* Deferred.succeed(resume, undefined);

      const exit = yield* Fiber.join(taker);
      expect(exit._tag).toBe("Failure");
      expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain(
        `Another t3 recover (pid ${process.ppid}) is running on this T3 home.`,
      );
      // The other run's lock was never moved, not even for a moment.
      expect(moved).toEqual([]);
      expect(yield* fs.readFileString(lockPath)).toBe(`${process.ppid}\n`);
      expect(yield* fs.exists(`${lockPath}.takeover`)).toBe(false);
    }),
  );

  it.effect.each([
    { name: "one after the other", together: false },
    { name: "at once", together: true },
  ])("two takeovers of the same stale lock, $name, leave exactly one winner", ({ together }) =>
    Effect.gen(function* () {
      const { fs, path, baseDir } = yield* makeHome();
      const lockPath = path.join(baseDir, "recovery", "recover.lock");
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fs.writeFileString(lockPath, `${DEAD_PID}\n`);
      const finish = yield* Deferred.make<void>();
      const moved: Array<string> = [];
      const takers = yield* Effect.forEach([0, 1], () =>
        Effect.gen(function* () {
          const stale = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const attempted = yield* Deferred.make<"Success" | "Failure">();
          const fiber = yield* Effect.forkChild(
            Effect.gen(function* () {
              const exit = yield* Effect.exit(
                acquireRecoverLock(baseDir, {
                  beforeTakeover: Deferred.succeed(stale, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                  ),
                }).pipe(
                  Effect.provideService(
                    FileSystem.FileSystem,
                    recordingLockMoves(lockPath, moved)(fs),
                  ),
                ),
              );
              yield* Deferred.succeed(attempted, exit._tag);
              // The winner holds the lock until the test is done looking.
              if (exit._tag === "Success") yield* Deferred.await(finish);
            }).pipe(Effect.scoped),
          );
          return { stale, resume, attempted, fiber };
        }),
      );
      // Both found the lock stale before either takes it over.
      yield* Effect.forEach(takers, ({ stale }) => Deferred.await(stale));
      const outcomes = together
        ? yield* Effect.gen(function* () {
            yield* Effect.forEach(takers, ({ resume }) => Deferred.succeed(resume, undefined));
            return yield* Effect.forEach(takers, ({ attempted }) => Deferred.await(attempted));
          })
        : // The first finishes its takeover before the second goes on.
          yield* Effect.forEach(takers, ({ resume, attempted }) =>
            Deferred.succeed(resume, undefined).pipe(Effect.andThen(Deferred.await(attempted))),
          );
      expect(outcomes.toSorted()).toEqual(["Failure", "Success"]);
      if (!together) expect(outcomes).toEqual(["Success", "Failure"]);
      // Only the stale lock was ever removed, never the winner's.
      expect(moved.every((holder) => holder === String(DEAD_PID))).toBe(true);
      expect(yield* fs.readFileString(lockPath)).toBe(`${process.pid}\n`);
      expect(yield* fs.exists(`${lockPath}.takeover`)).toBe(false);

      yield* Deferred.succeed(finish, undefined);
      yield* Effect.forEach(takers, ({ fiber }) => Fiber.join(fiber));
      expect(yield* fs.exists(lockPath)).toBe(false);
    }),
  );

  it.effect("names a takeover file left by a recover that died, and moves nothing", () =>
    Effect.gen(function* () {
      const { fs, path, baseDir } = yield* makeHome();
      const lockPath = path.join(baseDir, "recovery", "recover.lock");
      yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
      yield* fs.writeFileString(lockPath, `${DEAD_PID}\n`);
      yield* fs.writeFileString(`${lockPath}.takeover`, `${DEAD_PID - 1}\n`);

      const error = yield* acquireRecoverLock(baseDir).pipe(Effect.scoped, Effect.flip);

      expect(error.message).toBe(
        `A t3 recover (pid ${DEAD_PID - 1}) that is no longer running left ${lockPath}.takeover. Remove it, then run t3 recover again.`,
      );
      expect(yield* fs.readFileString(lockPath)).toBe(`${DEAD_PID}\n`);
      expect(yield* fs.readFileString(`${lockPath}.takeover`)).toBe(`${DEAD_PID - 1}\n`);
    }),
  );
});
