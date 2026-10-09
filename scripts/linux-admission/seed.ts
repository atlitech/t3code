#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes the SQL that seeds fixtures.json into a
// stopped server's statev2.sqlite, for `sqlite3 <db> < seed.sql`. The rows go
// straight into the projection tables the thread snapshot reads, with the
// column mapping the server's own projector uses.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Command, Flag } from "effect/cli";

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";

/** A SQL literal: NULL, an integer, or a single-quoted string with quotes doubled. */
export const sqlLiteral = (value: string | number | boolean | null): string => {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`not an integer: ${value}`);
    return String(value);
  }
  if (value.includes("\u0000")) throw new RangeError("a NUL byte cannot be seeded");
  return `'${value.replaceAll("'", "''")}'`;
};

const insert = (table: string, row: Record<string, string | number | boolean | null>): string =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row)
    .map(sqlLiteral)
    .join(", ")});`;

/** One transaction inserting every fixture thread and message. */
export const seedStatements = (fixtures: ReadonlyArray<FixtureThread>): string => {
  const statements = ["BEGIN IMMEDIATE;"];
  for (const { thread, messages } of fixtures) {
    statements.push(
      insert("orchestration_v2_projection_threads", {
        thread_id: thread.id,
        project_id: thread.projectId,
        title: thread.title,
        default_provider: thread.providerInstanceId,
        provider_instance_id: thread.providerInstanceId,
        runtime_mode: thread.runtimeMode,
        interaction_mode: thread.interactionMode,
        active_provider_thread_id: thread.activeProviderThreadId,
        created_at: thread.createdAt,
        updated_at: thread.updatedAt,
        archived_at: thread.archivedAt,
        deleted_at: thread.deletedAt,
        payload_json: thread.payloadJson,
      }),
    );
    for (const message of messages) {
      statements.push(
        insert("orchestration_v2_projection_messages", {
          message_id: message.id,
          thread_id: message.threadId,
          run_id: message.runId,
          node_id: message.nodeId,
          role: message.role,
          streaming: message.streaming,
          created_at: message.createdAt,
          updated_at: message.updatedAt,
          payload_json: message.payloadJson,
        }),
      );
    }
  }
  statements.push("COMMIT;");
  return `${statements.join("\n")}\n`;
};

export const writeSeed = Effect.fn("writeSeed")(function* (options: {
  readonly fixtures: string;
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const fixtures = yield* decodeFixtures(yield* fs.readFileString(options.fixtures));
  yield* fs.writeFileString(options.out, seedStatements(fixtures));
});

const command = Command.make(
  "linux-admission-seed",
  {
    fixtures: Flag.String("fixtures").pipe(Flag.withDescription("Path to fixtures.json.")),
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the seed SQL.")),
  },
  (options) => writeSeed(options),
).pipe(Command.withDescription("Write the SQL that seeds the admission fixtures."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
