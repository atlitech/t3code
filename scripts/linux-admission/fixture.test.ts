// @effect-diagnostics nodeBuiltinImport:off - Reads the committed fixture database and recording.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { threadCreateCommand } from "./create-threads.ts";
import { decodeFixtures, expectedThread, type FixtureThread, threadCommandId } from "./fixtures.ts";
import {
  compareReadback,
  type ReadbackResponse,
  type ReadbackStage,
  type SeededEvent,
} from "./readback.ts";
import { messageEvents, seedStatements } from "./seed.ts";

// pre-upgrade.sqlite is the database a released server left after it created
// the fixture threads itself, seed.ts appended the messages, and it read them
// all back; snapshot-response.json is what readback.ts then read from the
// same release at the `upgraded` stage. record-fixture.sh regenerates both.
const here = import.meta.dirname;
const read = (file: string) => NodeFS.readFileSync(NodePath.join(here, file), "utf8");
const loadFixtures = decodeFixtures(read("fixtures.json"));

const EVENTS = "orchestration_events";
const THREADS = "orchestration_v2_projection_threads";
const MESSAGES = "orchestration_v2_projection_messages";
const METADATA = "orchestration_v2_projection_metadata";

type Row = Record<string, unknown>;

const rowsOf = (database: NodeSqlite.DatabaseSync, table: string, where = "1"): Array<Row> =>
  database.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all() as Array<Row>;

const withDatabase = <A>(
  path: string,
  options: NodeSqlite.DatabaseSyncOptions,
  use: (database: NodeSqlite.DatabaseSync) => A,
): A => {
  const database = new NodeSqlite.DatabaseSync(path, options);
  try {
    return use(database);
  } finally {
    database.close();
  }
};
const withCommitted = <A>(use: (database: NodeSqlite.DatabaseSync) => A): A =>
  withDatabase(NodePath.join(here, "pre-upgrade.sqlite"), { readOnly: true }, use);

// A scratch database holding what the prior had written before seed.ts ran:
// its tables, its own thread.created events and thread rows, and its
// projection metadata as of those events.
const withPriorBeforeSeed = <A>(
  fixtures: ReadonlyArray<FixtureThread>,
  options: { readonly created: boolean; readonly metadata: boolean },
  use: (database: NodeSqlite.DatabaseSync) => A,
): A =>
  withCommitted((committed) =>
    withDatabase(":memory:", {}, (scratch) => {
      for (const table of [EVENTS, THREADS, MESSAGES, METADATA]) {
        const schema = committed
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string };
        scratch.exec(schema.sql);
      }
      const copy = (table: string, rows: ReadonlyArray<Row>) => {
        for (const row of rows) {
          const columns = Object.keys(row);
          scratch
            .prepare(
              `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            )
            .run(...(Object.values(row) as Array<NodeSqlite.SQLInputValue>));
        }
      };
      const createdIds = fixtures.map((fixture) => `'${threadCommandId(fixture.thread.id)}'`);
      const created = rowsOf(committed, EVENTS, `command_id IN (${createdIds.join(", ")})`);
      if (options.created) {
        copy(EVENTS, created);
        copy(THREADS, rowsOf(committed, THREADS));
      }
      if (options.metadata) {
        const [metadata] = rowsOf(committed, METADATA);
        copy(METADATA, [{ ...metadata, last_sequence: created.at(-1)!.sequence }]);
      }
      return use(scratch);
    }),
  );

it.effect("the prior wrote each fixture thread's thread.created itself", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    withCommitted((committed) => {
      for (const { thread } of fixtures) {
        const rows = rowsOf(
          committed,
          EVENTS,
          `stream_id = '${thread.id}' AND event_type = 'thread.created'`,
        );
        assert.strictEqual(rows.length, 1, thread.id);
        const [row] = rows;
        assert.strictEqual(row!.command_id, threadCreateCommand(thread).commandId);
        assert.strictEqual(row!.stream_version, 0);
        assert.strictEqual(row!.application_event_version, 2);
        // The server's own id: URI-encoded parts ending in a UUID it chose.
        assert.match(
          row!.event_id as string,
          new RegExp(
            `^event:thread:${thread.id}:command:${encodeURIComponent(threadCommandId(thread.id))}:[0-9a-f-]{36}$`,
          ),
        );
        const payload = JSON.parse(row!.payload_json as string);
        for (const [key, value] of Object.entries(expectedThread(thread))) {
          assert.deepStrictEqual(payload[key], value, `${thread.id}.${key}`);
        }
        const [projection] = rowsOf(committed, THREADS, `thread_id = '${thread.id}'`);
        assert.isDefined(projection, thread.id);
      }
    });
  }),
);

it.effect("seed.ts appends exactly the committed message events and rows after the prior's", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const expected = fixtures.flatMap(messageEvents);
    const messageFilter = `event_type = 'message.updated'`;
    withCommitted((committed) =>
      withPriorBeforeSeed(fixtures, { created: true, metadata: true }, (scratch) => {
        const [before] = rowsOf(scratch, METADATA);
        scratch.exec(seedStatements(fixtures));
        assert.deepStrictEqual(
          rowsOf(scratch, EVENTS, messageFilter),
          rowsOf(committed, EVENTS, messageFilter),
        );
        assert.deepStrictEqual(rowsOf(scratch, MESSAGES), rowsOf(committed, MESSAGES));
        assert.deepStrictEqual(
          rowsOf(committed, EVENTS, messageFilter).map((row) => row.event_id),
          expected.map((event) => event.eventId),
        );
        // Each message continues its thread's stream after the prior's creation.
        for (const fixture of fixtures) {
          const versions = rowsOf(committed, EVENTS, `stream_id = '${fixture.thread.id}'`)
            .filter((row) => row.event_type !== "thread.settled")
            .map((row) => row.stream_version);
          assert.deepStrictEqual(
            versions,
            versions.map((_, index) => index),
            fixture.thread.id,
          );
        }
        // last_sequence advanced; the schema version is the prior's own.
        const [after] = rowsOf(scratch, METADATA);
        assert.strictEqual(after!.schema_version, before!.schema_version);
        assert.strictEqual(after!.last_sequence, expected.length + fixtures.length);
      }),
    );
  }),
);

it.effect("seed.ts commits nothing unless the prior created every thread and its metadata", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    for (const missing of [
      { created: false, metadata: true },
      { created: true, metadata: false },
    ]) {
      withPriorBeforeSeed(fixtures, missing, (scratch) => {
        assert.throws(() => scratch.exec(seedStatements(fixtures)), /admission_precondition/);
        scratch.exec("ROLLBACK");
        assert.deepStrictEqual(rowsOf(scratch, MESSAGES), [], JSON.stringify(missing));
      });
    }
  }),
);

interface RecordedSnapshot {
  snapshotSequence: number;
  projection: { thread: Row; messages: Array<Row> };
}
interface RecordedReplayEvent {
  kind: string;
  sequence: number;
  event: { id: string; payload: Row };
}
// The recording, mutable so a test can change a copy of it.
interface RecordedObservation {
  seededEvents: Array<SeededEvent>;
  snapshots: Array<ReadbackResponse>;
  threadReplays: Array<{
    threadId: string;
    afterSequence: number;
    synchronized: boolean;
    values: Array<RecordedReplayEvent>;
  }>;
  shellReplay: { afterSequence: number; synchronized: boolean; values: Array<Row> };
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
  observation.threadReplays.find((replay) => replay.threadId === threadId)!;
const shellThreadOf = (observation: RecordedObservation, threadId: string) =>
  observation.shellReplay.values
    .map((value) => value.thread as Row | undefined)
    .findLast((thread) => thread?.id === threadId)!;

const failedIds = (
  fixtures: ReadonlyArray<FixtureThread>,
  observation: RecordedObservation,
  stage: ReadbackStage = "upgraded",
) =>
  compareReadback(fixtures, observation, stage)
    .items.filter((item) => !item.passed)
    .map((item) => item.id);

const withMessages = (fixtures: ReadonlyArray<FixtureThread>) =>
  fixtures.find((fixture) => fixture.messages.length > 1)!;

it.effect("reads every fixture thread, message, and event back from the recording", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const result = compareReadback(fixtures, recorded, "upgraded");
    assert.isTrue(result.passed, JSON.stringify(result.items.filter((item) => !item.passed)));
    assert.isAtLeast(result.threads, 2);
    assert.isAtLeast(withMessages(fixtures).messages.length, 2);
    const counts = (kind: string) => result.items.filter((item) => item.kind === kind).length;
    assert.strictEqual(counts("thread"), fixtures.length);
    // Each message, plus one message-order item per thread.
    assert.strictEqual(
      counts("message"),
      fixtures.flatMap((fixture) => fixture.messages).length + fixtures.length,
    );
    // A thread.created and each message.updated, plus coverage and replay items, per thread.
    assert.strictEqual(counts("event"), result.events + 2 * fixtures.length);
  }),
);

it.effect("expects messages from the seeded stage on, and the event log only after upgrade", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const withoutMessages = changed((copy) => {
      for (const response of copy.snapshots) {
        (response.body as RecordedSnapshot).projection.messages = [];
      }
      copy.threadReplays = [];
    });
    assert.deepStrictEqual(failedIds(fixtures, withoutMessages, "created"), []);
    assert.deepStrictEqual(
      failedIds(fixtures, withoutMessages, "seeded"),
      fixtures.flatMap((fixture) => [
        ...fixture.messages.map((message) => message.id),
        `${fixture.thread.id}:message-order`,
      ]),
    );
    assert.strictEqual(compareReadback(fixtures, recorded, "seeded").events, 0);
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
    assert.deepStrictEqual(failedIds(fixtures, observation), [
      dropped,
      `${thread.thread.id}:message-order`,
    ]);
  }),
);

it.effect("fails when any field of a seeded message changed in the snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["text", "edited"],
      ["role", "system"],
      ["createdBy", "system"],
      ["creationSource", "mcp"],
      ["attachments", [{ type: "image" }]],
      ["streaming", true],
      ["runId", "run-1"],
      ["createdAt", "2020-01-01T00:00:00.000Z"],
    ];
    for (const [field, value] of mutations) {
      const target = thread.messages[0]!.id;
      const observation = changed((copy) => {
        const message = snapshotOf(copy, thread.thread.id).projection.messages.find(
          (candidate) => candidate.id === target,
        )!;
        message[field] = value;
      });
      assert.deepStrictEqual(failedIds(fixtures, observation), [target], field);
    }
  }),
);

it.effect("fails when any configuration field of a thread changed in the snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadId = fixtures[0]!.thread.id;
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["title", "Renamed"],
      ["projectId", "another-project"],
      ["providerInstanceId", "claudeAgent"],
      ["modelSelection", { instanceId: "codex", model: "another-model" }],
      ["runtimeMode", "approval-required"],
      ["interactionMode", "plan"],
      ["branch", "main"],
      ["worktreePath", "/tmp/worktree"],
      ["lineage", { parentThreadId: "x", relationshipToParent: "fork", rootThreadId: "x" }],
      ["createdBy", "agent"],
      ["creationSource", "mcp"],
      ["createdAt", "2020-01-01T00:00:00.000Z"],
      ["archivedAt", "2020-01-01T00:00:00.000Z"],
      ["deletedAt", "2020-01-01T00:00:00.000Z"],
    ];
    for (const [field, value] of mutations) {
      const observation = changed((copy) => {
        snapshotOf(copy, threadId).projection.thread[field] = value;
      });
      // It no longer matches the fixture, nor the thread the prior's log records.
      assert.deepStrictEqual(
        failedIds(fixtures, observation),
        [threadId, `${threadId}:thread.created`],
        field,
      );
    }
  }),
);

it.effect("fails when a seeded thread is missing from the snapshots", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const first = fixtures[0]!;
    const missing = changed((copy) => {
      copy.snapshots = copy.snapshots.filter((response) => response.threadId !== first.thread.id);
    });
    assert.deepStrictEqual(failedIds(fixtures, missing), [
      first.thread.id,
      ...first.messages.map((message) => message.id),
      `${first.thread.id}:message-order`,
      `${first.thread.id}:thread.created`,
      `${first.thread.id}:history`,
    ]);
  }),
);

it.effect("fails when the prior's thread.created or a seeded event is missing from the log", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const withoutCreated = changed((copy) => {
      copy.seededEvents = copy.seededEvents.filter(
        (event) => event.command_id !== threadCommandId(thread.thread.id),
      );
    });
    const createdFailures = failedIds(fixtures, withoutCreated);
    assert.include(createdFailures, thread.thread.id);
    assert.include(createdFailures, `${thread.thread.id}:thread.created`);

    const [message] = messageEvents(thread);
    const withoutMessage = changed((copy) => {
      copy.seededEvents = copy.seededEvents.filter((event) => event.event_id !== message!.eventId);
    });
    // Its replay is then an event the log does not hold.
    assert.deepStrictEqual(failedIds(fixtures, withoutMessage), [
      message!.eventId,
      `${thread.thread.id}:replay`,
    ]);
  }),
);

it.effect("fails when the candidate's shell resume did not decode or keep the thread", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadId = fixtures[1]!.thread.id;
    const created = `${threadId}:thread.created`;
    const reconfigured = changed((copy) => {
      shellThreadOf(copy, threadId).modelSelection = { instanceId: "codex", model: "other" };
    });
    assert.deepStrictEqual(failedIds(fixtures, reconfigured), [created]);

    const unfinished = changed((copy) => {
      copy.shellReplay.synchronized = false;
    });
    assert.deepStrictEqual(
      failedIds(fixtures, unfinished),
      fixtures.map((fixture) => `${fixture.thread.id}:thread.created`),
    );

    const dropped = changed((copy) => {
      copy.shellReplay.values = copy.shellReplay.values.filter(
        (value) => (value.thread as Row | undefined)?.id !== threadId,
      );
    });
    assert.deepStrictEqual(failedIds(fixtures, dropped), [created]);
  }),
);

it.effect("fails when the candidate's thread differs from the one the prior's log records", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadId = fixtures[0]!.thread.id;
    const created = `${threadId}:thread.created`;
    // Fields fixtures.json does not set: only the logged thread.created and
    // thread.settled payloads say what they hold.
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["updatedAt", "2020-01-01T00:00:00.000Z"],
      ["settledOverride", null],
      ["settledAt", "2020-01-01T00:00:00.000Z"],
      ["snoozedUntil", "2020-01-01T00:00:00.000Z"],
      ["lastVisitedAt", "2020-01-01T00:00:00.000Z"],
    ];
    for (const [field, value] of mutations) {
      const inShell = changed((copy) => {
        shellThreadOf(copy, threadId)[field] = value;
      });
      assert.deepStrictEqual(failedIds(fixtures, inShell), [created], `shell ${field}`);
      const inSnapshot = changed((copy) => {
        snapshotOf(copy, threadId).projection.thread[field] = value;
      });
      assert.deepStrictEqual(failedIds(fixtures, inSnapshot), [created], `snapshot ${field}`);
    }

    // The candidate is unchanged, but the log the prior left says otherwise.
    // thread.settled carries the whole thread, so its record is what the
    // candidate's thread must hold.
    const loggedSettled = changed((copy) => {
      copy.seededEvents = copy.seededEvents.map((event) =>
        event.stream_id === threadId && event.event_type === "thread.settled"
          ? {
              ...event,
              payload_json: JSON.stringify({
                ...JSON.parse(event.payload_json),
                settledAt: "2020-01-01T00:00:00.000Z",
              }),
            }
          : event,
      );
    });
    // The replayed thread.settled no longer matches its row either.
    assert.deepStrictEqual(failedIds(fixtures, loggedSettled), [created, `${threadId}:replay`]);
  }),
);

it.effect("fails when a replayed event's contents differ from its logged row", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const threadId = thread.thread.id;
    const replayItem = `${threadId}:replay`;
    const settledOf = (copy: RecordedObservation) =>
      replayOf(copy, threadId).values.find(
        (value) => (value.event as { type?: string }).type === "thread.settled",
      )!;
    const settledMutations: ReadonlyArray<readonly [string, (value: RecordedReplayEvent) => void]> =
      [
        ["settledAt", (value) => (value.event.payload.settledAt = "2020-01-01T00:00:00.000Z")],
        ["settledOverride", (value) => (value.event.payload.settledOverride = null)],
        ["title", (value) => (value.event.payload.title = "Renamed")],
        ["unexpected field", (value) => (value.event.payload.unexpected = true)],
        ["dropped field", (value) => delete value.event.payload.updatedAt],
        ["id", (value) => (value.event.id = "another-event")],
        ["threadId", (value) => ((value.event as { threadId?: string }).threadId = "another")],
      ];
    for (const [name, mutate] of settledMutations) {
      const observation = changed((copy) => mutate(settledOf(copy)));
      assert.deepStrictEqual(failedIds(fixtures, observation), [replayItem], name);
    }

    const incomplete = changed((copy) => {
      delete (settledOf(copy).event as { payload?: Row }).payload;
    });
    assert.include(
      compareReadback(fixtures, incomplete, "upgraded").items.find(
        (entry) => entry.id === replayItem,
      )!.detail,
      "replayed without its threadId or payload",
    );

    // A message event with a field its logged row does not hold.
    const [message] = messageEvents(thread);
    const extraField = changed((copy) => {
      const value = replayOf(copy, threadId).values.find(
        (candidate) => candidate.event.id === message!.eventId,
      )!;
      value.event.payload.unexpected = true;
    });
    assert.deepStrictEqual(failedIds(fixtures, extraField), [replayItem]);
  }),
);

it.effect("fails when the candidate does not replay a seeded message event intact", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const [first, second, third, fourth] = messageEvents(thread);
    const observation = changed((copy) => {
      const replay = replayOf(copy, thread.thread.id);
      replay.values = replay.values.filter((value) => value.event.id !== first!.eventId);
      for (const value of replay.values) {
        if (value.event.id === second!.eventId) value.sequence += 100;
        if (value.event.id === third!.eventId) value.event.payload.text = "rewritten";
        if (value.event.id === fourth!.eventId) value.event.payload.creationSource = "mcp";
      }
    });
    // The dropped and the moved event also leave the replay incomplete.
    assert.deepStrictEqual(failedIds(fixtures, observation), [
      first!.eventId,
      second!.eventId,
      third!.eventId,
      fourth!.eventId,
      `${thread.thread.id}:replay`,
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

it.effect("fails unless the candidate replays exactly the events the prior logged", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const threadId = thread.thread.id;
    const replayItem = `${threadId}:replay`;
    const messageIds = new Set(messageEvents(thread).map((event) => event.eventId));
    const lastLogged = Math.max(...recorded.seededEvents.map((event) => event.sequence));
    const nonMessage = replayOf(recorded, threadId).values.filter(
      (value) => !messageIds.has(value.event.id) && value.sequence <= lastLogged,
    );
    // The prior's own thread.settled, written on its second start, is among them.
    assert.isTrue(
      nonMessage.some((value) => (value.event as { type?: string }).type === "thread.settled"),
    );
    for (const dropped of nonMessage) {
      const observation = changed((copy) => {
        const replay = replayOf(copy, threadId);
        replay.values = replay.values.filter((value) => value.sequence !== dropped.sequence);
      });
      assert.deepStrictEqual(failedIds(fixtures, observation), [replayItem], dropped.event.id);
    }

    // Every recorded thread.settled dropped at once.
    const unsettled = changed((copy) => {
      for (const replay of copy.threadReplays) {
        replay.values = replay.values.filter(
          (value) => (value.event as { type?: string }).type !== "thread.settled",
        );
      }
    });
    assert.deepStrictEqual(
      failedIds(fixtures, unsettled),
      fixtures.map((fixture) => `${fixture.thread.id}:replay`),
    );

    const retyped = changed((copy) => {
      const value = replayOf(copy, threadId).values.find(
        (candidate) => candidate.sequence === nonMessage[0]!.sequence,
      )!;
      (value.event as { type?: string }).type = "thread.archived";
    });
    assert.deepStrictEqual(failedIds(fixtures, retyped), [replayItem]);

    const created = recorded.seededEvents.find(
      (event) => event.command_id === threadCommandId(threadId),
    )!;
    // An event at or below the log's end that the prior never wrote for this thread.
    const foreign = recorded.seededEvents.find(
      (event) => event.stream_id !== threadId && event.sequence > created.sequence,
    )!;
    const extra = changed((copy) => {
      replayOf(copy, threadId).values.push({
        kind: "event",
        sequence: foreign.sequence,
        event: {
          id: "unexpected",
          payload: {},
          type: "thread.archived",
        } as RecordedReplayEvent["event"],
      });
    });
    assert.deepStrictEqual(failedIds(fixtures, extra), [replayItem]);

    // The candidate's own later writes are allowed, and reported.
    const appended = changed((copy) => {
      replayOf(copy, threadId).values.push({
        kind: "event",
        sequence: lastLogged + 1,
        event: { id: "later", payload: {}, type: "thread.visited" } as RecordedReplayEvent["event"],
      });
    });
    const result = compareReadback(fixtures, appended, "upgraded");
    assert.isTrue(result.passed);
    assert.include(
      result.items.find((entry) => entry.id === replayItem)!.detail,
      `${lastLogged + 1} (thread.visited)`,
    );
  }),
);

it.effect("fails when the snapshot lists the fixture messages out of the server's order", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const orderItem = `${thread.thread.id}:message-order`;
    const reversed = changed((copy) => {
      snapshotOf(copy, thread.thread.id).projection.messages.reverse();
    });
    assert.deepStrictEqual(failedIds(fixtures, reversed), [orderItem]);
    // The prior's own read-back is held to the same order.
    assert.deepStrictEqual(failedIds(fixtures, reversed, "seeded"), [orderItem]);

    const swapped = changed((copy) => {
      const messages = snapshotOf(copy, thread.thread.id).projection.messages;
      [messages[0], messages[1]] = [messages[1]!, messages[0]!];
    });
    assert.deepStrictEqual(failedIds(fixtures, swapped), [orderItem]);

    const repeated = changed((copy) => {
      const messages = snapshotOf(copy, thread.thread.id).projection.messages;
      messages.push(messages[0]!);
    });
    assert.deepStrictEqual(failedIds(fixtures, repeated), [orderItem]);
  }),
);

it.effect("fails when the candidate's replay arrives out of order or repeats an event", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const thread = withMessages(fixtures);
    const replayItem = `${thread.thread.id}:replay`;
    const reversed = changed((copy) => {
      replayOf(copy, thread.thread.id).values.reverse();
    });
    assert.deepStrictEqual(failedIds(fixtures, reversed), [replayItem]);

    const swapped = changed((copy) => {
      const values = replayOf(copy, thread.thread.id).values;
      [values[1], values[2]] = [values[2]!, values[1]!];
    });
    assert.deepStrictEqual(failedIds(fixtures, swapped), [replayItem]);

    const duplicated = changed((copy) => {
      const values = replayOf(copy, thread.thread.id).values;
      values.splice(1, 0, structuredClone(values[0]!));
    });
    assert.deepStrictEqual(failedIds(fixtures, duplicated), [replayItem]);
  }),
);
