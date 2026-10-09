#!/usr/bin/env node

// Fork-only (atlitech/t3code). Reads every fixture thread back through a
// running candidate's thread snapshot API and compares it with fixtures.json:
// the upgrade check of the Linux admission (run-admission.sh).

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

import { decodeFixtures, type FixtureThread } from "./fixtures.ts";

/** One GET /api/orchestration/threads/:threadId, as the candidate answered it. */
export interface ReadbackResponse {
  readonly threadId: string;
  readonly status: number;
  readonly body: unknown;
}

export interface ReadbackItem {
  readonly kind: "thread" | "message";
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ReadbackResult {
  readonly passed: boolean;
  readonly threads: number;
  readonly messages: number;
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

const mismatches = (
  fields: ReadonlyArray<readonly [name: string, expected: string, actual: string]>,
): string =>
  fields
    .filter(([, expected, actual]) => expected !== actual)
    .map(([name, expected, actual]) => `${name} is '${actual}', expected '${expected}'`)
    .join("; ");

/**
 * Passes only when every fixture thread answered 200 with its id, project and
 * title, and every fixture message is in that thread's snapshot with its role
 * and text.
 */
export const compareReadback = (
  fixtures: ReadonlyArray<FixtureThread>,
  responses: ReadonlyArray<ReadbackResponse>,
): ReadbackResult => {
  const items: Array<ReadbackItem> = [];
  for (const { thread, messages } of fixtures) {
    const response = responses.find((candidate) => candidate.threadId === thread.id);
    const snapshot = response?.status === 200 ? decodeSnapshotBody(response.body) : Option.none();
    const missing =
      response === undefined
        ? "no response"
        : response.status !== 200
          ? `HTTP ${response.status}`
          : Option.isNone(snapshot)
            ? "the response is not a thread snapshot"
            : undefined;
    if (missing !== undefined || Option.isNone(snapshot)) {
      const detail = `thread missing: ${missing ?? "no snapshot"}`;
      items.push({ kind: "thread", id: thread.id, passed: false, detail });
      for (const message of messages) {
        items.push({ kind: "message", id: message.id, passed: false, detail });
      }
      continue;
    }
    const projection = snapshot.value.projection;
    const threadMismatch = mismatches([
      ["id", thread.id, projection.thread.id],
      ["projectId", thread.projectId, projection.thread.projectId],
      ["title", thread.title, projection.thread.title],
    ]);
    items.push({
      kind: "thread",
      id: thread.id,
      passed: threadMismatch === "",
      detail: threadMismatch === "" ? "read back" : threadMismatch,
    });
    for (const message of messages) {
      const actual = projection.messages.find((candidate) => candidate.id === message.id);
      const messageMismatch =
        actual === undefined
          ? "message missing"
          : mismatches([
              ["threadId", message.threadId, actual.threadId],
              ["role", message.role, actual.role],
              ["text", message.text, actual.text],
            ]);
      items.push({
        kind: "message",
        id: message.id,
        passed: messageMismatch === "",
        detail: messageMismatch === "" ? "read back" : messageMismatch,
      });
    }
  }
  return {
    passed: items.length > 0 && items.every((item) => item.passed),
    threads: fixtures.length,
    messages: fixtures.reduce((count, fixture) => count + fixture.messages.length, 0),
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

// The snapshot route serves only clients that speak orchestration protocol 2.
const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
const ORCHESTRATION_PROTOCOL_VERSION = "2";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

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

export const readback = Effect.fn("readback")(function* (options: {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly fixtures: string;
  readonly out: string;
  readonly responsesOut: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const fixtures = yield* decodeFixtures(yield* fs.readFileString(options.fixtures));
  const token = (yield* fs.readFileString(options.tokenFile)).trim();
  if (token.length === 0) return yield* new ReadbackError({ detail: "the token file is empty." });
  const responses = yield* fetchSnapshots({ baseUrl: options.baseUrl, token, fixtures });
  if (Option.isSome(options.responsesOut)) {
    yield* fs.writeFileString(options.responsesOut.value, `${yield* encodeJson(responses)}\n`);
  }
  const result = compareReadback(fixtures, responses);
  yield* fs.writeFileString(options.out, `${yield* encodeJson(result)}\n`);
  const failed = result.items.filter((item) => !item.passed);
  if (!result.passed) {
    return yield* new ReadbackError({
      detail: failed.map((item) => `${item.kind} ${item.id}: ${item.detail}`).join("\n"),
    });
  }
  yield* Effect.log(
    `Read back ${result.threads} threads and ${result.messages} messages through the candidate.`,
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
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the comparison result.")),
    responsesOut: Flag.String("responses-out").pipe(
      Flag.withDescription("Where to write the raw snapshot responses."),
      Flag.optional,
    ),
  },
  (options) => readback(options),
).pipe(Command.withDescription("Read the admission fixtures back through a candidate server."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
