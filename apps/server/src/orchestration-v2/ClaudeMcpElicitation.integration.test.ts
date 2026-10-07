import type { OnElicitation, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const settings = Schema.decodeSync(ClaudeSettings)({});

it.effect.each([
  "accept",
  "decline",
  "cancel",
  "SDK abort",
  "SDK abort after response",
  "interrupt",
] as const)("persists a Claude MCP approval and clears it after %s", (resolution) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-mcp-elicitation");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const callback = yield* Deferred.make<OnElicitation>();
      const sdkAbort = new AbortController();
      const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed("elicitation-session"),
          open: ({ options }) =>
            Effect.gen(function* () {
              if (options.onElicitation === undefined) {
                return yield* Effect.die("Claude must install onElicitation in full access");
              }
              yield* Deferred.succeed(callback, options.onElicitation);
              return {
                messages: Stream.fromQueue(sdkMessages),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Queue.shutdown(sdkMessages),
              };
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:claude-mcp-elicitation");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
            Stream.map(({ event }) => event),
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:claude-mcp-elicitation"),
          title: "MCP approval",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start"),
          threadId,
          messageId: MessageId.make("start"),
          text: "Read the connected app.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const onElicitation = yield* Deferred.await(callback);
        const pending = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "approval_request" &&
            event.payload.status === "waiting",
        );
        const response = yield* Effect.promise(() =>
          onElicitation(
            {
              serverName: "connected-app",
              message: "Allow this app to access your files?",
              requestedSchema: { type: "object", properties: {} },
            },
            { requestId: "elicitation-1", signal: sdkAbort.signal },
          ),
        ).pipe(Effect.forkScoped);
        yield* Fiber.join(pending);
        const before = yield* orchestrator.getThreadProjection(threadId);
        const request = before.runtimeRequests[0]!;
        const item = before.turnItems.find((item) => item.type === "approval_request")!;
        assert.equal(request.kind, "mcp-elicitation");
        assert.equal(request.status, "pending");
        assert.equal(request.providerTurnId, before.providerTurns[0]?.id);
        assert.equal(item.runId, before.runs[0]?.id);
        assert.equal(item.type, "approval_request");
        if (item.type !== "approval_request") return yield* Effect.die("missing approval item");
        assert.equal(item.appName, "connected-app");
        assert.equal(item.prompt, "Allow this app to access your files?");
        assert.deepEqual(
          item.options?.map((option) => option.decision),
          ["accept", "decline", "cancel"],
        );

        const settled = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === item.id &&
            event.payload.status !== "waiting",
        );
        if (resolution === "SDK abort") {
          sdkAbort.abort();
        } else if (resolution === "interrupt") {
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("interrupt"),
            threadId,
            runId: before.runs[0]!.id,
          });
        } else {
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("respond"),
            threadId,
            requestId: request.id,
            decision: resolution === "SDK abort after response" ? "accept" : resolution,
          });
          if (resolution === "SDK abort after response") {
            const committed = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(committed.runtimeRequests[0]?.status, "resolved");
            assert.equal(committed.runtimeRequests[0]?.decision, "accept");
            const cancelled = yield* watch(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.id === item.id &&
                event.payload.status === "cancelled",
            );
            // The SDK abandons its callback before the committed response is delivered.
            sdkAbort.abort();
            yield* Fiber.join(response);
            yield* Fiber.join(cancelled);
          }
        }
        yield* worker.drain();
        const sdkResponse = yield* Fiber.join(response);
        const adapterCancelled =
          resolution === "SDK abort" ||
          resolution === "SDK abort after response" ||
          resolution === "interrupt";
        assert.equal(sdkResponse?.action, adapterCancelled ? "cancel" : resolution);
        yield* Fiber.join(settled);
        const after = yield* orchestrator.getThreadProjection(threadId);
        const resolved = after.runtimeRequests.find((candidate) => candidate.id === request.id)!;
        assert.equal(resolved.status, adapterCancelled ? "cancelled" : "resolved");
        assert.isNotNull(resolved.resolvedAt);
        assert.isEmpty(after.runtimeRequests.filter((candidate) => candidate.status === "pending"));
        assert.equal(
          after.nodes.find((node) => node.id === request.nodeId)?.status,
          resolution === "accept" ? "completed" : "cancelled",
        );
        assert.equal(
          after.turnItems.find((candidate) => candidate.id === item.id)?.status,
          resolution === "accept" ? "completed" : "cancelled",
        );
        if (resolution === "SDK abort" || resolution === "SDK abort after response") {
          assert.equal(after.providerTurns[0]?.status, "running");
          assert.equal(after.runs[0]?.status, "running");
        }
        const replay = yield* orchestrator
          .streamStoredEventsFrom({ threadId, afterSequence: 0 })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "runtime-request.updated" &&
                event.payload.id === request.id &&
                event.payload.status === resolved.status,
            ),
            Stream.take(1),
            Stream.runCollect,
          );
        assert.equal(replay.length, 1);
        const staleResponse = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("respond-from-second-device"),
            threadId,
            requestId: request.id,
            decision: "accept",
          })
          .pipe(Effect.flip);
        assert.equal(staleResponse._tag, "OrchestratorDispatchError");
        if (resolution === "SDK abort after response") {
          const finished = yield* watch(
            (event) => event.type === "run.updated" && event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, {
            type: "result",
            subtype: "success",
            uuid: "11111111-1111-4111-8111-111111111111",
            session_id: "elicitation-session",
            is_error: false,
            num_turns: 1,
            result: "The app request was cancelled.",
            stop_reason: "end_turn",
            permission_denials: [],
            duration_ms: 1,
            duration_api_ms: 1,
            total_cost_usd: 0,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              inference_geo: "not_available",
              iterations: [],
              server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
              service_tier: "standard",
              speed: "standard",
            },
            modelUsage: {},
          });
          yield* Fiber.join(finished);
          yield* worker.drain();
          const completed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(completed.runs[0]?.status, "completed");
          assert.equal(completed.providerTurns[0]?.status, "completed");
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-mcp-elicitation" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  ),
);
