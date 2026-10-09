#!/usr/bin/env node

// Fork-only (atlitech/t3code). Writes the SQL that seeds fixtures.json into a
// stopped server's statev2.sqlite, for `sqlite3 <db> < seed.sql`. It commits
// what the server's EventSink commits for the same history, in one
// transaction: the durable V2 events (OrchestrationEventStore.appendAgentEvents),
// the projection rows ProjectionStore.apply folds them into, and the
// projection metadata's last_sequence.
//
// The event rows match what a released server wrote for a dispatched
// `thread.create` (event id `event:thread:<thread>:command:<command>:<suffix>`,
// stream_version from 0, command and correlation id the command, actor
// `server`, metadata `{"providerInstanceId": ...}`, payload in schema order).
// Messages are seeded as `message.updated` events the same way; a real
// conversation would also carry runs and turn items from a provider, which
// the admission does not have.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";

/** ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, which EventSink stamps on every commit. */
export const PROJECTION_SCHEMA_VERSION = 2;

export interface FixtureEvent {
  readonly eventId: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly type: "thread.created" | "message.updated";
  /** The message this event carries; undefined for thread.created. */
  readonly messageId: string | undefined;
  readonly occurredAt: string;
  readonly payloadJson: string;
  readonly providerInstanceId: string;
}

const eventFor = (
  subject: string,
  event: Omit<FixtureEvent, "eventId" | "commandId">,
): FixtureEvent => {
  const commandId = `admission:${event.type}:${subject}`;
  return { ...event, commandId, eventId: `event:thread:${event.threadId}:command:${commandId}:0` };
};

/** The durable events a fixture thread is seeded with, in commit order. */
export const fixtureEvents = (fixture: FixtureThread): ReadonlyArray<FixtureEvent> => [
  eventFor(fixture.thread.id, {
    threadId: fixture.thread.id,
    type: "thread.created",
    messageId: undefined,
    occurredAt: fixture.thread.createdAt,
    payloadJson: fixture.thread.payloadJson,
    providerInstanceId: fixture.thread.providerInstanceId,
  }),
  ...fixture.messages.map((message) =>
    eventFor(message.id, {
      threadId: fixture.thread.id,
      type: "message.updated",
      messageId: message.id,
      occurredAt: message.updatedAt,
      payloadJson: message.payloadJson,
      providerInstanceId: fixture.thread.providerInstanceId,
    }),
  ),
];

const encodeEventMetadata = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ providerInstanceId: Schema.String })),
);

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

// stream_version continues the stream the way appendAgentEvents does.
const insertEvent = (event: FixtureEvent): string =>
  `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json, application_event_version) VALUES (${[
    sqlLiteral(event.eventId),
    sqlLiteral("thread"),
    sqlLiteral(event.threadId),
    `COALESCE((SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${sqlLiteral(event.threadId)}), 0)`,
    sqlLiteral(event.type),
    sqlLiteral(event.occurredAt),
    sqlLiteral(event.commandId),
    "NULL",
    sqlLiteral(event.commandId),
    sqlLiteral("server"),
    sqlLiteral(event.payloadJson),
    sqlLiteral(encodeEventMetadata({ providerInstanceId: event.providerInstanceId })),
    "2",
  ].join(", ")});`;

/**
 * One transaction with every fixture event, the projection rows they fold
 * into, and the projection metadata pointing at the last event.
 */
export const seedStatements = (fixtures: ReadonlyArray<FixtureThread>): string => {
  const statements = ["BEGIN IMMEDIATE;"];
  for (const fixture of fixtures) {
    const { thread, messages } = fixture;
    statements.push(...fixtureEvents(fixture).map(insertEvent));
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
  const lastOccurredAt = fixtures
    .flatMap((fixture) => fixtureEvents(fixture).map((event) => event.occurredAt))
    .toSorted()
    .at(-1)!;
  statements.push(
    `INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version, last_sequence, updated_at) VALUES ('thread-projections', ${PROJECTION_SCHEMA_VERSION}, (SELECT MAX(sequence) FROM orchestration_events), ${sqlLiteral(lastOccurredAt)}) ON CONFLICT(projection_name) DO UPDATE SET schema_version = excluded.schema_version, last_sequence = excluded.last_sequence, updated_at = excluded.updated_at;`,
  );
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
