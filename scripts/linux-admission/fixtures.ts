// Fork-only (atlitech/t3code). Decodes fixtures.json, the one list of threads
// and messages the Linux admission seeds into the prior release's database
// (seed.ts) and expects to read back through the candidate (readback.ts).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty());

const ThreadFields = Schema.Struct({
  id: Text,
  projectId: Text,
  title: Text,
  providerInstanceId: Text,
  runtimeMode: Text,
  interactionMode: Text,
  activeProviderThreadId: Schema.NullOr(Text),
  createdAt: Text,
  updatedAt: Text,
  archivedAt: Schema.NullOr(Text),
  deletedAt: Schema.NullOr(Text),
});

const MessageFields = Schema.Struct({
  id: Text,
  threadId: Text,
  runId: Schema.NullOr(Text),
  nodeId: Schema.NullOr(Text),
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  streaming: Schema.Boolean,
  createdAt: Text,
  updatedAt: Text,
});

/** A thread row, with the exact payload the server stores as payload_json. */
export type FixtureThreadRow = typeof ThreadFields.Type & { readonly payloadJson: string };

/** A message row, with the exact payload the server stores as payload_json. */
export type FixtureMessageRow = typeof MessageFields.Type & { readonly payloadJson: string };

export interface FixtureThread {
  readonly thread: FixtureThreadRow;
  readonly messages: ReadonlyArray<FixtureMessageRow>;
}

const FixtureFile = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({ thread: Schema.Unknown, messages: Schema.Array(Schema.Unknown) }),
    ),
  }),
);

export class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Unreadable admission fixtures: ${this.detail}`;
  }
}

const decodeFixtureFile = Schema.decodeEffect(FixtureFile);
const decodeThreadFields = Schema.decodeUnknownEffect(ThreadFields);
const decodeMessageFields = Schema.decodeUnknownEffect(MessageFields);
const encodePayload = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const withPayload = <A>(fields: A, raw: unknown) =>
  encodePayload(raw).pipe(Effect.map((payloadJson) => ({ ...fields, payloadJson })));

/** Decodes fixtures.json, refusing duplicate ids and messages filed under another thread. */
export const decodeFixtures = (text: string) =>
  Effect.gen(function* () {
    const file = yield* decodeFixtureFile(text);
    if (file.threads.length === 0) {
      return yield* new FixtureError({ detail: "there are no threads." });
    }
    const seen = new Set<string>();
    const threads: Array<FixtureThread> = [];
    for (const entry of file.threads) {
      const thread = yield* withPayload(yield* decodeThreadFields(entry.thread), entry.thread);
      if (seen.has(thread.id)) {
        return yield* new FixtureError({ detail: `duplicate id '${thread.id}'.` });
      }
      seen.add(thread.id);
      const messages: Array<FixtureMessageRow> = [];
      for (const raw of entry.messages) {
        const message = yield* withPayload(yield* decodeMessageFields(raw), raw);
        if (message.threadId !== thread.id) {
          return yield* new FixtureError({
            detail: `message '${message.id}' names thread '${message.threadId}', not '${thread.id}'.`,
          });
        }
        if (seen.has(message.id)) {
          return yield* new FixtureError({ detail: `duplicate id '${message.id}'.` });
        }
        seen.add(message.id);
        messages.push(message);
      }
      threads.push({ thread, messages });
    }
    return threads as ReadonlyArray<FixtureThread>;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "FixtureError" ? cause : new FixtureError({ detail: cause.message }),
    ),
  );
