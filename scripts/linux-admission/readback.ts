#!/usr/bin/env node

// Fork-only (atlitech/t3code). Reads every fixture thread back through a
// running server and compares it with fixtures.json and with the event log
// as the prior release left it. run-admission.sh runs it three times:
//
// - `created`: the prior, right after its own thread.create: every fixture
//   thread, with its configuration, through its thread snapshot API.
// - `seeded`: the prior again, after the messages were seeded: the threads
//   and every message, so the prior has read the full upgrade input.
// - `upgraded`: the candidate, on the same home: the snapshots again, plus
//   the event log. The candidate decodes every seeded event: the shell
//   resume (`orchestration.subscribeShell` from sequence 0) reads and decodes
//   each thread.created from the log, and the thread resume
//   (`orchestration.subscribeThread` after the creation) replays each
//   message.updated with its sequence and content.

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

import { decodeFixtures, expectedThread, type FixtureThread, threadCommandId } from "./fixtures.ts";
import { messageEvents } from "./seed.ts";
import { callRpc } from "./ws-rpc.ts";

export type ReadbackStage = "created" | "seeded" | "upgraded";

/** One GET /api/orchestration/threads/:threadId, as the server answered it. */
export interface ReadbackResponse {
  readonly threadId: string;
  readonly status: number;
  readonly body: unknown;
}

/** One thread event row, as `sqlite3 -json` read it from the log the prior left. */
export interface SeededEvent {
  readonly sequence: number;
  readonly event_id: string;
  readonly stream_id: string;
  readonly event_type: string;
  readonly command_id: string | null;
  readonly payload_json: string;
}

/** The values one resume streamed before its catch-up marker. */
export interface ReplayResponse {
  readonly afterSequence: number;
  readonly values: ReadonlyArray<unknown>;
  readonly synchronized: boolean;
}

export interface ThreadReplayResponse extends ReplayResponse {
  readonly threadId: string;
}

export interface ReadbackObservation {
  readonly seededEvents: ReadonlyArray<SeededEvent>;
  readonly snapshots: ReadonlyArray<ReadbackResponse>;
  readonly threadReplays: ReadonlyArray<ThreadReplayResponse>;
  readonly shellReplay: ReplayResponse | null;
}

export interface ReadbackItem {
  readonly kind: "thread" | "message" | "event";
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ReadbackResult {
  readonly stage: ReadbackStage;
  readonly passed: boolean;
  readonly threads: number;
  readonly messages: number;
  readonly events: number;
  readonly items: ReadonlyArray<ReadbackItem>;
}

const Fields = Schema.Record(Schema.String, Schema.Unknown);
const SnapshotBody = Schema.Struct({
  snapshotSequence: Schema.Number,
  projection: Schema.Struct({ thread: Fields, messages: Schema.Array(Fields) }),
});
const decodeSnapshotBody = Schema.decodeUnknownOption(SnapshotBody);
const ReplayedEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  sequence: Schema.Number,
  event: Schema.Struct({ id: Schema.String, threadId: Schema.String, payload: Fields }),
});
const decodeReplayedEvent = Schema.decodeUnknownOption(ReplayedEvent);
const AnyReplayedEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  sequence: Schema.Number,
  event: Schema.Struct({ type: Schema.String }),
});
const decodeAnyReplayedEvent = Schema.decodeUnknownOption(AnyReplayedEvent);
const ShellThreadUpdated = Schema.Struct({
  kind: Schema.Literal("thread.updated"),
  thread: Fields,
});
const decodeShellThreadUpdated = Schema.decodeUnknownOption(ShellThreadUpdated);
const decodePayloadJson = Schema.decodeUnknownOption(Schema.fromJsonString(Fields));
const showJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Structural equality over JSON values. */
export const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) =>
      sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
};

/** Every field of `expected` that `actual` does not carry with the same value. */
const fieldMismatches = (
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): string =>
  Object.entries(expected)
    .filter(([key, value]) => !(key in actual) || !sameJson(value, actual[key]))
    .map(([key, value]) =>
      key in actual
        ? `${key} is ${showJson(actual[key])}, expected ${showJson(value)}`
        : `${key} is missing, expected ${showJson(value)}`,
    )
    .join("; ");

const item = (kind: ReadbackItem["kind"], id: string, problem: string): ReadbackItem => ({
  kind,
  id,
  passed: problem === "",
  detail: problem === "" ? "read back" : problem,
});

/** The thread.created row the prior wrote for a fixture thread, by its command id. */
const createdEventOf = (observation: ReadbackObservation, threadId: string) =>
  observation.seededEvents.find(
    (event) =>
      event.stream_id === threadId &&
      event.event_type === "thread.created" &&
      event.command_id === threadCommandId(threadId),
  );

/** The fixture's thread, with the creation time the prior's own event recorded. */
const expectedThreadAsCreated = (
  fixture: FixtureThread,
  observation: ReadbackObservation,
): Readonly<Record<string, unknown>> | string => {
  const created = createdEventOf(observation, fixture.thread.id);
  if (created === undefined) return "the prior's log has no thread.created for it";
  const payload = decodePayloadJson(created.payload_json);
  if (Option.isNone(payload)) return "the prior's thread.created payload is unreadable";
  return { ...expectedThread(fixture.thread), createdAt: payload.value.createdAt };
};

const snapshotBodyOf = (response: ReadbackResponse | undefined) =>
  response?.status === 200 ? decodeSnapshotBody(response.body) : Option.none();

const compareSnapshot = (
  fixture: FixtureThread,
  observation: ReadbackObservation,
  stage: ReadbackStage,
): ReadonlyArray<ReadbackItem> => {
  const { thread, messages } = fixture;
  const expectedMessages = stage === "created" ? [] : messages;
  const response = observation.snapshots.find((candidate) => candidate.threadId === thread.id);
  const snapshot = snapshotBodyOf(response);
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
      ...expectedMessages.map((message) => item("message", message.id, detail)),
    ];
  }
  const projection = snapshot.value.projection;
  const expected = expectedThreadAsCreated(fixture, observation);
  return [
    item(
      "thread",
      thread.id,
      typeof expected === "string" ? expected : fieldMismatches(expected, projection.thread),
    ),
    ...expectedMessages.map((message) => {
      const actual = projection.messages.find((candidate) => candidate.id === message.id);
      return item(
        "message",
        message.id,
        actual === undefined ? "message missing" : fieldMismatches(message.fields, actual),
      );
    }),
  ];
};

const compareEventLog = (
  fixture: FixtureThread,
  observation: ReadbackObservation,
): ReadonlyArray<ReadbackItem> => {
  const threadId = fixture.thread.id;
  const logged = observation.seededEvents.filter((event) => event.stream_id === threadId);
  const created = createdEventOf(observation, threadId);

  // thread.created: the candidate decoded it on the shell resume, and the
  // shell it then served still carries the thread as the prior created it.
  const shell = observation.shellReplay;
  const shellThread = (shell?.values ?? [])
    .flatMap((value) => Option.toArray(decodeShellThreadUpdated(value)))
    .findLast((value) => value.thread.id === threadId)?.thread;
  const expected = expectedThreadAsCreated(fixture, observation);
  const createdItem = item(
    "event",
    `${threadId}:thread.created`,
    typeof expected === "string"
      ? expected
      : shell === null || !shell.synchronized
        ? "the candidate did not finish decoding the event log on the shell resume"
        : shellThread === undefined
          ? "the candidate's shell resume did not return the thread"
          : // A shell (OrchestrationV2ThreadShell) has no deletedAt: deleted threads leave it.
            fieldMismatches(
              Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "deletedAt")),
              shellThread,
            ),
  );

  // message.updated: replayed from the log with its sequence and content.
  const replay = observation.threadReplays.find((candidate) => candidate.threadId === threadId);
  const replayed = (replay?.values ?? []).flatMap((value) =>
    Option.toArray(decodeReplayedEvent(value)),
  );
  const messageItems = messageEvents(fixture).map((expectedEvent) => {
    const row = logged.find((event) => event.event_id === expectedEvent.eventId);
    if (row === undefined || row.event_type !== "message.updated") {
      return item("event", expectedEvent.eventId, "not a message.updated in the seeded event log");
    }
    const actual = replayed.find((value) => value.event.id === expectedEvent.eventId);
    if (actual === undefined) {
      return item(
        "event",
        expectedEvent.eventId,
        "the candidate did not replay it from the event log",
      );
    }
    return item(
      "event",
      expectedEvent.eventId,
      [
        actual.sequence === row.sequence
          ? ""
          : `sequence is ${actual.sequence}, expected ${row.sequence}`,
        actual.event.threadId === threadId ? "" : `threadId is '${actual.event.threadId}'`,
        fieldMismatches(expectedEvent.message.fields, actual.event.payload),
      ]
        .filter((problem) => problem !== "")
        .join("; "),
    );
  });

  // The snapshot must cover the logged history, and the replay must have
  // resumed right after creation and finished its catch-up.
  const lastLogged = Math.max(0, ...logged.map((event) => event.sequence));
  const snapshotSequence = Option.getOrUndefined(
    Option.map(
      snapshotBodyOf(observation.snapshots.find((response) => response.threadId === threadId)),
      (body) => body.snapshotSequence,
    ),
  );
  const coverage =
    snapshotSequence === undefined
      ? "no snapshot"
      : logged.length === 0 || snapshotSequence < lastLogged
        ? `snapshotSequence ${snapshotSequence} is behind the logged history's ${lastLogged}`
        : replay === undefined
          ? "no replay"
          : !replay.synchronized
            ? "the replay did not finish its catch-up"
            : created !== undefined && replay.afterSequence !== created.sequence
              ? `the replay resumed after ${replay.afterSequence}, not ${created.sequence}`
              : "";
  return [
    createdItem,
    ...messageItems,
    item("event", `${threadId}:history`, coverage),
    replayCompleteness(threadId, logged, created, replay),
  ];
};

/**
 * The candidate's thread resume must replay exactly the events the prior's
 * log holds after the thread's creation (the seeded messages and whatever the
 * prior appended itself, such as thread.settled), each with its type, and
 * nothing else up to the log's last sequence. Events past it are the
 * candidate's own writes since the upgrade: allowed, and reported.
 */
export const replayCompleteness = (
  threadId: string,
  logged: ReadonlyArray<SeededEvent>,
  created: SeededEvent | undefined,
  replay: ThreadReplayResponse | undefined,
): ReadbackItem => {
  const id = `${threadId}:replay`;
  if (created === undefined) return item("event", id, "no thread.created to resume after");
  if (replay === undefined) return item("event", id, "no replay");
  const lastLogged = Math.max(created.sequence, ...logged.map((event) => event.sequence));
  const expected = new Map(
    logged
      .filter((event) => event.sequence > created.sequence)
      .map((event) => [event.sequence, event.event_type] as const),
  );
  const replayed = replay.values.flatMap((value) => Option.toArray(decodeAnyReplayedEvent(value)));
  const actual = new Map(
    replayed
      .filter((value) => value.sequence <= lastLogged)
      .map((value) => [value.sequence, value.event.type] as const),
  );
  const appended = replayed.filter((value) => value.sequence > lastLogged);
  const problems = [
    ...[...expected]
      .filter(([sequence, type]) => actual.get(sequence) !== type)
      .map(([sequence, type]) =>
        actual.has(sequence)
          ? `${sequence} replayed as ${actual.get(sequence)}, logged as ${type}`
          : `${sequence} (${type}) not replayed`,
      ),
    ...[...actual]
      .filter(([sequence]) => !expected.has(sequence))
      .map(([sequence, type]) => `${sequence} (${type}) replayed but not in the prior's log`),
  ];
  const detail =
    problems.length > 0
      ? problems.join("; ")
      : `replayed all ${expected.size} logged events after creation${
          appended.length > 0
            ? `; the candidate appended ${appended
                .map((value) => `${value.sequence} (${value.event.type})`)
                .join(", ")}`
            : ""
        }`;
  return { kind: "event", id, passed: problems.length === 0, detail };
};

/**
 * Passes only when every fixture thread, with its configuration, and every
 * expected message read back from the server's snapshots; at `upgraded`,
 * also when the candidate decoded every seeded event from the durable log.
 */
export const compareReadback = (
  fixtures: ReadonlyArray<FixtureThread>,
  observation: ReadbackObservation,
  stage: ReadbackStage,
): ReadbackResult => {
  const items = fixtures.flatMap((fixture) => [
    ...compareSnapshot(fixture, observation, stage),
    ...(stage === "upgraded" ? compareEventLog(fixture, observation) : []),
  ]);
  return {
    stage,
    passed: items.length > 0 && items.every((entry) => entry.passed),
    threads: fixtures.length,
    messages:
      stage === "created"
        ? 0
        : fixtures.reduce((count, fixture) => count + fixture.messages.length, 0),
    events:
      stage === "upgraded"
        ? fixtures.reduce((count, fixture) => count + 1 + fixture.messages.length, 0)
        : 0,
    items,
  };
};

export class ReadbackError extends Schema.TaggedError<ReadbackError>()("ReadbackError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The server did not read the fixtures back: ${this.detail}`;
  }
}

// The snapshot route serves only clients that speak orchestration protocol 2.
const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
const ORCHESTRATION_PROTOCOL_VERSION = "2";
const SUBSCRIBE_THREAD_RPC = "orchestration.subscribeThread";
const SUBSCRIBE_SHELL_RPC = "orchestration.subscribeShell";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const decodeSeededEvents = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        sequence: Schema.Number,
        event_id: Schema.String,
        stream_id: Schema.String,
        event_type: Schema.String,
        command_id: Schema.NullOr(Schema.String),
        payload_json: Schema.String,
      }),
    ),
  ),
);
const isCatchUpMarker = Schema.is(Schema.Struct({ kind: Schema.Literal("synchronized") }));

/** Fetches every fixture thread's snapshot with a bearer token. */
export const fetchSnapshots = Effect.fn("fetchSnapshots")(function* (options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fixtures: ReadonlyArray<FixtureThread>;
}) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
  );
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
 * Resumes a subscription after `afterSequence` and keeps what the server
 * streamed up to its catch-up marker. Only these named fields are returned:
 * the request's token never leaves this function.
 */
const resume = Effect.fn("resume")(function* (options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly tag: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly afterSequence: number;
}) {
  const outcome = yield* callRpc({
    baseUrl: options.baseUrl,
    token: options.token,
    tag: options.tag,
    payload: {
      ...options.payload,
      afterSequence: options.afterSequence,
      requestCompletionMarker: true,
    },
    until: isCatchUpMarker,
  });
  const replay: ReplayResponse = {
    afterSequence: options.afterSequence,
    values: outcome.exit === undefined ? outcome.values : [...outcome.values, outcome.exit],
    synchronized: outcome.exit === undefined,
  };
  return replay;
});

export const readback = Effect.fn("readback")(function* (options: {
  readonly stage: ReadbackStage;
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
  const upgraded = options.stage === "upgraded";
  const threadReplays: Array<ThreadReplayResponse> = [];
  let shellReplay: ReplayResponse | null = null;
  if (upgraded) {
    for (const { thread } of fixtures) {
      const created = seededEvents.find(
        (event) => event.stream_id === thread.id && event.command_id === threadCommandId(thread.id),
      );
      if (created === undefined) continue;
      const replay = yield* resume({
        baseUrl: options.baseUrl,
        token,
        tag: SUBSCRIBE_THREAD_RPC,
        payload: { threadId: thread.id },
        afterSequence: created.sequence,
      });
      threadReplays.push({
        threadId: thread.id,
        afterSequence: replay.afterSequence,
        values: replay.values,
        synchronized: replay.synchronized,
      });
    }
    shellReplay = yield* resume({
      baseUrl: options.baseUrl,
      token,
      tag: SUBSCRIBE_SHELL_RPC,
      payload: {},
      afterSequence: 0,
    });
  }

  const observation: ReadbackObservation = { seededEvents, snapshots, threadReplays, shellReplay };
  if (Option.isSome(options.responsesOut)) {
    yield* fs.writeFileString(options.responsesOut.value, `${yield* encodeJson(observation)}\n`);
  }
  const result = compareReadback(fixtures, observation, options.stage);
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
    `[${options.stage}] Read back ${result.threads} threads, ${result.messages} messages, and ${result.events} events.`,
  );
});

const command = Command.make(
  "linux-admission-readback",
  {
    stage: Flag.Literals("stage", ["created", "seeded", "upgraded"]).pipe(
      Flag.withDescription("What the server should hold: see the header of readback.ts."),
    ),
    baseUrl: Flag.String("base-url").pipe(
      Flag.withDescription("The server, for example http://127.0.0.1:47811."),
    ),
    tokenFile: Flag.String("token-file").pipe(
      Flag.withDescription("File holding an orchestration:read bearer token."),
    ),
    fixtures: Flag.String("fixtures").pipe(Flag.withDescription("Path to fixtures.json.")),
    seededEvents: Flag.String("seeded-events").pipe(
      Flag.withDescription("`sqlite3 -json` rows of the thread event log the prior left."),
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the comparison result.")),
    responsesOut: Flag.String("responses-out").pipe(
      Flag.withDescription("Where to write everything the comparison read."),
      Flag.optional,
    ),
  },
  (options) => readback(options),
).pipe(Command.withDescription("Read the admission fixtures back through a server."));

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
