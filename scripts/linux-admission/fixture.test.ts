// @effect-diagnostics nodeBuiltinImport:off - Reads the committed fixture database and recording.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";
import { compareReadback, type ReadbackResponse, type SeededEvent } from "./readback.ts";
import { fixtureEvents, seedStatements } from "./seed.ts";

// pre-upgrade.sqlite is a released server's database after its migrations
// and seed.ts; snapshot-response.json is what readback.ts read from that
// release afterwards: the seeded event rows, the thread snapshots, and the
// event replays. record-fixture.sh regenerates both.
const here = import.meta.dirname;
const read = (file: string) => NodeFS.readFileSync(NodePath.join(here, file), "utf8");
const loadFixtures = decodeFixtures(read("fixtures.json"));

const EVENTS = "orchestration_events";
const THREADS = "orchestration_v2_projection_threads";
const MESSAGES = "orchestration_v2_projection_messages";
const METADATA = "orchestration_v2_projection_metadata";

type Row = Record<string, unknown>;

const rowsOf = (database: NodeSqlite.DatabaseSync, table: string): Array<Row> =>
  database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Row>;

const withCommitted = <A>(use: (database: NodeSqlite.DatabaseSync) => A): A => {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(here, "pre-upgrade.sqlite"), {
    readOnly: true,
  });
  try {
    return use(database);
  } finally {
    database.close();
  }
};

interface RecordedSnapshot {
  snapshotSequence: number;
  projection: {
    thread: { title: string };
    messages: Array<{ id: string; role: string; text: string }>;
  };
}

interface RecordedEvent {
  kind: string;
  sequence: number;
  event: { id: string; payload: { text?: string } };
}

// The recording, mutable so a test can change a copy of it.
interface RecordedObservation {
  seededEvents: Array<SeededEvent>;
  snapshots: Array<ReadbackResponse>;
  replays: Array<{
    threadId: string;
    afterSequence: number;
    synchronized: boolean;
    values: Array<RecordedEvent>;
  }>;
}
const recorded: RecordedObservation = JSON.parse(read("snapshot-response.json"));

const changed = (change: (observation: RecordedObservation) => void): RecordedObservation => {
  const copy = structuredClone(recorded);
  change(copy);
  return copy;
};
const snapshotOf = (observation: RecordedObservation, threadId: string) =>
  observation.snapshots.find((response) => response.threadId === threadId)!
    .body as RecordedSnapshot;
const replayOf = (observation: RecordedObservation, threadId: string) =>
  observation.replays.find((replay) => replay.threadId === threadId)!;

const failedIds = (fixtures: ReadonlyArray<FixtureThread>, observation: RecordedObservation) =>
  compareReadback(fixtures, observation)
    .items.filter((item) => !item.passed)
    .map((item) => item.id);

const withMessages = (fixtures: ReadonlyArray<FixtureThread>) =>
  fixtures.find((fixture) => fixture.messages.length > 1)!;

it.effect("the committed database holds exactly the events and rows seed.ts writes", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    withCommitted((committed) => {
      const seeded = new NodeSqlite.DatabaseSync(":memory:");
      try {
        for (const table of [EVENTS, THREADS, MESSAGES, METADATA]) {
          const schema = committed
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as { sql: string } | undefined;
          assert.isDefined(schema, table);
          seeded.exec(schema!.sql);
        }
        // What the migrations leave before any event is written.
        seeded.exec(
          `INSERT INTO ${METADATA} VALUES ('thread-projections', 1, 0, '2026-01-01T00:00:00.000Z')`,
        );
        seeded.exec(seedStatements(fixtures));
        for (const table of [EVENTS, THREADS, MESSAGES, METADATA]) {
          assert.deepStrictEqual(rowsOf(committed, table), rowsOf(seeded, table), table);
        }
      } finally {
        seeded.close();
      }
    });
  }),
);

it.effect("the committed events are the fixture history and fold into its projections", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    withCommitted((committed) => {
      const events = rowsOf(committed, EVENTS);
      const expected = fixtures.flatMap(fixtureEvents);
      assert.deepStrictEqual(
        events.map((event) => [event.event_id, event.event_type, event.stream_id]),
        expected.map((event) => [event.eventId, event.type, event.threadId]),
      );
      for (const fixture of fixtures) {
        const stream = events.filter((event) => event.stream_id === fixture.thread.id);
        assert.deepStrictEqual(
          stream.map((event) => event.stream_version),
          stream.map((_, index) => index),
          fixture.thread.id,
        );
      }
      for (const event of events) {
        assert.strictEqual(event.application_event_version, 2);
        assert.strictEqual(event.aggregate_kind, "thread");
      }
      // Each projection row is its event's payload, as ProjectionStore.apply writes it.
      const payloadOf = (eventType: string, id: string) =>
        events.find(
          (event) =>
            event.event_type === eventType &&
            (JSON.parse(event.payload_json as string) as { id: string }).id === id,
        )?.payload_json;
      for (const row of rowsOf(committed, THREADS)) {
        assert.strictEqual(row.payload_json, payloadOf("thread.created", row.thread_id as string));
      }
      for (const row of rowsOf(committed, MESSAGES)) {
        assert.strictEqual(
          row.payload_json,
          payloadOf("message.updated", row.message_id as string),
        );
      }
      const [metadata] = rowsOf(committed, METADATA);
      assert.strictEqual(metadata!.last_sequence, events.at(-1)!.sequence);
    });
  }),
);

it.effect("reads every fixture thread, message, and event back from the recording", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const result = compareReadback(fixtures, recorded);
    assert.isTrue(result.passed, JSON.stringify(result.items.filter((item) => !item.passed)));
    assert.isAtLeast(result.threads, 2);
    assert.isAtLeast(withMessages(fixtures).messages.length, 2);
    assert.strictEqual(result.events, fixtures.flatMap(fixtureEvents).length);
    const counts = (kind: string) => result.items.filter((item) => item.kind === kind).length;
    assert.strictEqual(counts("thread"), result.threads);
    assert.strictEqual(counts("message"), result.messages);
    // Every event, and one history-coverage item per thread.
    assert.strictEqual(counts("event"), result.events + result.threads);
  }),
);

it.effect("fails when a seeded message is missing from its thread's snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const dropped = thread.messages[1]!.id;
    const observation = changed((copy) => {
      const body = snapshotOf(copy, thread.thread.id);
      body.projection.messages = body.projection.messages.filter(
        (message) => message.id !== dropped,
      );
    });
    assert.deepStrictEqual(failedIds(fixtures, observation), [dropped]);
  }),
);

it.effect("fails when a seeded message's text or role changed in the snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const [first, second] = thread.messages;
    const observation = changed((copy) => {
      for (const message of snapshotOf(copy, thread.thread.id).projection.messages) {
        if (message.id === first!.id) message.text = `${message.text} (edited)`;
        if (message.id === second!.id) message.role = "system";
      }
    });
    assert.deepStrictEqual(failedIds(fixtures, observation), [first!.id, second!.id]);
  }),
);

it.effect("fails when a seeded thread is missing or renamed", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const first = fixtures[0]!;
    const missing = changed((copy) => {
      copy.snapshots = copy.snapshots.filter((response) => response.threadId !== first.thread.id);
    });
    assert.deepStrictEqual(failedIds(fixtures, missing), [
      first.thread.id,
      ...first.messages.map((message) => message.id),
      `${first.thread.id}:history`,
    ]);

    const renamed = changed((copy) => {
      snapshotOf(copy, first.thread.id).projection.thread.title = "Renamed";
    });
    assert.deepStrictEqual(failedIds(fixtures, renamed), [first.thread.id]);
  }),
);

it.effect("fails when a seeded event is missing from the durable log", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const [created, message] = fixtureEvents(withMessages(fixtures));
    for (const dropped of [created!, message!]) {
      const observation = changed((copy) => {
        copy.seededEvents = copy.seededEvents.filter((event) => event.event_id !== dropped.eventId);
      });
      assert.include(failedIds(fixtures, observation), dropped.eventId, dropped.type);
    }
  }),
);

it.effect("fails when the candidate does not replay a seeded message event intact", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const [, first, second, third] = fixtureEvents(thread);
    const observation = changed((copy) => {
      const replay = replayOf(copy, thread.thread.id);
      replay.values = replay.values.filter((value) => value.event.id !== first!.eventId);
      for (const value of replay.values) {
        if (value.event.id === second!.eventId) value.sequence += 100;
        if (value.event.id === third!.eventId) value.event.payload.text = "rewritten";
      }
    });
    assert.deepStrictEqual(failedIds(fixtures, observation), [
      first!.eventId,
      second!.eventId,
      third!.eventId,
    ]);
  }),
);

it.effect("fails when the history is not covered: an unfinished replay or a stale snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadId = fixtures[0]!.thread.id;
    const unfinished = changed((copy) => {
      replayOf(copy, threadId).synchronized = false;
    });
    assert.deepStrictEqual(failedIds(fixtures, unfinished), [`${threadId}:history`]);

    const stale = changed((copy) => {
      snapshotOf(copy, threadId).snapshotSequence = 0;
    });
    assert.deepStrictEqual(failedIds(fixtures, stale), [`${threadId}:history`]);
  }),
);
