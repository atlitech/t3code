// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

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
) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 53 });
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
