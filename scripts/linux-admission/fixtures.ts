// Fork-only (atlitech/t3code). Decodes fixtures.json, the one list that drives
// the Linux admission: each thread is the `thread.create` command the prior
// release's own server runs (create-threads.ts), each message is seeded after
// it (seed.ts), and readback.ts expects both back through the candidate.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty());

/** The `thread.create` command fields, minus the command id. */
const ThreadFields = Schema.Struct({
  createdBy: Text,
  creationSource: Text,
  id: Text,
  projectId: Text,
  title: Text,
  modelSelection: Schema.Struct({ instanceId: Text, model: Text }),
  runtimeMode: Text,
  interactionMode: Text,
  branch: Schema.NullOr(Text),
  worktreePath: Schema.NullOr(Text),
});

const MessageFields = Schema.Struct({
  createdBy: Text,
  creationSource: Text,
  id: Text,
  threadId: Text,
  runId: Schema.NullOr(Text),
  nodeId: Schema.NullOr(Text),
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  attachments: Schema.Array(Schema.Unknown),
  streaming: Schema.Boolean,
  createdAt: Text,
  updatedAt: Text,
});

export type FixtureThreadCommand = typeof ThreadFields.Type;

/** A message, with the exact payload the server stores as payload_json. */
export type FixtureMessage = typeof MessageFields.Type & {
  /** Every field the fixture sets, as written in fixtures.json. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly payloadJson: string;
};

export interface FixtureThread {
  readonly thread: FixtureThreadCommand;
  readonly messages: ReadonlyArray<FixtureMessage>;
}

/** The command id the prior's thread.create runs under; its event carries it. */
export const threadCommandId = (threadId: string) => `admission:thread.create:${threadId}`;

/**
 * The thread every server derives from the fixture's `thread.create`
 * (Orchestrator dispatchThreadCreate): the command's fields plus the ones a
 * new thread always starts with. createdAt and updatedAt are the prior
 * server's clock, so they come from the event it wrote, not from here.
 */
export const expectedThread = (
  thread: FixtureThreadCommand,
): Readonly<Record<string, unknown>> => ({
  createdBy: thread.createdBy,
  creationSource: thread.creationSource,
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  providerInstanceId: thread.modelSelection.instanceId,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
  forkedFrom: null,
  archivedAt: null,
  deletedAt: null,
});

const FixtureFile = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        thread: Schema.Unknown,
        messages: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      }),
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
      const thread = yield* decodeThreadFields(entry.thread);
      if (seen.has(thread.id)) {
        return yield* new FixtureError({ detail: `duplicate id '${thread.id}'.` });
      }
      seen.add(thread.id);
      const messages: Array<FixtureMessage> = [];
      for (const raw of entry.messages) {
        const message = {
          ...(yield* decodeMessageFields(raw)),
          fields: raw,
          payloadJson: yield* encodePayload(raw),
        };
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
