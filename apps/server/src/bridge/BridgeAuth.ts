// @effect-diagnostics nodeBuiltinImport:off -- Canonical namespace workspace paths use the same native path semantics as the lease.
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BridgeIsolationUnavailable } from "./BridgePolicy.ts";
import { loadAdmittedBridgeProfile } from "./BridgeTopology.ts";
import * as BridgeRuntime from "./BridgeRuntime.ts";

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

/** Offline operator provisioning uses exactly the server's admission and runtime boundary. */
export const provision = Effect.fn("BridgeAuth.provision")(function* (input: {
  readonly purpose: "device-login" | "login-status" | "logout";
  readonly threadId: string;
  readonly workspace: string;
}) {
  const threadId = yield* decodeThreadId(input.threadId).pipe(
    Effect.mapError(
      (cause) => new BridgeIsolationUnavailable({ reason: "unsupported-runtime-settings", cause }),
    ),
  );
  if (
    !NodePath.isAbsolute(input.workspace) ||
    NodePath.normalize(input.workspace) !== input.workspace ||
    input.workspace.includes("\0")
  )
    return yield* new BridgeIsolationUnavailable({ reason: "unsupported-workspace" });
  const profile = yield* loadAdmittedBridgeProfile;
  // Refuse invalid layouts before constructor readiness can launch even a trusted probe.
  const preflight = yield* Effect.tryPromise({
    try: () =>
      BridgeRuntime.acquireWorkspaceLease(profile.workspaceRoot, input.workspace, new Set()),
    catch: (cause) => new BridgeIsolationUnavailable({ reason: "unsupported-workspace", cause }),
  });
  preflight.release();
  const context = yield* Layer.build(BridgeRuntime.layer(profile));
  const runtime = Context.get(context, BridgeRuntime.BridgeRuntime);
  const child = yield* runtime.open({
    threadId,
    workspace: input.workspace,
    sessionId: `bridge-auth:${input.purpose}:${threadId}`,
    purpose: input.purpose,
  });
  const [, , exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Console.log(line)),
      ),
      child.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Console.error(line)),
      ),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return exitCode;
});
