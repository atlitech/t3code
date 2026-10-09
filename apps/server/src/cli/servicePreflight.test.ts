import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { SERVICE_LAUNCHER_PROTOCOL } from "../cloud/serviceProtocol.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { servicePreflightCommand } from "./servicePreflight.ts";

it.layer(NodeServices.layer)("t3 __service-preflight", (it) => {
  // The updater parses stdout as one JSON line; migration logs must not reach it.
  it.effect("prints only the result on stdout while migrating a copy of the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-cli-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      yield* runMigrations({ toMigrationInclusive: 53 }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
      );
      const seededStdout = (yield* TestConsole.logLines).length;
      const seededStderr = (yield* TestConsole.errorLines).length;

      yield* Command.runWith(servicePreflightCommand, { version: "0.0.0" })([
        "--database-path",
        databasePath,
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ]);

      const stdout = (yield* TestConsole.logLines).slice(seededStdout);
      assert.equal(stdout.length, 1);
      assert.deepInclude(JSON.parse(String(stdout[0])), {
        status: "ready",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      assert.isTrue(
        (yield* TestConsole.errorLines)
          .slice(seededStderr)
          .some((line) => String(line).includes("Migrations ran successfully")),
      );
    }).pipe(Effect.scoped, Effect.provide(TestConsole.layer)),
  );
});
