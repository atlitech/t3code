#!/usr/bin/env node

// Fork-only (atlitech/t3code). Reads every fixture thread back through a
// running candidate and compares it with fixtures.json: the upgrade checks of
// the Linux admission (run-admission.sh).
//
// - readback: GET /api/orchestration/threads/:threadId serves each seeded
//   thread and message from the candidate's projections.
// - event-log: every seeded event is in the prior's durable log, the snapshot
//   covers it, and the candidate decodes and replays each seeded message
//   event from that log over the same orchestration.subscribeThread resume
//   clients use (`afterSequence`), with its sequence and content intact.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";
import { fixtureEvents } from "./seed.ts";

/** One GET /api/orchestration/threads/:threadId, as the candidate answered it. */
export interface ReadbackResponse {
  readonly threadId: string;
  readonly status: number;
  readonly body: unknown;
}

/** One event row of the seeded log, as `sqlite3 -json` reads it before the upgrade. */
export interface SeededEvent {
  readonly sequence: number;
  readonly event_id: string;
  readonly stream_id: string;
  readonly event_type: string;
}

/** The values one orchestration.subscribeThread resume streamed before its catch-up marker. */
export interface ReplayResponse {
  readonly threadId: string;
  readonly afterSequence: number;
  readonly values: ReadonlyArray<unknown>;
  readonly synchronized: boolean;
}

export interface ReadbackObservation {
  readonly seededEvents: ReadonlyArray<SeededEvent>;
  readonly snapshots: ReadonlyArray<ReadbackResponse>;
  readonly replays: ReadonlyArray<ReplayResponse>;
}

export interface ReadbackItem {
  readonly kind: "thread" | "message" | "event";
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ReadbackResult {
  readonly passed: boolean;
  readonly threads: number;
  readonly messages: number;
  readonly events: number;
  readonly items: ReadonlyArray<ReadbackItem>;
}

const SnapshotBody = Schema.Struct({
  snapshotSequence: Schema.Number,
  projection: Schema.Struct({
    thread: Schema.Struct({ id: Schema.String, projectId: Schema.String, title: Schema.String }),
    messages: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        threadId: Schema.String,
        role: Schema.String,
        text: Schema.String,
      }),
    ),
  }),
});
const decodeSnapshotBody = Schema.decodeUnknownOption(SnapshotBody);

const ReplayedMessageEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  sequence: Schema.Number,
  event: Schema.Struct({
    id: Schema.String,
    threadId: Schema.String,
    type: Schema.Literal("message.updated"),
    payload: Schema.Struct({
      id: Schema.String,
      threadId: Schema.String,
      role: Schema.String,
      text: Schema.String,
    }),
  }),
});
const decodeReplayedMessageEvent = Schema.decodeUnknownOption(ReplayedMessageEvent);

const mismatches = (
  fields: ReadonlyArray<
    readonly [name: string, expected: string | number, actual: string | number]
  >,
): string =>
  fields
    .filter(([, expected, actual]) => expected !== actual)
    .map(([name, expected, actual]) => `${name} is '${actual}', expected '${expected}'`)
    .join("; ");

const item = (kind: ReadbackItem["kind"], id: string, problem: string): ReadbackItem => ({
  kind,
  id,
  passed: problem === "",
  detail: problem === "" ? "read back" : problem,
});

const compareSnapshot = (
  { thread, messages }: FixtureThread,
  response: ReadbackResponse | undefined,
): ReadonlyArray<ReadbackItem> => {
  const snapshot = response?.status === 200 ? decodeSnapshotBody(response.body) : Option.none();
  if (Option.isNone(snapshot)) {
    const detail = `thread missing: ${
      response === undefined
        ? "no response"
        : response.status !== 200
          ? `HTTP ${response.status}`
          : "the response is not a thread snapshot"
    }`;
    return [
      item("thread", thread.id, detail),
      ...messages.map((message) => item("message", message.id, detail)),
    ];
  }
  const projection = snapshot.value.projection;
  return [
    item(
      "thread",
      thread.id,
      mismatches([
        ["id", thread.id, projection.thread.id],
        ["projectId", thread.projectId, projection.thread.projectId],
        ["title", thread.title, projection.thread.title],
      ]),
    ),
    ...messages.map((message) => {
      const actual = projection.messages.find((candidate) => candidate.id === message.id);
      return item(
        "message",
        message.id,
        actual === undefined
          ? "message missing"
          : mismatches([
              ["threadId", message.threadId, actual.threadId],
              ["role", message.role, actual.role],
              ["text", message.text, actual.text],
            ]),
      );
    }),
  ];
};

const compareEventLog = (
  fixture: FixtureThread,
  observation: ReadbackObservation,
): ReadonlyArray<ReadbackItem> => {
  const threadId = fixture.thread.id;
  const seeded = observation.seededEvents.filter((event) => event.stream_id === threadId);
  const replay = observation.replays.find((candidate) => candidate.threadId === threadId);
  const created = seeded.find((event) => event.event_type === "thread.created");
  const replayed = (replay?.values ?? []).flatMap((value) =>
    Option.toArray(decodeReplayedMessageEvent(value)),
  );
  const items = fixtureEvents(fixture).map((expected) => {
    const row = seeded.find((event) => event.event_id === expected.eventId);
    if (row === undefined) return item("event", expected.eventId, "not in the seeded event log");
    const logged = mismatches([
      ["stream", threadId, row.stream_id],
      ["type", expected.type, row.event_type],
    ]);
    if (logged !== "" || expected.messageId === undefined) {
      return item("event", expected.eventId, logged);
    }
    const message = fixture.messages.find((candidate) => candidate.id === expected.messageId)!;
    const actual = replayed.find((value) => value.event.id === expected.eventId);
    return item(
      "event",
      expected.eventId,
      actual === undefined
        ? "the candidate did not replay it from the event log"
        : mismatches([
            ["sequence", row.sequence, actual.sequence],
            ["threadId", threadId, actual.event.threadId],
            ["message", message.id, actual.event.payload.id],
            ["role", message.role, actual.event.payload.role],
            ["text", message.text, actual.event.payload.text],
          ]),
    );
  });
  // The snapshot must cover the durable history, and the replay must have
  // resumed right after creation and finished its catch-up.
  const lastSeeded = Math.max(0, ...seeded.map((event) => event.sequence));
  const snapshot = observation.snapshots.find((candidate) => candidate.threadId === threadId);
  const snapshotSequence = Option.match(
    snapshot?.status === 200 ? decodeSnapshotBody(snapshot.body) : Option.none(),
    { onNone: () => undefined, onSome: (body) => body.snapshotSequence },
  );
  const coverage =
    snapshotSequence === undefined
      ? "no snapshot"
      : snapshotSequence < lastSeeded || seeded.length === 0
        ? `snapshotSequence ${snapshotSequence} is behind the seeded log's ${lastSeeded}`
        : replay === undefined
          ? "no replay"
          : !replay.synchronized
            ? "the replay did not finish its catch-up"
            : created !== undefined && replay.afterSequence !== created.sequence
              ? `the replay resumed after ${replay.afterSequence}, not ${created.sequence}`
              : "";
  return [...items, item("event", `${threadId}:history`, coverage)];
};

/**
 * Passes only when every fixture thread and message reads back from the
 * candidate's snapshot, and every seeded event is in the durable log and,
 * for messages, replayed by the candidate from it.
 */
export const compareReadback = (
  fixtures: ReadonlyArray<FixtureThread>,
  observation: ReadbackObservation,
): ReadbackResult => {
  const items = fixtures.flatMap((fixture) => [
    ...compareSnapshot(
      fixture,
      observation.snapshots.find((response) => response.threadId === fixture.thread.id),
    ),
    ...compareEventLog(fixture, observation),
  ]);
  return {
    passed: items.length > 0 && items.every((entry) => entry.passed),
    threads: fixtures.length,
    messages: fixtures.reduce((count, fixture) => count + fixture.messages.length, 0),
    events: fixtures.reduce((count, fixture) => count + fixtureEvents(fixture).length, 0),
    items,
  };
};

export class ReadbackError extends Schema.TaggedError<ReadbackError>()("ReadbackError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The candidate did not read the fixtures back: ${this.detail}`;
  }
}

// The snapshot route and /ws serve only clients that speak orchestration protocol 2.
const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
const ORCHESTRATION_PROTOCOL_VERSION = "2";
const SUBSCRIBE_THREAD_RPC = "orchestration.subscribeThread";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const encodeFrame = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSeededEvents = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        sequence: Schema.Number,
        event_id: Schema.String,
        stream_id: Schema.String,
        event_type: Schema.String,
      }),
    ),
  ),
);
const decodeTicket = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ ticket: Schema.String })),
);
// Effect RPC's JSON frames: the server's half of one streaming request.
const decodeRpcFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      requestId: Schema.optional(Schema.Unknown),
      values: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);
const isCatchUpMarker = Schema.is(Schema.Struct({ kind: Schema.Literal("synchronized") }));

const withBaseUrl = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return client.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)));
  });

/** Fetches every fixture thread's snapshot with a bearer token. */
export const fetchSnapshots = Effect.fn("fetchSnapshots")(function* (options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fixtures: ReadonlyArray<FixtureThread>;
}) {
  const client = yield* withBaseUrl(options.baseUrl);
  return yield* Effect.forEach(options.fixtures, ({ thread }) =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.get(`/api/orchestration/threads/${encodeURIComponent(thread.id)}`).pipe(
          HttpClientRequest.bearerToken(options.token),
          HttpClientRequest.setHeader(
            ORCHESTRATION_PROTOCOL_HEADER,
            ORCHESTRATION_PROTOCOL_VERSION,
          ),
        ),
      );
      const text = yield* response.text;
      return {
        threadId: thread.id,
        status: response.status,
        body: Option.getOrElse(decodeJson(text), () => text),
      } satisfies ReadbackResponse;
    }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(
        (cause) => new ReadbackError({ detail: `GET thread ${thread.id}: ${cause.message}` }),
      ),
    ),
  );
});

/**
 * Resumes one thread over /ws after `afterSequence`, the way a client that
 * already holds the snapshot does, and collects what the candidate replays
 * from its event log up to the catch-up marker.
 */
export const replayThread = Effect.fn("replayThread")(function* (options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly threadId: string;
  readonly afterSequence: number;
}) {
  const client = yield* withBaseUrl(options.baseUrl);
  const ticketResponse = yield* client.execute(
    HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
      HttpClientRequest.bearerToken(options.token),
    ),
  );
  const { ticket } = yield* decodeTicket(yield* ticketResponse.text);
  const url = new URL("/ws", options.baseUrl.replace(/^http/, "ws"));
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION);
  url.searchParams.set("wsTicket", ticket);

  const socket = yield* Socket.makeWebSocket(url.toString(), { openTimeout: Duration.seconds(10) });
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const send = (frame: unknown) => Effect.flatMap(encodeFrame(frame), writer.write);
  yield* send({
    _tag: "Request",
    id: "1",
    tag: SUBSCRIBE_THREAD_RPC,
    headers: [],
    payload: {
      threadId: options.threadId,
      afterSequence: options.afterSequence,
      requestCompletionMarker: true,
    },
  });
  const textDecoder = new TextDecoder();
  const values: Array<unknown> = [];
  while (true) {
    for (const raw of yield* reader.pull) {
      const frame = yield* decodeRpcFrame(typeof raw === "string" ? raw : textDecoder.decode(raw));
      if (frame._tag === "Ping") yield* send({ _tag: "Pong" });
      if (frame._tag === "Chunk") {
        yield* send({ _tag: "Ack", requestId: frame.requestId });
        for (const value of frame.values ?? []) {
          if (isCatchUpMarker(value)) {
            return { ...options, values, synchronized: true } satisfies ReplayResponse;
          }
          values.push(value);
        }
      }
      // A finished or failed stream before the marker: the replay is incomplete.
      if (frame._tag !== "Ping" && frame._tag !== "Pong" && frame._tag !== "Chunk") {
        values.push(frame);
        return { ...options, values, synchronized: false } satisfies ReplayResponse;
      }
    }
  }
}, Effect.scoped);

export const readback = Effect.fn("readback")(function* (options: {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly fixtures: string;
  readonly seededEvents: string;
  readonly out: string;
  readonly responsesOut: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const fixtures = yield* decodeFixtures(yield* fs.readFileString(options.fixtures));
  const token = (yield* fs.readFileString(options.tokenFile)).trim();
  if (token.length === 0) return yield* new ReadbackError({ detail: "the token file is empty." });
  // `sqlite3 -json` prints nothing at all for an empty result.
  const seededText = (yield* fs.readFileString(options.seededEvents)).trim();
  const seededEvents = seededText === "" ? [] : yield* decodeSeededEvents(seededText);

  const snapshots = yield* fetchSnapshots({ baseUrl: options.baseUrl, token, fixtures });
  const replays = yield* Effect.forEach(fixtures, ({ thread }) => {
    const created = seededEvents.find(
      (event) => event.stream_id === thread.id && event.event_type === "thread.created",
    );
    return created === undefined
      ? Effect.succeed([])
      : replayThread({
          baseUrl: options.baseUrl,
          token,
          threadId: thread.id,
          afterSequence: created.sequence,
        }).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.map((replay) => [replay]),
          Effect.mapError(
            (cause) => new ReadbackError({ detail: `replay ${thread.id}: ${cause.message}` }),
          ),
        );
  }).pipe(Effect.map((all) => all.flat()));

  const observation: ReadbackObservation = { seededEvents, snapshots, replays };
  if (Option.isSome(options.responsesOut)) {
    yield* fs.writeFileString(options.responsesOut.value, `${yield* encodeJson(observation)}\n`);
  }
  const result = compareReadback(fixtures, observation);
  yield* fs.writeFileString(options.out, `${yield* encodeJson(result)}\n`);
  if (!result.passed) {
    return yield* new ReadbackError({
      detail: result.items
        .filter((entry) => !entry.passed)
        .map((entry) => `${entry.kind} ${entry.id}: ${entry.detail}`)
        .join("\n"),
    });
  }
  yield* Effect.log(
    `Read back ${result.threads} threads, ${result.messages} messages, and ${result.events} events through the candidate.`,
  );
});

const command = Command.make(
  "linux-admission-readback",
  {
    baseUrl: Flag.String("base-url").pipe(
      Flag.withDescription("The candidate server, for example http://127.0.0.1:47811."),
    ),
    tokenFile: Flag.String("token-file").pipe(
      Flag.withDescription("File holding an orchestration:read bearer token."),
    ),
    fixtures: Flag.String("fixtures").pipe(Flag.withDescription("Path to fixtures.json.")),
    seededEvents: Flag.String("seeded-events").pipe(
      Flag.withDescription("`sqlite3 -json` rows of the event log as seeded, before the upgrade."),
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the comparison result.")),
    responsesOut: Flag.String("responses-out").pipe(
      Flag.withDescription("Where to write everything the comparison read."),
      Flag.optional,
    ),
  },
  (options) => readback(options),
).pipe(Command.withDescription("Read the admission fixtures back through a candidate server."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        Socket.layerWebSocketConstructorGlobal,
      ),
    ),
    NodeRuntime.runMain,
  );
}
