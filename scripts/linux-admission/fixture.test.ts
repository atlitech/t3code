// @effect-diagnostics nodeBuiltinImport:off - Reads the committed fixture database and recording.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";
import { compareReadback, type ReadbackResponse } from "./readback.ts";
import { seedStatements } from "./seed.ts";

// pre-upgrade.sqlite is a released server's database after its migrations
// and seed.ts; snapshot-response.json is what that release served for the
// fixture threads. record-fixture.sh regenerates both.
const here = import.meta.dirname;
const read = (file: string) => NodeFS.readFileSync(NodePath.join(here, file), "utf8");
const loadFixtures = decodeFixtures(read("fixtures.json"));
const recorded: ReadonlyArray<ReadbackResponse> = JSON.parse(read("snapshot-response.json"));

const TABLES = ["orchestration_v2_projection_threads", "orchestration_v2_projection_messages"];

const rowsOf = (database: NodeSqlite.DatabaseSync, table: string) =>
  database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

interface RecordedBody {
  projection: {
    thread: { title: string };
    messages: Array<{ id: string; role: string; text: string }>;
  };
}

// A copy of the recording with one thread's snapshot body changed.
const withBody = (threadId: string, change: (body: RecordedBody) => void) =>
  recorded.map((response) => {
    const copy = structuredClone(response);
    if (copy.threadId === threadId) change(copy.body as RecordedBody);
    return copy;
  });

const failedIds = (
  fixtures: ReadonlyArray<FixtureThread>,
  responses: ReadonlyArray<ReadbackResponse>,
) =>
  compareReadback(fixtures, responses)
    .items.filter((item) => !item.passed)
    .map((item) => item.id);

it.effect("the committed database holds exactly the rows seed.ts writes for fixtures.json", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const committed = new NodeSqlite.DatabaseSync(NodePath.join(here, "pre-upgrade.sqlite"), {
      readOnly: true,
    });
    const seeded = new NodeSqlite.DatabaseSync(":memory:");
    try {
      for (const table of TABLES) {
        const schema = committed
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string } | undefined;
        assert.isDefined(schema, table);
        seeded.exec(schema!.sql);
      }
      seeded.exec(seedStatements(fixtures));
      for (const table of TABLES) {
        assert.deepStrictEqual(rowsOf(committed, table), rowsOf(seeded, table), table);
      }
      const threadIds = rowsOf(committed, TABLES[0]!).map((row) => row.thread_id);
      assert.deepStrictEqual(
        threadIds,
        fixtures.map((fixture) => fixture.thread.id),
      );
      const messageIds = rowsOf(committed, TABLES[1]!).map((row) => row.message_id);
      assert.deepStrictEqual(
        messageIds,
        fixtures.flatMap((fixture) => fixture.messages.map((message) => message.id)),
      );
    } finally {
      committed.close();
      seeded.close();
    }
  }),
);

it.effect("reads every fixture thread and message back from the recorded snapshots", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadWithMessages = fixtures.find((fixture) => fixture.messages.length > 1)!;
    const result = compareReadback(fixtures, recorded);
    assert.isTrue(result.passed, JSON.stringify(result.items));
    assert.strictEqual(result.threads, fixtures.length);
    assert.isAtLeast(result.threads, 2);
    assert.isAtLeast(threadWithMessages.messages.length, 2);
    assert.strictEqual(
      result.items.length,
      fixtures.length + fixtures.reduce((count, fixture) => count + fixture.messages.length, 0),
    );
  }),
);

it.effect("fails when a seeded message is missing from its thread's snapshot", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadWithMessages = fixtures.find((fixture) => fixture.messages.length > 1)!;
    const dropped = threadWithMessages.messages[1]!.id;
    const responses = withBody(threadWithMessages.thread.id, (body) => {
      body.projection.messages = body.projection.messages.filter(
        (message) => message.id !== dropped,
      );
    });
    assert.deepStrictEqual(failedIds(fixtures, responses), [dropped]);
  }),
);

it.effect("fails when a seeded message's text or role changed", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const threadWithMessages = fixtures.find((fixture) => fixture.messages.length > 1)!;
    const [first, second] = threadWithMessages.messages;
    const responses = withBody(threadWithMessages.thread.id, (body) => {
      for (const message of body.projection.messages) {
        if (message.id === first!.id) message.text = `${message.text} (edited)`;
        if (message.id === second!.id) message.role = "system";
      }
    });
    assert.deepStrictEqual(failedIds(fixtures, responses), [first!.id, second!.id]);
  }),
);

it.effect("fails when a seeded thread is missing or renamed", () =>
  Effect.gen(function* () {
    const fixtures = yield* loadFixtures;
    const firstThread = fixtures[0]!;
    const missing = recorded.filter((response) => response.threadId !== firstThread.thread.id);
    assert.deepStrictEqual(failedIds(fixtures, missing), [
      firstThread.thread.id,
      ...firstThread.messages.map((message) => message.id),
    ]);

    const notFound = recorded.map((response) =>
      response.threadId === firstThread.thread.id ? { ...response, status: 404 } : response,
    );
    assert.isFalse(compareReadback(fixtures, notFound).passed);

    const renamed = withBody(firstThread.thread.id, (body) => {
      body.projection.thread.title = "Renamed";
    });
    assert.deepStrictEqual(failedIds(fixtures, renamed), [firstThread.thread.id]);
  }),
);
