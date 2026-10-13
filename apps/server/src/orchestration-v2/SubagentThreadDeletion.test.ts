import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Threads here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// The worker runs only when a test drains it, so each cascade step is observable.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "subagent-thread-deletion" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const now = DateTime.makeUnsafe("2026-10-13T09:00:00.000Z");

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:subagent-thread-deletion"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Records a subagent under `parentThreadId` with its own child thread, as an adapter does. */
const addSubagentThread = (input: {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly origin: "provider_native" | "app_owned";
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const { thread: parentThread } = yield* orchestrator.getThreadRecords(input.parentThreadId, []);
    const subagentId = NodeId.make(`subagent:${input.childThreadId}`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`child-created:${input.childThreadId}`),
          type: "thread.created",
          threadId: input.childThreadId,
          occurredAt: now,
          payload: makeSubagentChildThread({
            parentThread,
            childThreadId: input.childThreadId,
            parentNodeId: subagentId,
            activeProviderThreadId: null,
            providerInstanceId: instanceId,
            modelSelection,
            title: input.childThreadId,
            now,
            createdBy: "agent",
            creationSource: input.origin === "provider_native" ? "provider" : "mcp",
          }),
        },
        {
          id: EventId.make(`subagent:${input.childThreadId}`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          nodeId: subagentId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: subagentId,
            threadId: input.parentThreadId,
            runId: null,
            parentNodeId: subagentId,
            origin: input.origin,
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: input.childThreadId,
            nativeTaskRef: null,
            prompt: "Review the plan",
            title: null,
            model: null,
            status: "completed",
            result: "done",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

const isDeleted = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    return thread.deletedAt !== null;
  });

it.effect("deleting a thread deletes its provider subagent threads, depth first", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const parent = ThreadId.make("thread:cascade-parent");
    const child = ThreadId.make("thread:cascade-child");
    const grandchild = ThreadId.make("thread:cascade-grandchild");
    const delegated = ThreadId.make("thread:cascade-delegated");
    yield* createThread(parent);
    yield* addSubagentThread({
      parentThreadId: parent,
      childThreadId: child,
      origin: "provider_native",
    });
    yield* addSubagentThread({
      parentThreadId: child,
      childThreadId: grandchild,
      origin: "provider_native",
    });
    yield* addSubagentThread({
      parentThreadId: parent,
      childThreadId: delegated,
      origin: "app_owned",
    });

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:cascade-parent"),
      threadId: parent,
    });
    yield* worker.drain();

    assert.isTrue(yield* isDeleted(parent));
    assert.isTrue(yield* isDeleted(child));
    assert.isTrue(yield* isDeleted(grandchild));
    // A delegate_task child is a thread the user can still open and continue.
    assert.isFalse(yield* isDeleted(delegated));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the sweep deletes only provider subagent threads whose parent is deleted", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const deletedParent = ThreadId.make("thread:sweep-deleted-parent");
    const liveParent = ThreadId.make("thread:sweep-live-parent");
    const orphan = ThreadId.make("thread:sweep-orphan");
    const orphanChild = ThreadId.make("thread:sweep-orphan-child");
    const delegated = ThreadId.make("thread:sweep-delegated");
    const kept = ThreadId.make("thread:sweep-kept");
    yield* createThread(deletedParent);
    yield* createThread(liveParent);
    yield* addSubagentThread({
      parentThreadId: deletedParent,
      childThreadId: orphan,
      origin: "provider_native",
    });
    yield* addSubagentThread({
      parentThreadId: orphan,
      childThreadId: orphanChild,
      origin: "provider_native",
    });
    yield* addSubagentThread({
      parentThreadId: deletedParent,
      childThreadId: delegated,
      origin: "app_owned",
    });
    yield* addSubagentThread({
      parentThreadId: liveParent,
      childThreadId: kept,
      origin: "provider_native",
    });
    // A deletion from before subagent threads followed their parent: no cascade queued.
    const { thread } = yield* orchestrator.getThreadRecords(deletedParent, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make("legacy-delete:sweep-deleted-parent"),
          type: "thread.deleted",
          threadId: deletedParent,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...thread, deletedAt: now, titleRegeneration: null, updatedAt: now },
        },
      ],
    });

    assert.equal(yield* threads.deleteOrphanedSubagentThreads, 1);
    yield* worker.drain();

    assert.isTrue(yield* isDeleted(orphan));
    assert.isTrue(yield* isDeleted(orphanChild));
    assert.isFalse(yield* isDeleted(delegated));
    assert.isFalse(yield* isDeleted(kept));
    assert.equal(yield* threads.deleteOrphanedSubagentThreads, 0);
  }).pipe(Effect.provide(layerTest)),
);
