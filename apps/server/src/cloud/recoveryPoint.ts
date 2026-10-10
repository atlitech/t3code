// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or synchronous SQLite client.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { PinnedRuntimeInstallError, pinnedRuntimeVersionsDir } from "./pinnedRuntime.ts";
import { snapshotDatabase } from "./servicePreflight.ts";

/**
 * A recovery point is what an update keeps before it switches a T3 home to
 * another server version: an online backup of the database and a record of
 * the version it came from, so `t3 recover` can put both back. Points live in
 * <baseDir>/recovery/points/<UTC>-<from>-to-<to>/; a database that recover
 * replaces is kept in <baseDir>/recovery/displaced/ and never pruned.
 */
const RECOVERY_DIR = "recovery";
const POINTS_DIR = "points";
const DISPLACED_DIR = "displaced";
const RECORD_FILE = "recovery.json";
const SNAPSHOT_FILE = "statev2.sqlite";
// Mirrors pinnedRuntime.ts: the sha256 of the archive a runtime was unpacked from.
const ARCHIVE_DIGEST_FILE = ".archive-sha256";
const STAGING_PREFIX = ".staging-";
const RETAINED_POINTS = 3;
// SQLite's companions of a live database, moved with it so a restored
// snapshot is never opened against another database's journal.
const DATABASE_COMPANION_SUFFIXES = ["", "-wal", "-shm"] as const;

/** The install step a failed recovery point fails an update's validation with. */
export const RECOVERY_POINT_STEP = "keeping a recovery point of the database";

const RecoveryAction = Schema.Struct({
  at: Schema.String,
  action: Schema.String,
});

const RecoveryPointRecord = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  from: Schema.Struct({
    version: Schema.String,
    runtimePath: Schema.String,
    archiveSha256: Schema.NullOr(Schema.String),
  }),
  to: Schema.Struct({
    version: Schema.String,
  }),
  snapshot: Schema.Struct({
    size: Schema.Number,
    sha256: Schema.String,
  }),
  actions: Schema.Array(RecoveryAction),
  allowUnverifiedRuntime: Schema.optional(Schema.Boolean),
});
export type RecoveryPointRecord = typeof RecoveryPointRecord.Type;

const RecoveryPointRecordJson = fromJsonStringPretty(RecoveryPointRecord);
const decodeRecoveryPointRecord = Schema.decodeUnknownEffect(RecoveryPointRecordJson);
const encodeRecoveryPointRecord = Schema.encodeEffect(RecoveryPointRecordJson);

export interface RecoveryPoint {
  readonly id: string;
  /** The point's directory. */
  readonly dir: string;
  /** The online backup of the database. */
  readonly snapshotPath: string;
  readonly record: RecoveryPointRecord;
}

export class RecoveryPointError extends Schema.TaggedError<RecoveryPointError>()(
  "RecoveryPointError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

// A point or displaced id is one plain path segment: never empty, hidden, or
// able to name a parent or nested directory.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const isSafeRecoveryPointId = (id: string): boolean => SAFE_ID.test(id) && !id.includes("..");

// Fixed width and colon-free, so the name sorts chronologically and is a
// valid file name everywhere: 20261009T101112123Z.
const compactUtc = (now: DateTime.Utc) => DateTime.formatIso(now).replace(/[-:.]/g, "");

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const recoveryPaths = (path: Path.Path, baseDir: string) => {
  const recoveryDir = path.join(baseDir, RECOVERY_DIR);
  return {
    recoveryDir,
    pointsDir: path.join(recoveryDir, POINTS_DIR),
    displacedDir: path.join(recoveryDir, DISPLACED_DIR),
  };
};

const sha256File = Effect.fn("cloud.recovery_point.sha256_file")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  yield* fs.stream(filePath).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        hash.update(chunk);
      }),
    ),
  );
  return { size, sha256: hash.digest("hex") };
});

// Creates a directory only its owner can enter. The explicit chmod covers a
// directory that already existed and the umask applied to a new one.
const makePrivateDirectory = Effect.fn("cloud.recovery_point.make_private_directory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
});

const writeRecord = Effect.fn("cloud.recovery_point.write_record")(function* (
  pointDir: string,
  record: RecoveryPointRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* encodeRecoveryPointRecord(record);
  const tempPath = path.join(pointDir, `.${RECORD_FILE}.tmp`);
  yield* fs.writeFileString(tempPath, `${contents}\n`, { mode: 0o600 });
  yield* fs.rename(tempPath, path.join(pointDir, RECORD_FILE));
});

const readPoint = Effect.fn("cloud.recovery_point.read_point")(function* (
  pointsDir: string,
  id: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(pointsDir, id);
  const record = yield* fs
    .readFileString(path.join(dir, RECORD_FILE))
    .pipe(Effect.flatMap(decodeRecoveryPointRecord), Effect.option);
  return Option.filter(record, (value) => value.id === id).pipe(
    Option.map((value): RecoveryPoint => ({
      id,
      dir,
      snapshotPath: path.join(dir, SNAPSHOT_FILE),
      record: value,
    })),
  );
});

// Newest first. Ids start with a fixed-width UTC time, so name order is
// creation order and ties break on the rest of the name.
const readPoints = Effect.fn("cloud.recovery_point.read_points")(function* (pointsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(pointsDir))) return [];
  const names = (yield* fs.readDirectory(pointsDir))
    .filter((name) => !name.startsWith(".") && isSafeRecoveryPointId(name))
    .toSorted()
    .toReversed();
  const points = yield* Effect.forEach(names, (name) => readPoint(pointsDir, name));
  return points.flatMap((point) => (Option.isSome(point) ? [point.value] : []));
});

/**
 * Keeps a recovery point of the database at `dbPath` before an update moves
 * this home from `fromVersion` to `toVersion`, then prunes all but the newest
 * three points. A home without a database, or an update that stays on the
 * same version, gets no point. The point is built in a hidden staging
 * directory with its record written last and renamed into place, so a failed
 * backup leaves nothing behind and fails the update's validation.
 */
export const createRecoveryPoint = Effect.fn("cloud.recovery_point.create")(
  function* (input: {
    readonly baseDir: string;
    readonly dbPath: string;
    readonly fromVersion: string;
    readonly toVersion: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.fromVersion === input.toVersion) return Option.none<RecoveryPoint>();
    if (!(yield* fs.exists(input.dbPath))) return Option.none<RecoveryPoint>();

    const now = yield* DateTime.now;
    const id = `${compactUtc(now)}-${input.fromVersion}-to-${input.toVersion}`;
    if (!isSafeRecoveryPointId(id)) {
      return yield* new RecoveryPointError({ detail: `'${id}' is not a recovery point id.` });
    }
    const { recoveryDir, pointsDir } = recoveryPaths(path, input.baseDir);
    yield* makePrivateDirectory(recoveryDir);
    yield* makePrivateDirectory(pointsDir);

    const stagingDir = path.join(pointsDir, `${STAGING_PREFIX}${id}`);
    const pointDir = path.join(pointsDir, id);
    const record = yield* Effect.gen(function* () {
      yield* fs.remove(stagingDir, { recursive: true, force: true });
      yield* makePrivateDirectory(stagingDir);
      const snapshotPath = path.join(stagingDir, SNAPSHOT_FILE);
      yield* snapshotDatabase(input.dbPath, snapshotPath);
      yield* fs.chmod(snapshotPath, 0o600);
      const snapshot = yield* sha256File(snapshotPath);

      const runtimePath = path.join(
        pinnedRuntimeVersionsDir(path, input.baseDir),
        input.fromVersion,
      );
      const archiveSha256 = (yield* fs
        .readFileString(path.join(runtimePath, ARCHIVE_DIGEST_FILE))
        .pipe(Effect.option)).pipe(
        Option.map((digest) => digest.trim().toLowerCase()),
        Option.filter((digest) => digest.length > 0),
        Option.getOrNull,
      );
      const record: RecoveryPointRecord = {
        id,
        createdAt: DateTime.formatIso(now),
        from: { version: input.fromVersion, runtimePath, archiveSha256 },
        to: { version: input.toVersion },
        snapshot,
        actions: [],
      };
      yield* writeRecord(stagingDir, record);
      yield* fs.rename(stagingDir, pointDir);
      yield* fs.chmod(pointDir, 0o700);
      return record;
    }).pipe(
      Effect.tapError(() =>
        fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );

    const points = yield* readPoints(pointsDir);
    yield* Effect.forEach(
      points.slice(RETAINED_POINTS),
      (point) => fs.remove(point.dir, { recursive: true }),
      { discard: true },
    );

    return Option.some<RecoveryPoint>({
      id,
      dir: pointDir,
      snapshotPath: path.join(pointDir, SNAPSHOT_FILE),
      record,
    });
  },
  Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: RECOVERY_POINT_STEP, cause })),
);

/** This home's recovery points, newest first. Staging and invalid entries are skipped. */
export const listRecoveryPoints = Effect.fn("cloud.recovery_point.list")(
  function* (baseDir: string) {
    const path = yield* Path.Path;
    return yield* readPoints(recoveryPaths(path, baseDir).pointsDir);
  },
  Effect.mapError(
    (cause) => new RecoveryPointError({ detail: "Could not list the recovery points.", cause }),
  ),
);

/** The recovery point `id` of this home; `id` must be one plain path segment. */
export const loadRecoveryPoint = Effect.fn("cloud.recovery_point.load")(function* (
  baseDir: string,
  id: string,
) {
  const path = yield* Path.Path;
  if (!isSafeRecoveryPointId(id)) {
    return yield* new RecoveryPointError({ detail: `'${id}' is not a recovery point id.` });
  }
  const point = yield* readPoint(recoveryPaths(path, baseDir).pointsDir, id);
  if (Option.isNone(point)) {
    return yield* new RecoveryPointError({ detail: `There is no recovery point '${id}'.` });
  }
  return point.value;
});

/** Whether the point's snapshot still has the size and sha256 its record names. */
export const verifySnapshot = Effect.fn("cloud.recovery_point.verify_snapshot")(
  function* (point: RecoveryPoint) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(point.snapshotPath))) return false;
    const actual = yield* sha256File(point.snapshotPath);
    return (
      actual.size === point.record.snapshot.size && actual.sha256 === point.record.snapshot.sha256
    );
  },
  Effect.mapError(
    (cause) =>
      new RecoveryPointError({ detail: "Could not read the recovery point's snapshot.", cause }),
  ),
);

/**
 * Appends what recover did to the point's record with the current UTC time,
 * and records an allowed unverified runtime. Returns the updated record.
 */
export const appendRecoveryAction = Effect.fn("cloud.recovery_point.append_action")(function* (
  baseDir: string,
  id: string,
  action: string,
  extra?: { readonly allowUnverifiedRuntime?: boolean },
) {
  const point = yield* loadRecoveryPoint(baseDir, id);
  const at = yield* nowIso;
  const record: RecoveryPointRecord = {
    ...point.record,
    actions: [...point.record.actions, { at, action }],
    ...(extra?.allowUnverifiedRuntime === undefined
      ? {}
      : { allowUnverifiedRuntime: extra.allowUnverifiedRuntime }),
  };
  yield* writeRecord(point.dir, record).pipe(
    Effect.mapError(
      (cause) =>
        new RecoveryPointError({ detail: "Could not update the recovery point record.", cause }),
    ),
  );
  return record;
});

/**
 * A database that could not be moved aside. `rolledBack` says every file that
 * moved was put back at its live path; otherwise `leftDisplaced` names the
 * files still in `displacedDir` and `atLivePath` the ones at the live path.
 */
export class DatabaseDisplaceError extends Schema.TaggedError<DatabaseDisplaceError>()(
  "DatabaseDisplaceError",
  {
    detail: Schema.String,
    displacedDir: Schema.String,
    rolledBack: Schema.Boolean,
    leftDisplaced: Schema.Array(Schema.String),
    atLivePath: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Moves the live database at `dbPath`, with its -wal and -shm when present,
 * into recovery/displaced/<UTC>-<id>/ and returns that directory. A failed
 * move puts back what was already moved, so the live database is never left
 * split from its journal; when putting a file back fails too, the error names
 * where each file is.
 */
export const displaceDatabase = Effect.fn("cloud.recovery_point.displace_database")(function* (
  baseDir: string,
  dbPath: string,
  id: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!isSafeRecoveryPointId(id)) {
    return yield* new RecoveryPointError({ detail: `'${id}' is not a recovery point id.` });
  }
  const now = yield* DateTime.now;
  const { recoveryDir, displacedDir } = recoveryPaths(path, baseDir);
  const targetDir = path.join(displacedDir, `${compactUtc(now)}-${id}`);
  const present: Array<string> = [];
  const moved: Array<{ readonly from: string; readonly to: string }> = [];
  const moveAside = Effect.gen(function* () {
    yield* makePrivateDirectory(recoveryDir);
    yield* makePrivateDirectory(displacedDir);
    yield* makePrivateDirectory(targetDir);
    for (const suffix of DATABASE_COMPANION_SUFFIXES) {
      if (yield* fs.exists(`${dbPath}${suffix}`)) present.push(`${dbPath}${suffix}`);
    }
    for (const from of present) {
      const to = path.join(targetDir, path.basename(from));
      yield* fs.rename(from, to);
      moved.push({ from, to });
    }
  });
  const failed = yield* moveAside.pipe(
    Effect.as(undefined),
    Effect.catch((cause) => Effect.succeed({ cause })),
  );
  if (failed === undefined) return targetDir;

  // Put back newest first; a file whose move back fails stays in targetDir.
  const stranded: Array<{ readonly from: string; readonly to: string }> = [];
  for (const entry of moved.toReversed()) {
    const back = yield* fs.rename(entry.to, entry.from).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!back) stranded.push(entry);
  }
  const leftDisplaced = stranded.map((entry) => entry.to).toReversed();
  const atLivePath = present.filter((file) => !stranded.some((entry) => entry.from === file));
  return yield* new DatabaseDisplaceError({
    detail:
      stranded.length === 0
        ? "Could not move the current database aside; nothing was moved."
        : `Could not move the current database aside, and moving it back failed too. Still in ${targetDir}: ${leftDisplaced.join(", ")}. At ${path.dirname(dbPath)}: ${
            atLivePath.length === 0 ? "none of its files" : atLivePath.join(", ")
          }.`,
    displacedDir: targetDir,
    rolledBack: stranded.length === 0,
    leftDisplaced,
    atLivePath,
    cause: failed.cause,
  });
});

/**
 * A database that could not be moved back from `displacedDir`. A failed move
 * puts what already moved back aside, so the files stay together; when that
 * fails too, `atLivePath` names the files at the live path and `leftDisplaced`
 * the ones still in `displacedDir`.
 */
export class DatabaseReturnError extends Schema.TaggedError<DatabaseReturnError>()(
  "DatabaseReturnError",
  {
    detail: Schema.String,
    displacedDir: Schema.String,
    leftDisplaced: Schema.Array(Schema.String),
    atLivePath: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Moves a database that `displaceDatabase` set aside in `displacedDir` back to
 * `dbPath`, with its -wal and -shm when present. Refuses while a database or
 * its -wal or -shm is at `dbPath`, so it never overwrites one. A failed move
 * puts what already moved back aside, and the error names where each file is.
 */
export const returnDisplacedDatabase = Effect.fn("cloud.recovery_point.return_displaced_database")(
  function* (displacedDir: string, dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (cause: unknown) =>
      new RecoveryPointError({ detail: "Could not move the database back into place.", cause });
    for (const suffix of DATABASE_COMPANION_SUFFIXES) {
      if (yield* fs.exists(`${dbPath}${suffix}`).pipe(Effect.mapError(fail))) {
        return yield* new RecoveryPointError({
          detail: `Refusing to move the database back over ${dbPath}${suffix}.`,
        });
      }
    }
    const present: Array<{ readonly from: string; readonly to: string }> = [];
    for (const suffix of DATABASE_COMPANION_SUFFIXES) {
      const from = path.join(displacedDir, `${path.basename(dbPath)}${suffix}`);
      if (yield* fs.exists(from).pipe(Effect.mapError(fail))) {
        present.push({ from, to: `${dbPath}${suffix}` });
      }
    }
    const moved: Array<{ readonly from: string; readonly to: string }> = [];
    const failed = yield* Effect.gen(function* () {
      for (const entry of present) {
        yield* fs.rename(entry.from, entry.to);
        moved.push(entry);
      }
    }).pipe(
      Effect.as(undefined),
      Effect.catch((cause) => Effect.succeed({ cause })),
    );
    if (failed === undefined) return;

    // Put aside again newest first; a file whose move fails stays at the live path.
    const stranded: Array<{ readonly from: string; readonly to: string }> = [];
    for (const entry of moved.toReversed()) {
      const aside = yield* fs.rename(entry.to, entry.from).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!aside) stranded.push(entry);
    }
    const atLivePath = stranded.map((entry) => entry.to).toReversed();
    const leftDisplaced = present
      .filter((entry) => !stranded.some((other) => other.from === entry.from))
      .map((entry) => entry.from);
    return yield* new DatabaseReturnError({
      detail:
        stranded.length === 0
          ? `Could not move the database back into place; all of its files are still in ${displacedDir}: ${leftDisplaced.join(", ")}.`
          : `Could not move the database back into place, and putting it back aside failed too. At ${path.dirname(dbPath)}: ${atLivePath.join(", ")}. Still in ${displacedDir}: ${
              leftDisplaced.length === 0 ? "none of its files" : leftDisplaced.join(", ")
            }.`,
      displacedDir,
      leftDisplaced,
      atLivePath,
      cause: failed.cause,
    });
  },
);

/**
 * Auth state a restored database keeps from the current one: a session or a
 * pairing link revoked after the point, and a pairing link used after it,
 * would otherwise be valid again in the snapshot. Each row is matched by the
 * id the server looks it up by.
 */
const CARRIED_AUTH_STATE = [
  { table: "auth_sessions", key: "session_id", columns: ["revoked_at"] },
  { table: "auth_pairing_links", key: "id", columns: ["revoked_at", "consumed_at"] },
] as const;

interface CarriedAuthState {
  /** Rows whose revoked_at the restored database took from the current one. */
  readonly revocations: number;
  /** Pairing links whose consumed_at the restored database took from the current one. */
  readonly usedPairingLinks: number;
}

const columnsOf = (database: NodeSqlite.DatabaseSync, table: string) =>
  new Set(
    database
      .prepare("select name from pragma_table_info(?)")
      .all(table)
      .map((row) => String(row["name"])),
  );

/**
 * Applies to the database at `restoredPath` every revocation and pairing-link
 * use recorded in the database at `currentPath`, in one transaction. The
 * current database is only read. Throws when it cannot: a table the snapshot
 * has that the current database lacks, or a missing column, is refused rather
 * than skipped, so no revocation is silently dropped. A table the snapshot
 * predates holds nothing to revoke.
 */
const carryAuthState = (restoredPath: string, currentPath: string | undefined) => {
  const restored = new NodeSqlite.DatabaseSync(restoredPath);
  try {
    const current =
      currentPath === undefined
        ? undefined
        : new NodeSqlite.DatabaseSync(currentPath, { readOnly: true });
    try {
      const updates: Array<{
        readonly column: string;
        readonly rows: ReadonlyArray<Record<string, NodeSqlite.SQLOutputValue>>;
        readonly update: NodeSqlite.StatementSync;
      }> = [];
      for (const { table, key, columns } of CARRIED_AUTH_STATE) {
        const restoredColumns = columnsOf(restored, table);
        if (restoredColumns.size === 0 || current === undefined) continue;
        const currentColumns = columnsOf(current, table);
        if (currentColumns.size === 0) {
          throw new Error(`the current database has no ${table} table, which the snapshot has`);
        }
        for (const column of [key, ...columns]) {
          if (!restoredColumns.has(column)) {
            throw new Error(`the snapshot's ${table} table has no ${column} column`);
          }
          if (!currentColumns.has(column)) {
            throw new Error(`the current database's ${table} table has no ${column} column`);
          }
        }
        for (const column of columns) {
          updates.push({
            column,
            rows: current
              .prepare(
                `select ${key} as id, ${column} as value from ${table} where ${column} is not null`,
              )
              .all(),
            update: restored.prepare(
              `update ${table} set ${column} = ? where ${key} = ? and ${column} is null`,
            ),
          });
        }
      }
      let revocations = 0;
      let usedPairingLinks = 0;
      // Nothing to carry leaves the copy byte for byte the point's snapshot.
      if (updates.every(({ rows }) => rows.length === 0)) {
        return { revocations, usedPairingLinks } satisfies CarriedAuthState;
      }
      restored.exec("begin immediate");
      try {
        for (const { column, rows, update } of updates) {
          for (const row of rows) {
            const changes = Number(update.run(row["value"] ?? null, row["id"] ?? null).changes);
            if (column === "consumed_at") usedPairingLinks += changes;
            else revocations += changes;
          }
        }
        restored.exec("commit");
      } catch (error) {
        restored.exec("rollback");
        throw error;
      }
      return { revocations, usedPairingLinks } satisfies CarriedAuthState;
    } finally {
      current?.close();
    }
  } finally {
    restored.close();
  }
};

/** The restored database recover renames into place once the live one is aside. */
export interface PreparedRestore extends CarriedAuthState {
  /** A hidden copy of the snapshot beside the database. */
  readonly path: string;
}

const removeDatabaseFiles = (fs: FileSystem.FileSystem, databasePath: string) =>
  Effect.forEach(
    DATABASE_COMPANION_SUFFIXES,
    (suffix) => fs.remove(`${databasePath}${suffix}`, { force: true }).pipe(Effect.ignore),
    { discard: true },
  );

/**
 * Copies the point's snapshot to a hidden file beside `dbPath`, readable only
 * by its owner, and carries into that copy every revocation and pairing-link
 * use the current database at `dbPath` records, reading it without writing.
 * The point's own snapshot is never opened. Nothing at `dbPath` moves; a
 * failure removes the copy.
 */
export const prepareRestore = Effect.fn("cloud.recovery_point.prepare_restore")(function* (
  baseDir: string,
  id: string,
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const point = yield* loadRecoveryPoint(baseDir, id);
  const tempPath = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.recover-${id}`);
  const copied = Effect.gen(function* () {
    yield* removeDatabaseFiles(fs, tempPath);
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    yield* fs.copyFile(point.snapshotPath, tempPath);
    yield* fs.chmod(tempPath, 0o600);
    return yield* fs.exists(dbPath);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RecoveryPointError({
          detail: "Could not restore the recovery point's snapshot.",
          cause,
        }),
    ),
  );
  return yield* Effect.gen(function* () {
    const currentExists = yield* copied;
    const carried = yield* Effect.try({
      try: () => carryAuthState(tempPath, currentExists ? dbPath : undefined),
      catch: (cause) =>
        new RecoveryPointError({
          detail: `Could not carry the current database's revocations into the restored database: ${
            cause instanceof Error ? cause.message : String(cause)
          }.`,
          cause,
        }),
    });
    // The copy's changes must all be in its main file, the only one renamed into place.
    if (yield* fs.exists(`${tempPath}-wal`).pipe(Effect.orElseSucceed(() => true))) {
      return yield* new RecoveryPointError({
        detail: `Could not carry the current database's revocations into the restored database: ${tempPath}-wal was left behind.`,
      });
    }
    yield* fs.remove(`${tempPath}-shm`, { force: true }).pipe(Effect.ignore);
    return { path: tempPath, ...carried } satisfies PreparedRestore;
  }).pipe(Effect.tapError(() => removeDatabaseFiles(fs, tempPath)));
});

/** Removes a prepared restore that will not be put in place. */
export const discardPreparedRestore = Effect.fn("cloud.recovery_point.discard_prepared_restore")(
  function* (prepared: PreparedRestore) {
    const fs = yield* FileSystem.FileSystem;
    yield* removeDatabaseFiles(fs, prepared.path);
  },
);

/**
 * Renames a prepared restore into place at `dbPath`. Refuses while a database
 * or its -wal or -shm is still there: displace it first. A failure removes the
 * prepared copy.
 */
export const restoreSnapshot = Effect.fn("cloud.recovery_point.restore_snapshot")(function* (
  prepared: PreparedRestore,
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const fail = (cause: unknown) =>
    new RecoveryPointError({ detail: "Could not restore the recovery point's snapshot.", cause });
  yield* Effect.gen(function* () {
    for (const suffix of DATABASE_COMPANION_SUFFIXES) {
      if (yield* fs.exists(`${dbPath}${suffix}`).pipe(Effect.mapError(fail))) {
        return yield* new RecoveryPointError({
          detail: `Refusing to restore over ${dbPath}${suffix}; move the current database aside first.`,
        });
      }
    }
    yield* fs.rename(prepared.path, dbPath).pipe(Effect.mapError(fail));
  }).pipe(Effect.tapError(() => removeDatabaseFiles(fs, prepared.path)));
});
