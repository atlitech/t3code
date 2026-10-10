#!/usr/bin/env node

// Fork-only (atlitech/t3code). The work the recovery drill does after the
// upgrade: the upgraded server creates one thread through its own
// thread.create, over the same /ws RPC its clients use. Recovery moves the
// database holding it aside, so the restored home must not have it and the
// displaced database must.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { threadCreateCommand } from "../linux-admission/create-threads.ts";
import { decodeFixtures, type FixtureThread } from "../linux-admission/fixtures.ts";
import { callRpc, isSuccessExit } from "../linux-admission/ws-rpc.ts";

/** The thread only the upgraded server writes. */
export const POST_UPGRADE_THREAD_ID = "recovery-drill-post-upgrade";

/** A fixture thread's `thread.create`, under the drill's own thread and command id. */
export const postUpgradeThreadCommand = (template: FixtureThread) => ({
  ...threadCreateCommand(template.thread),
  commandId: `recovery-drill:thread.create:${POST_UPGRADE_THREAD_ID}`,
  threadId: POST_UPGRADE_THREAD_ID,
  title: "Written after the upgrade",
});

export class PostUpgradeThreadError extends Schema.TaggedError<PostUpgradeThreadError>()(
  "PostUpgradeThreadError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The upgraded server did not create the post-upgrade thread: ${this.detail}`;
  }
}

const encodeExit = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const writePostUpgradeThread = Effect.fn("writePostUpgradeThread")(function* (options: {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly fixtures: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const [template] = yield* decodeFixtures(yield* fs.readFileString(options.fixtures));
  if (template === undefined) {
    return yield* new PostUpgradeThreadError({ detail: "fixtures.json lists no thread." });
  }
  const token = (yield* fs.readFileString(options.tokenFile)).trim();
  const outcome = yield* callRpc({
    baseUrl: options.baseUrl,
    token,
    tag: "orchestration.dispatchCommand",
    payload: postUpgradeThreadCommand(template),
  });
  if (!isSuccessExit(outcome.exit)) {
    return yield* new PostUpgradeThreadError({
      detail: `thread.create answered ${yield* encodeExit(outcome.exit)}`,
    });
  }
  yield* Effect.log(`The upgraded server created ${POST_UPGRADE_THREAD_ID}.`);
});

const command = Command.make(
  "linux-recovery-post-upgrade-thread",
  {
    baseUrl: Flag.String("base-url").pipe(
      Flag.withDescription("The upgraded server, for example http://127.0.0.1:47811."),
    ),
    tokenFile: Flag.String("token-file").pipe(
      Flag.withDescription("File holding a bearer token that may operate orchestration."),
    ),
    fixtures: Flag.String("fixtures").pipe(
      Flag.withDescription("Path to fixtures.json; its first thread is the template."),
    ),
  },
  (options) => writePostUpgradeThread(options),
).pipe(Command.withDescription("Create the drill's post-upgrade thread through a running server."));

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
