#!/usr/bin/env node

// Fork-only (atlitech/t3code). Has the prior release's own server create each
// fixture thread: one `orchestration.dispatchCommand` `thread.create` per
// fixtures.json thread, over the same /ws RPC its clients use, so the
// thread.created event and projection row are what that release writes.
// It needs no provider: creating a thread starts no run.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { decodeFixtures, type FixtureThreadCommand, threadCommandId } from "./fixtures.ts";
import { callRpc, isSuccessExit } from "./ws-rpc.ts";

const DISPATCH_COMMAND_RPC = "orchestration.dispatchCommand";

/** The `thread.create` command for one fixture thread. */
export const threadCreateCommand = (thread: FixtureThreadCommand) => ({
  type: "thread.create" as const,
  commandId: threadCommandId(thread.id),
  threadId: thread.id,
  createdBy: thread.createdBy,
  creationSource: thread.creationSource,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
});

export class CreateThreadsError extends Schema.TaggedError<CreateThreadsError>()(
  "CreateThreadsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The prior server did not create the fixture threads: ${this.detail}`;
  }
}

const encodeExit = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const createThreads = Effect.fn("createThreads")(function* (options: {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly fixtures: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const fixtures = yield* decodeFixtures(yield* fs.readFileString(options.fixtures));
  const token = (yield* fs.readFileString(options.tokenFile)).trim();
  for (const { thread } of fixtures) {
    const outcome = yield* callRpc({
      baseUrl: options.baseUrl,
      token,
      tag: DISPATCH_COMMAND_RPC,
      payload: threadCreateCommand(thread),
    });
    if (!isSuccessExit(outcome.exit)) {
      return yield* new CreateThreadsError({
        detail: `thread.create ${thread.id} answered ${yield* encodeExit(outcome.exit)}`,
      });
    }
  }
  yield* Effect.log(`The prior server created ${fixtures.length} fixture threads.`);
});

const command = Command.make(
  "linux-admission-create-threads",
  {
    baseUrl: Flag.String("base-url").pipe(
      Flag.withDescription("The prior server, for example http://127.0.0.1:47811."),
    ),
    tokenFile: Flag.String("token-file").pipe(
      Flag.withDescription("File holding a bearer token that may operate orchestration."),
    ),
    fixtures: Flag.String("fixtures").pipe(Flag.withDescription("Path to fixtures.json.")),
  },
  (options) => createThreads(options),
).pipe(Command.withDescription("Create the fixture threads through a running server."));

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
