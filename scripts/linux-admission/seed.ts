#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes the SQL that adds the fixture messages
// to the threads the prior release's server created (create-threads.ts), for
// `sqlite3 <db> < seed.sql` once that server has stopped. Messages have no
// provider-free writer, so this commits what the server's EventSink commits
// for a `message.updated`, in the prior's persisted format:
//
// - the event, appended after what the prior wrote: sequence from the
//   table's AUTOINCREMENT and stream_version continuing the thread's stream,
//   as OrchestrationEventStore.appendAgentEvents does; id, command id,
//   correlation id, actor `server`, and metadata `{"providerInstanceId"}`
//   shaped like the thread.created rows the prior wrote;
// - the projection row ProjectionStore.apply folds it into;
// - last_sequence advanced in the projection metadata row the prior wrote.
//   The schema version stays the prior's own.
//
// It fails, committing nothing, unless the prior created every thread and
// wrote its projection metadata.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  decodeFixtures,
  type FixtureMessage,
  type FixtureThread,
  threadCommandId,
} from "./fixtures.ts";

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

export interface MessageEvent {
  readonly eventId: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly message: FixtureMessage;
  readonly providerInstanceId: string;
}

/** The `message.updated` events a fixture thread's messages are seeded as, in order. */
export const messageEvents = (fixture: FixtureThread): ReadonlyArray<MessageEvent> =>
  fixture.messages.map((message) => {
    const commandId = `admission:message.updated:${message.id}`;
    return {
      // IdAllocator's event id: `event` then URI-encoded parts, where the
      // server ends with a random UUID.
      eventId: [
        "event",
        ...["thread", fixture.thread.id, "command", commandId, "0"].map(encodeURIComponent),
      ].join(":"),
      commandId,
      threadId: fixture.thread.id,
      message,
      providerInstanceId: fixture.thread.modelSelection.instanceId,
    };
  });

const encodeEventMetadata = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ providerInstanceId: Schema.String })),
);

const insertEvent = (event: MessageEvent): string =>
  `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json, application_event_version) VALUES (${[
    sqlLiteral(event.eventId),
    sqlLiteral("thread"),
    sqlLiteral(event.threadId),
    `(SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${sqlLiteral(event.threadId)})`,
    sqlLiteral("message.updated"),
    sqlLiteral(event.message.updatedAt),
    sqlLiteral(event.commandId),
    "NULL",
    sqlLiteral(event.commandId),
    sqlLiteral("server"),
    sqlLiteral(event.message.payloadJson),
    sqlLiteral(encodeEventMetadata({ providerInstanceId: event.providerInstanceId })),
    "2",
  ].join(", ")});`;

const insertMessageRow = (message: FixtureMessage): string =>
  `INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json) VALUES (${[
    message.id,
    message.threadId,
    message.runId,
    message.nodeId,
    message.role,
    message.streaming,
    message.createdAt,
    message.updatedAt,
    message.payloadJson,
  ]
    .map(sqlLiteral)
    .join(", ")});`;

// A row that only inserts when `condition` holds, so a false precondition
// aborts `sqlite3 -bail` before COMMIT.
const precondition = (condition: string): string =>
  `INSERT INTO admission_precondition (ok) SELECT ${condition};`;

/** One transaction adding every fixture message to the threads the prior created. */
export const seedStatements = (fixtures: ReadonlyArray<FixtureThread>): string => {
  const statements = [
    "BEGIN IMMEDIATE;",
    "CREATE TEMP TABLE admission_precondition (ok INTEGER CONSTRAINT admission_precondition CHECK (ok = 1));",
    precondition(
      "EXISTS (SELECT 1 FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections')",
    ),
  ];
  for (const fixture of fixtures) {
    const threadId = sqlLiteral(fixture.thread.id);
    statements.push(
      precondition(
        `EXISTS (SELECT 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.created' AND command_id = ${sqlLiteral(threadCommandId(fixture.thread.id))})`,
      ),
      precondition(
        `EXISTS (SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId})`,
      ),
    );
    for (const event of messageEvents(fixture)) {
      statements.push(insertEvent(event), insertMessageRow(event.message));
    }
  }
  const lastUpdatedAt = fixtures
    .flatMap((fixture) => fixture.messages.map((message) => message.updatedAt))
    .toSorted()
    .at(-1);
  statements.push(
    `UPDATE orchestration_v2_projection_metadata SET last_sequence = (SELECT MAX(sequence) FROM orchestration_events), updated_at = MAX(updated_at, ${sqlLiteral(lastUpdatedAt ?? "")}) WHERE projection_name = 'thread-projections';`,
    "DROP TABLE admission_precondition;",
    "COMMIT;",
  );
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
).pipe(Command.withDescription("Write the SQL that seeds the admission fixture messages."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
