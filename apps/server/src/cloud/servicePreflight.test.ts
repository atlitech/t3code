// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { runMigrations } from "../persistence/Migrations.ts";
import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const fileSha256 = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

// A database left behind by an older build: migrated part of the way, so the
// preflight has migrations left to run on its copy.
const seedOlderDatabase = (
  databasePath: string,
  prepare: Effect.Effect<void, SqlError, SqlClient.SqlClient>,
  toMigrationInclusive = 53,
) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive });
    yield* prepare;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const latestMigration = (databasePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly id: number;
    }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
    return rows[0]?.id;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));

// The running server's connection: WAL mode with checkpoints off, so what it
// commits stays in -wal until it closes with the scope.
const openLiveWriter = (databasePath: string, statements: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      database.exec(statements);
      return database;
    }),
    (database) => Effect.sync(() => database.close()),
  );

it.layer(NodeServices.layer)("runServicePreflight", (it) => {
  it.effect.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* runServicePreflight({
          databasePath: "/missing/state.sqlite",
          launcherProtocol,
          version: "1.2.3",
        }),
        {
          status: "blocked",
          version: "1.2.3",
          reason:
            "This release requires a newer T3 Code service launcher. Update it on the server machine.",
        },
      );
    }),
  );

  it.effect("is ready on a fresh install with no database yet", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* runServicePreflight({
          databasePath: "/missing/state.sqlite",
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
          version: "1.2.3",
        }),
        { status: "ready", version: "1.2.3", launcherProtocol: SERVICE_LAUNCHER_PROTOCOL },
      );
    }),
  );

  it.effect("migrates a copy of an older database and leaves the live one untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-ok-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      yield* seedOlderDatabase(databasePath, Effect.void);
      const before = fileSha256(databasePath);

      const result = yield* runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });

      assert.deepEqual(result, {
        status: "ready",
        version: "1.2.3",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      assert.equal(fileSha256(databasePath), before);
      assert.equal(yield* latestMigration(databasePath), 53);
      assert.deepEqual(yield* fs.readDirectory(directory), ["statev2.sqlite"]);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks when a migration fails on the copy, leaving the live database as it was", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-fail-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      // Migration 54 alters projection_threads; without it the copy cannot migrate.
      yield* seedOlderDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE projection_threads`;
        }),
      );
      const before = fileSha256(databasePath);

      const result = yield* runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });

      assert.equal(result.status, "blocked");
      assert.include(
        result.status === "blocked" ? result.reason : "",
        "migration of a copy of the existing database failed",
      );
      assert.equal(fileSha256(databasePath), before);
      assert.deepEqual(yield* fs.readDirectory(directory), ["statev2.sqlite"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "migrates a snapshot that includes",
      "CREATE TABLE wal_marker (value TEXT); INSERT INTO wal_marker VALUES ('wal only');",
      "ready",
    ],
    // Dropping a table migration 54 needs, in -wal only: a copy that missed
    // the -wal would migrate cleanly, so blocking proves the snapshot read it.
    ["sees, and blocks on,", "DROP TABLE projection_threads", "blocked"],
  ] as const)(
    "%s commits a running server holds only in its -wal, without writing the live files",
    ([, statement, status]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-wal-" });
        const databasePath = path.join(directory, "statev2.sqlite");
        yield* seedOlderDatabase(databasePath, Effect.void);
        const writer = yield* openLiveWriter(databasePath, statement);
        const walPath = `${databasePath}-wal`;
        assert.isAbove(NodeFS.statSync(walPath).size, 0);
        const mainBefore = fileSha256(databasePath);
        const walBefore = fileSha256(walPath);

        const result = yield* runServicePreflight({
          databasePath,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
          version: "1.2.3",
        });

        assert.equal(result.status, status, result.status === "blocked" ? result.reason : "");
        assert.equal(fileSha256(databasePath), mainBefore);
        assert.equal(fileSha256(walPath), walBefore);
        if (result.status === "blocked") {
          assert.include(result.reason, `Migration "54_`);
        }
        // The writer still sees its own commits: nothing was rolled back or lost.
        if (status === "ready") {
          assert.deepEqual(
            { ...writer.prepare("SELECT value FROM wal_marker").get() },
            { value: "wal only" },
          );
        }
      }).pipe(Effect.scoped),
  );

  it.effect("imports and migrates a copy of a legacy-only home, writing no live files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-legacy-" });
      const legacyPath = path.join(directory, "state.sqlite");
      // A V1 database: the server imports it into statev2.sqlite at startup.
      yield* seedOlderDatabase(legacyPath, Effect.void, 52);
      const before = fileSha256(legacyPath);

      const result = yield* runServicePreflight({
        databasePath: path.join(directory, "statev2.sqlite"),
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });

      assert.deepEqual(result, {
        status: "ready",
        version: "1.2.3",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      assert.equal(fileSha256(legacyPath), before);
      assert.equal(yield* latestMigration(legacyPath), 52);
      assert.deepEqual(yield* fs.readDirectory(directory), ["state.sqlite"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "a migration fails on its import",
      (legacyPath: string) =>
        // Migration 54 alters projection_threads; without it the import cannot migrate.
        seedOlderDatabase(
          legacyPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TABLE projection_threads`;
          }),
          52,
        ),
    ],
    [
      "it cannot be imported",
      (legacyPath: string) =>
        Effect.sync(() => NodeFS.writeFileSync(legacyPath, "not a sqlite database ".repeat(256))),
    ],
  ] as const)("blocks on a legacy-only home when %s, leaving it as it was", ([, seed]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-preflight-legacy-fail-",
      });
      const legacyPath = path.join(directory, "state.sqlite");
      yield* seed(legacyPath);
      const before = fileSha256(legacyPath);

      const result = yield* runServicePreflight({
        databasePath: path.join(directory, "statev2.sqlite"),
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });

      assert.equal(result.status, "blocked");
      assert.include(
        result.status === "blocked" ? result.reason : "",
        "migration of a copy of the existing database failed",
      );
      assert.equal(fileSha256(legacyPath), before);
      assert.deepEqual(yield* fs.readDirectory(directory), ["state.sqlite"]);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks on a database file it cannot open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-corrupt-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      yield* fs.writeFileString(databasePath, "not a sqlite database ".repeat(256));
      const before = fileSha256(databasePath);

      const result = yield* runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });

      assert.equal(result.status, "blocked");
      assert.equal(fileSha256(databasePath), before);
    }).pipe(Effect.scoped),
  );
});
